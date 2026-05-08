import fs from 'node:fs';
import path from 'node:path';
import { getPaths, loadConfig } from './project.js';

const REQUIRED_HOOKS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
  'PreCompact'
];

const REQUIRED_GITIGNORE_ENTRIES = [
  'TokenGuard/',
  'CLAUDE.local.md',
  '.claude/settings.local.json'
];

export function runDoctor(projectRoot = process.cwd()) {
  const paths = getPaths(projectRoot);
  const checks = [];

  const add = (id, label, status, detail = '', fix = '') => {
    checks.push({
      id,
      label,
      status,
      detail,
      fix
    });
  };

  const baseExists = fs.existsSync(paths.base);
  const configExists = fs.existsSync(paths.config);

  add(
    'visible-local-folder',
    'Visible local TokenGuard/ folder',
    baseExists ? 'pass' : 'fail',
    baseExists
      ? `Found ${relative(projectRoot, paths.base)}/`
      : 'TokenGuard/ was not found.',
    'Run `token-guard install --observe` inside the project root.'
  );

  let config = null;

  if (configExists) {
    try {
      config = loadConfig(projectRoot);

      add(
        'config',
        'Config file',
        'pass',
        `Found ${relative(projectRoot, paths.config)}`
      );
    } catch (err) {
      add(
        'config',
        'Config file',
        'fail',
        `Config exists but could not be parsed: ${err.message}`,
        'Delete or fix TokenGuard/config.json, then run `token-guard install --observe` again.'
      );
    }
  } else {
    add(
      'config',
      'Config file',
      'fail',
      'TokenGuard/config.json was not found.',
      'Run `token-guard install --observe`.'
    );
  }

  if (config) {
    add(
      'enabled',
      'Enabled flag',
      config.enabled === true ? 'pass' : 'warn',
      config.enabled === true
        ? 'Token Guard is enabled.'
        : 'Token Guard is currently disabled.',
      'Run `token-guard enable` if you want hooks to do work.'
    );

    add(
      'default-observe',
      'Mode safety',
      config.mode === 'observe' ? 'pass' : 'warn',
      config.mode === 'observe'
        ? 'Mode is observe. Token Guard will not block reads by default.'
        : `Mode is ${config.mode}. This is intentional only if you explicitly want stronger guarding.`,
      'Run `token-guard mode observe` to return to the recommended default.'
    );

    add(
      'thresholds',
      'v0.2 thresholds',
      Number(config.thresholds?.softTokens) === 25000 &&
        Number(config.thresholds?.hardTokens) === 60000
        ? 'pass'
        : 'warn',
      `soft=${config.thresholds?.softTokens}, hard=${config.thresholds?.hardTokens}`,
      'Recommended v0.2 defaults are soft=25000 and hard=60000.'
    );

    const allow = config.patterns?.alwaysAllow || [];
    const requiredAllow = [
      'TokenGuard/',
      '.token-guard/',
      'TokenGuard/sessions/',
      'TokenGuard/memory/',
      'TokenGuard/summaries/',
      'TokenGuard/reports/',
      'CLAUDE.local.md',
      'AGENTS.md'
    ];

    const missingAllow = requiredAllow.filter(item => !allow.includes(item));

    add(
      'self-allowlist',
      'Self-file allowlist',
      missingAllow.length === 0 ? 'pass' : 'fail',
      missingAllow.length === 0
        ? 'Token Guard self files are allowlisted.'
        : `Missing allowlist entries: ${missingAllow.join(', ')}`,
      'Reinstall or restore the default patterns.alwaysAllow entries in TokenGuard/config.json.'
    );
  }

  checkClaudeSettings(projectRoot, paths, add);
  checkAgents(projectRoot, paths, add);
  checkGitignore(projectRoot, paths, add);

  add(
    'local-first',
    'Local-first posture',
    'pass',
    'No daemon, no cloud backend, no API key, no upload path is required by Token Guard v0.2.'
  );

  const failed = checks.filter(check => check.status === 'fail').length;
  const warned = checks.filter(check => check.status === 'warn').length;
  const passed = checks.filter(check => check.status === 'pass').length;

  return {
    ok: failed === 0,
    passed,
    warned,
    failed,
    checks
  };
}

