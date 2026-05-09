import fs from 'node:fs';
import path from 'node:path';
import { getPaths, loadConfig } from './project.js';
import { isTokenGuardCommand } from './installer.js';

const REQUIRED_HOOKS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd', 'PreCompact'];
const REQUIRED_GITIGNORE_ENTRIES = ['TokenGuard/', '.token-guard/', 'CLAUDE.local.md', '.claude/settings.local.json'];

export function runDoctor(projectRoot = process.cwd()) {
  const paths = getPaths(projectRoot);
  const checks = [];
  const add = (id, label, status, detail = '', fix = '') => checks.push({ id, label, status, detail, fix });

  const baseExists = fs.existsSync(paths.base);
  const legacyExists = fs.existsSync(paths.legacyBase);
  const legacyPythonExists = fs.existsSync(paths.legacyPythonMvp);

  add('visible-local-folder', 'Visible local TokenGuard/ folder', baseExists ? 'pass' : 'fail', baseExists ? `Found ${relative(projectRoot, paths.base)}/` : 'TokenGuard/ was not found.', 'Run `token-guard install` inside the project root.');
  add('mixed-version-dirs', 'Mixed old/new local folders', legacyExists ? 'warn' : 'pass', legacyExists ? 'Legacy .token-guard/ folder detected.' : 'No legacy .token-guard/ folder detected.', 'Run `token-guard uninstall`, then reinstall with `token-guard install`.');
  add('legacy-python-mvp', 'Legacy Python MVP file', legacyPythonExists ? 'warn' : 'pass', legacyPythonExists ? 'Legacy token_guard.py detected.' : 'No legacy token_guard.py detected.', 'Run `token-guard uninstall`, then reinstall with `token-guard install`.');

  let config = null;
  if (fs.existsSync(paths.config)) {
    try { config = loadConfig(projectRoot); add('config', 'Config file', 'pass', `Found ${relative(projectRoot, paths.config)}`); }
    catch (err) { add('config', 'Config file', 'fail', `Config exists but could not be parsed: ${err.message}`, 'Delete/fix TokenGuard/config.json, then run `token-guard install`.'); }
  } else add('config', 'Config file', 'fail', 'TokenGuard/config.json was not found.', 'Run `token-guard install`.');

  if (config) {
    add('enabled', 'Enabled flag', config.enabled === true ? 'pass' : 'warn', config.enabled === true ? 'Token Guard is enabled.' : 'Token Guard is currently disabled.', 'Run `token-guard enable`.');
    add('safe-mode', 'Safe default mode', config.mode === 'observe' ? 'pass' : 'warn', config.mode === 'observe' ? 'Mode is observe/safe. Read calls are not blocked.' : `Mode is ${config.mode}.`, 'Run `token-guard mode observe` to return to safe behavior.');
    add('thresholds', 'v0.3 thresholds', Number(config.thresholds?.softTokens) === 25000 && Number(config.thresholds?.hardTokens) === 60000 && Number(config.thresholds?.narrowReadMaxLines) === 200 ? 'pass' : 'warn', `soft=${config.thresholds?.softTokens}, hard=${config.thresholds?.hardTokens}, narrowReadMaxLines=${config.thresholds?.narrowReadMaxLines}`, 'Recommended defaults: soft=25000, hard=60000, narrowReadMaxLines=200.');
    const allow = config.patterns?.alwaysAllow || [];
    const missing = ['TokenGuard/', '.token-guard/', 'TokenGuard/summaries/', '.token-guard/summaries/', 'CLAUDE.local.md', 'AGENTS.md'].filter(item => !allow.includes(item));
    add('self-allowlist', 'Self-file allowlist', missing.length === 0 ? 'pass' : 'fail', missing.length === 0 ? 'Token Guard self files and summaries are allowlisted.' : `Missing allowlist entries: ${missing.join(', ')}`, 'Reinstall or restore default patterns.alwaysAllow.');
    add('signal-mode', 'Balanced Signal Mode', config.signal?.enabled !== false ? 'pass' : 'warn', config.signal?.enabled !== false ? `Enabled (${config.signal?.level || 'balanced'}).` : 'Disabled.', 'Set config.signal.enabled=true.');
    add('long-input-digest', 'Long Input Digest', config.longInput?.enabled !== false ? 'pass' : 'warn', config.longInput?.enabled !== false ? `Enabled at ${config.longInput?.minChars || 4000}+ chars.` : 'Disabled.', 'Set config.longInput.enabled=true.');
  }

  checkClaudeSettings(projectRoot, paths, add);
  checkAgents(projectRoot, paths, add);
  checkGitignore(projectRoot, paths, add);
  add('local-first', 'Local-first posture', 'pass', 'No daemon, no cloud backend, no API key, no upload path is required by Token Guard.');

  const failed = checks.filter(c => c.status === 'fail').length;
  const warned = checks.filter(c => c.status === 'warn').length;
  const passed = checks.filter(c => c.status === 'pass').length;
  return { ok: failed === 0, passed, warned, failed, checks };
}

