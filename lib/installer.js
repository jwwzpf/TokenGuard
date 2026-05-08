import fs from 'node:fs';
import {
  ensureDir,
  ensureProjectFiles,
  getPaths,
  loadConfig,
  saveConfig,
  updateGitignore
} from './project.js';

const TG_START = '<!-- TOKEN_GUARD_START -->';
const TG_END = '<!-- TOKEN_GUARD_END -->';

export function install(projectRoot = process.cwd(), options = {}) {
  const paths = ensureProjectFiles(projectRoot);

  let config = loadConfig(projectRoot);

  config.enabled = true;
  config.mode = normalizeMode(options.mode || config.mode || 'observe');

  config = saveConfig(projectRoot, config);

  updateGitignore(projectRoot);

  if (options.claude !== false) {
    installClaudeHooks(projectRoot);
  }

  if (options.codex !== false) {
    installCodexInstructions(projectRoot);
  }

  writeClaudeLocal(paths);

  return {
    paths,
    config
  };
}

export function uninstall(projectRoot = process.cwd()) {
  const paths = ensureProjectFiles(projectRoot);

  uninstallClaudeHooks(projectRoot);
  removeMarkedSection(paths.agents);
  removeMarkedSection(paths.claudeLocal);

  const config = saveConfig(projectRoot, {
    ...loadConfig(projectRoot),
    enabled: false
  });

  return {
    paths,
    config
  };
}

export function setEnabled(projectRoot = process.cwd(), enabled) {
  ensureProjectFiles(projectRoot);

  const config = loadConfig(projectRoot);

  config.enabled = Boolean(enabled);

  return saveConfig(projectRoot, config);
}

export function setMode(projectRoot = process.cwd(), mode) {
  ensureProjectFiles(projectRoot);

  const config = loadConfig(projectRoot);

  config.mode = normalizeMode(mode);
  config.state = {
    ...(config.state || {}),
    lastReminderHash: null,
    lastReminderAt: null
  };

  return saveConfig(projectRoot, config);
}

export function allowOnce(projectRoot = process.cwd(), file = '*') {
  ensureProjectFiles(projectRoot);

  const config = loadConfig(projectRoot);
  const once = new Set(config.forceRead?.once || []);

  once.add(file || '*');

  config.forceRead = {
    ...(config.forceRead || {}),
    once: [...once]
  };

  return saveConfig(projectRoot, config);
}

function normalizeMode(mode) {
  const allowed = new Set(['observe', 'active', 'edit', 'strict']);

  if (!allowed.has(mode)) {
    throw new Error(`Invalid mode: ${mode}. Use observe, active, edit, or strict.`);
  }

  return mode;
}

function installClaudeHooks(projectRoot) {
  const paths = getPaths(projectRoot);

  ensureDir(paths.claudeDir);

  const existing = readJson(paths.claudeSettingsLocal, {});
  const hooks = existing.hooks || {};

  for (const eventName of Object.keys(hooks)) {
    hooks[eventName] = stripTokenGuardHooks(hooks[eventName]);
  }

  const command = 'token-guard hook';

  hooks.SessionStart = appendHook(hooks.SessionStart, null, `${command} SessionStart`);
  hooks.UserPromptSubmit = appendHook(hooks.UserPromptSubmit, null, `${command} UserPromptSubmit`);
  hooks.PreToolUse = appendHook(hooks.PreToolUse, 'Read|Bash', `${command} PreToolUse`);
  hooks.PostToolUse = appendHook(hooks.PostToolUse, 'Bash', `${command} PostToolUse`);
  hooks.Stop = appendHook(hooks.Stop, null, `${command} Stop`);
  hooks.SessionEnd = appendHook(hooks.SessionEnd, null, `${command} SessionEnd`);
  hooks.PreCompact = appendHook(hooks.PreCompact, null, `${command} PreCompact`);

  const next = {
    ...existing,
    hooks
  };

  fs.writeFileSync(paths.claudeSettingsLocal, `${JSON.stringify(next, null, 2)}\n`);
}

function uninstallClaudeHooks(projectRoot) {
  const paths = getPaths(projectRoot);

  if (!fs.existsSync(paths.claudeSettingsLocal)) return;

  const existing = readJson(paths.claudeSettingsLocal, {});
  const hooks = existing.hooks || {};

  for (const eventName of Object.keys(hooks)) {
    hooks[eventName] = stripTokenGuardHooks(hooks[eventName]);

    if (Array.isArray(hooks[eventName]) && hooks[eventName].length === 0) {
      delete hooks[eventName];
    }
  }

  fs.writeFileSync(
    paths.claudeSettingsLocal,
    `${JSON.stringify({ ...existing, hooks }, null, 2)}\n`
  );
}

function appendHook(eventHooks = [], matcher, command) {
  const group = {
    hooks: [
      {
        type: 'command',
        command
      }
    ]
  };

  if (matcher) {
    group.matcher = matcher;
  }

  return [...(Array.isArray(eventHooks) ? eventHooks : []), group];
}

function stripTokenGuardHooks(eventHooks = []) {
  if (!Array.isArray(eventHooks)) return [];

  return eventHooks
    .map(group => ({
      ...group,
      hooks: (group.hooks || []).filter(
        hook => !String(hook.command || '').includes('token-guard hook')
      )
    }))
    .filter(group => (group.hooks || []).length > 0);
}

function installCodexInstructions(projectRoot) {
  const paths = getPaths(projectRoot);

  const section = `${TG_START}
# Token Guard local context budget rules

- Token Guard runs locally and stores data in \`TokenGuard/\`. Do not upload code or reports.
- Prefer targeted reads, grep/ripgrep, and small file sections over full-repo or huge-file reads.
- Avoid reading generated, build, dependency, coverage, lock, and long log files unless the user explicitly asks.
- To override one guarded full read, ask the user to run \`token-guard allow <file> --once\` or include \`@tg:force-read <file>\` in the next prompt.
- Keep \`TokenGuard/memory/core.md\` and \`TokenGuard/sessions/handoff.md\` concise and useful for fresh sessions.
${TG_END}
`;

  upsertMarkedSection(paths.agents, section);
}

function writeClaudeLocal(paths) {
  const section = `${TG_START}
# Token Guard

Token Guard is installed for this local project.

Use:
- \`TokenGuard/memory/core.md\` for durable project facts.
- \`TokenGuard/sessions/handoff.md\` for next-session handoff.

Prefer targeted context over broad full-file reads.
${TG_END}
`;

  upsertMarkedSection(paths.claudeLocal, section);
}

function upsertMarkedSection(file, section) {
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  const re = new RegExp(
    `${escapeRegex(TG_START)}[\\s\\S]*?${escapeRegex(TG_END)}\\n?`,
    'm'
  );

  if (re.test(content)) {
    content = content.replace(re, section);
  } else {
    content = `${content}${content && !content.endsWith('\n') ? '\n' : ''}${section}`;
  }

  fs.writeFileSync(file, content);
}

function removeMarkedSection(file) {
  if (!fs.existsSync(file)) return;

  const content = fs.readFileSync(file, 'utf8');

  const re = new RegExp(
    `${escapeRegex(TG_START)}[\\s\\S]*?${escapeRegex(TG_END)}\\n?`,
    'm'
  );

  fs.writeFileSync(file, content.replace(re, ''));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