export function formatDoctor(result) {
  const lines = [];

  lines.push('Token Guard doctor');
  lines.push('');

  for (const check of result.checks) {
    const icon =
      check.status === 'pass'
        ? '✓'
        : check.status === 'warn'
          ? '!'
          : 'x';

    lines.push(`${icon} ${check.label}`);

    if (check.detail) {
      lines.push(`  ${check.detail}`);
    }

    if (check.status !== 'pass' && check.fix) {
      lines.push(`  Fix: ${check.fix}`);
    }

    lines.push('');
  }

  lines.push(
    `Summary: ${result.passed} passed, ${result.warned} warning(s), ${result.failed} failed.`
  );

  if (result.ok) {
    lines.push('Token Guard installation looks usable.');
  } else {
    lines.push('Token Guard installation needs attention.');
  }

  return lines.join('\n');
}

function checkClaudeSettings(projectRoot, paths, add) {
  if (!fs.existsSync(paths.claudeSettingsLocal)) {
    add(
      'claude-settings',
      'Claude Code local settings',
      'warn',
      '.claude/settings.local.json was not found. This is fine if you installed with --no-claude.',
      'Run `token-guard install --observe` without --no-claude to install Claude hooks.'
    );

    return;
  }

  let settings = null;

  try {
    settings = JSON.parse(fs.readFileSync(paths.claudeSettingsLocal, 'utf8'));
  } catch (err) {
    add(
      'claude-settings',
      'Claude Code local settings',
      'fail',
      `.claude/settings.local.json could not be parsed: ${err.message}`,
      'Fix the JSON file or reinstall Token Guard.'
    );

    return;
  }

  add(
    'claude-settings',
    'Claude Code local settings',
    'pass',
    `Found ${relative(projectRoot, paths.claudeSettingsLocal)}`
  );

  const hooks = settings.hooks || {};
  const hookNames = Object.keys(hooks);

  const missing = REQUIRED_HOOKS.filter(name => !hookNames.includes(name));

  add(
    'claude-hooks',
    'Claude Code hooks',
    missing.length === 0 ? 'pass' : 'warn',
    missing.length === 0
      ? `Found hooks: ${REQUIRED_HOOKS.join(', ')}`
      : `Missing hooks: ${missing.join(', ')}`,
    'Run `token-guard install --observe` to rewrite hook entries.'
  );

  const commands = collectHookCommands(hooks);
  const tokenGuardCommands = commands.filter(command =>
    command.includes('token-guard hook')
  );

  add(
    'claude-hook-commands',
    'Token Guard hook commands',
    tokenGuardCommands.length >= 5 ? 'pass' : 'warn',
    tokenGuardCommands.length
      ? `Found ${tokenGuardCommands.length} token-guard hook command(s).`
      : 'No token-guard hook commands found.',
    'Run `token-guard install --observe`.'
  );
}

function checkAgents(projectRoot, paths, add) {
  if (!fs.existsSync(paths.agents)) {
    add(
      'agents-md',
      'Codex AGENTS.md rules',
      'warn',
      'AGENTS.md was not found. This is fine if you installed with --no-codex.',
      'Run `token-guard install --observe` without --no-codex to add Codex instructions.'
    );

    return;
  }

  const content = fs.readFileSync(paths.agents, 'utf8');

  add(
    'agents-md',
    'Codex AGENTS.md rules',
    content.includes('TOKEN_GUARD_START') ? 'pass' : 'warn',
    content.includes('TOKEN_GUARD_START')
      ? 'Token Guard Codex instruction block found.'
      : 'AGENTS.md exists, but Token Guard block was not found.',
    'Run `token-guard install --observe` to insert/update the Token Guard block.'
  );
}

function checkGitignore(projectRoot, paths, add) {
  if (!fs.existsSync(paths.gitignore)) {
    add(
      'gitignore',
      '.gitignore protection',
      'warn',
      '.gitignore was not found.',
      'Run `token-guard install --observe` to add local Token Guard paths to .gitignore.'
    );

    return;
  }

  const lines = fs
    .readFileSync(paths.gitignore, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim());

  const missing = REQUIRED_GITIGNORE_ENTRIES.filter(entry => !lines.includes(entry));

  add(
    'gitignore',
    '.gitignore protection',
    missing.length === 0 ? 'pass' : 'warn',
    missing.length === 0
      ? 'Local Token Guard files are ignored by git.'
      : `Missing .gitignore entries: ${missing.join(', ')}`,
    'Run `token-guard install --observe` or add the missing entries manually.'
  );
}

function collectHookCommands(hooks) {
  const commands = [];

  for (const groups of Object.values(hooks || {})) {
    if (!Array.isArray(groups)) continue;

    for (const group of groups) {
      for (const hook of group.hooks || []) {
        if (hook.command) {
          commands.push(String(hook.command));
        }
      }
    }
  }

  return commands;
}

function relative(projectRoot, target) {
  return path.relative(projectRoot, target).split(path.sep).join('/');
}