export function formatDoctor(result) {
  const lines = ['Token Guard doctor', ''];
  for (const check of result.checks) {
    const icon = check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : 'x';
    lines.push(`${icon} ${check.label}`);
    if (check.detail) lines.push(`  ${check.detail}`);
    if (check.status !== 'pass' && check.fix) lines.push(`  Fix: ${check.fix}`);
    lines.push('');
  }
  lines.push(`Summary: ${result.passed} passed, ${result.warned} warning(s), ${result.failed} failed.`);
  lines.push(result.ok ? 'Token Guard installation looks usable.' : 'Token Guard installation needs attention.');
  return lines.join('\n');
}

function checkClaudeSettings(projectRoot, paths, add) {
  if (!fs.existsSync(paths.claudeSettingsLocal)) {
    add('claude-settings', 'Claude Code local settings', 'warn', '.claude/settings.local.json was not found. This is fine if installed with --no-claude.', 'Run `token-guard install`.');
    return;
  }
  let settings;
  try { settings = JSON.parse(fs.readFileSync(paths.claudeSettingsLocal, 'utf8')); }
  catch (err) { add('claude-settings', 'Claude Code local settings', 'fail', `.claude/settings.local.json could not be parsed: ${err.message}`, 'Fix JSON or reinstall Token Guard.'); return; }
  add('claude-settings', 'Claude Code local settings', 'pass', `Found ${relative(projectRoot, paths.claudeSettingsLocal)}`);
  const hooks = settings.hooks || {};
  const missing = REQUIRED_HOOKS.filter(name => !Object.keys(hooks).includes(name));
  add('claude-hooks', 'Claude Code hooks', missing.length === 0 ? 'pass' : 'warn', missing.length === 0 ? `Found hooks: ${REQUIRED_HOOKS.join(', ')}` : `Missing hooks: ${missing.join(', ')}`, 'Run `token-guard install`.');
  const commands = collectHookCommands(hooks);
  const current = commands.filter(c => c.includes('token-guard hook'));
  const old = commands.filter(c => isTokenGuardCommand(c) && !c.includes('token-guard hook'));
  add('claude-hook-commands', 'Token Guard hook commands', current.length >= 5 ? 'pass' : 'warn', current.length ? `Found ${current.length} current token-guard hook command(s).` : 'No current token-guard hook commands found.', 'Run `token-guard install`.');
  add('legacy-hook-commands', 'Legacy Token Guard hook commands', old.length === 0 ? 'pass' : 'warn', old.length ? `Found legacy hook command(s): ${old.join(' | ')}` : 'No legacy Token Guard hook commands detected.', 'Run `token-guard uninstall`, then reinstall.');
}

function checkAgents(projectRoot, paths, add) {
  if (!fs.existsSync(paths.agents)) { add('agents-md', 'Codex AGENTS.md rules', 'warn', 'AGENTS.md was not found. This is fine if installed with --no-codex.', 'Run `token-guard install`.'); return; }
  const content = fs.readFileSync(paths.agents, 'utf8');
  add('agents-md', 'Codex AGENTS.md rules', content.includes('TOKEN_GUARD_START') ? 'pass' : 'warn', content.includes('TOKEN_GUARD_START') ? 'Token Guard Codex instruction block found.' : 'AGENTS.md exists, but Token Guard block was not found.', 'Run `token-guard install`.');
}

function checkGitignore(projectRoot, paths, add) {
  if (!fs.existsSync(paths.gitignore)) { add('gitignore', '.gitignore protection', 'warn', '.gitignore was not found.', 'Run `token-guard install`.'); return; }
  const lines = fs.readFileSync(paths.gitignore, 'utf8').split(/\r?\n/).map(line => line.trim());
  const missing = REQUIRED_GITIGNORE_ENTRIES.filter(entry => !lines.includes(entry));
  add('gitignore', '.gitignore protection', missing.length === 0 ? 'pass' : 'warn', missing.length === 0 ? 'Local Token Guard files are ignored by git.' : `Missing .gitignore entries: ${missing.join(', ')}`, 'Run `token-guard install` or add missing entries manually.');
}

function collectHookCommands(hooks) { const commands = []; for (const groups of Object.values(hooks || {})) { if (!Array.isArray(groups)) continue; for (const group of groups) for (const hook of group.hooks || []) if (hook.command) commands.push(String(hook.command)); } return commands; }
function relative(projectRoot, target) { return path.relative(projectRoot, target).split(path.sep).join('/'); }
