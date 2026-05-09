import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, ensureProjectFiles, getPaths, loadConfig, saveConfig, updateGitignore, rel } from './project.js';

const TG_START = '<!-- TOKEN_GUARD_START -->';
const TG_END = '<!-- TOKEN_GUARD_END -->';
const GITIGNORE_ENTRIES = ['TokenGuard/', '.token-guard/', 'CLAUDE.local.md', '.claude/settings.local.json'];

export function install(projectRoot = process.cwd(), options = {}) {
  const paths = ensureProjectFiles(projectRoot);
  let config = loadConfig(projectRoot);
  config.enabled = true;
  config.mode = normalizeMode(options.mode || config.mode || 'observe');
  config = saveConfig(projectRoot, config);
  updateGitignore(projectRoot);
  if (options.claude !== false) installClaudeHooks(projectRoot);
  if (options.codex !== false) installCodexInstructions(projectRoot);
  writeClaudeLocal(paths);
  return { paths, config };
}

export function uninstall(projectRoot = process.cwd(), options = {}) {
  const paths = getPaths(projectRoot);
  const removed = [];
  uninstallClaudeHooks(projectRoot, removed);
  removeMarkedSectionOrFile(paths.agents, removed);
  removeMarkedSectionOrFile(paths.claudeLocal, removed);
  cleanGitignore(paths.gitignore, removed);

  if (!options.keepData) {
    removePath(paths.base, removed);
    removePath(paths.legacyBase, removed);
    removePath(paths.legacyPythonMvp, removed);
  } else {
    try {
      const config = saveConfig(projectRoot, { ...loadConfig(projectRoot), enabled: false });
      removed.push('disabled TokenGuard/config.json');
      return { paths, config, removed };
    } catch {}
  }

  cleanupEmptyDir(paths.claudeDir, removed);
  return { paths, config: null, removed };
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
  config.state = { ...(config.state || {}), lastReminderHash: null, lastReminderAt: null };
  return saveConfig(projectRoot, config);
}

export function allowOnce(projectRoot = process.cwd(), file = '*') {
  ensureProjectFiles(projectRoot);
  const config = loadConfig(projectRoot);
  const once = new Set(config.forceRead?.once || []);
  for (const variant of forceReadVariants(projectRoot, file)) once.add(variant);
  config.forceRead = { ...(config.forceRead || {}), once: [...once] };
  return saveConfig(projectRoot, config);
}

export function forceReadVariants(projectRoot, file = '*') {
  const raw = String(file || '*').trim();
  if (!raw || raw === '*') return ['*'];
  const variants = new Set();
  variants.add(raw);
  variants.add(raw.replace(/^\.\//, ''));
  const absolute = path.isAbsolute(raw) ? raw : path.join(projectRoot, raw);
  variants.add(absolute);
  variants.add(rel(projectRoot, absolute));
  variants.add(path.basename(raw));
  return [...variants].filter(Boolean);
}

function normalizeMode(mode) {
  const allowed = new Set(['observe', 'auto', 'active', 'edit', 'strict']);
  if (!allowed.has(mode)) throw new Error(`Invalid mode: ${mode}. Use observe, auto, active, edit, or strict.`);
  return mode;
}

function installClaudeHooks(projectRoot) {
  const paths = getPaths(projectRoot);
  ensureDir(paths.claudeDir);
  const existing = readJson(paths.claudeSettingsLocal, {});
  const hooks = existing.hooks || {};
  for (const eventName of Object.keys(hooks)) hooks[eventName] = stripTokenGuardHooks(hooks[eventName]);
  const command = 'token-guard hook';
  hooks.SessionStart = appendHook(hooks.SessionStart, null, `${command} SessionStart`);
  hooks.UserPromptSubmit = appendHook(hooks.UserPromptSubmit, null, `${command} UserPromptSubmit`);
  hooks.PreToolUse = appendHook(hooks.PreToolUse, 'Read|Bash', `${command} PreToolUse`);
  hooks.PostToolUse = appendHook(hooks.PostToolUse, 'Bash', `${command} PostToolUse`);
  hooks.Stop = appendHook(hooks.Stop, null, `${command} Stop`);
  hooks.SessionEnd = appendHook(hooks.SessionEnd, null, `${command} SessionEnd`);
  hooks.PreCompact = appendHook(hooks.PreCompact, null, `${command} PreCompact`);
  fs.writeFileSync(paths.claudeSettingsLocal, `${JSON.stringify({ ...existing, hooks }, null, 2)}\n`);
}

function uninstallClaudeHooks(projectRoot, removed = []) {
  const paths = getPaths(projectRoot);
  if (!fs.existsSync(paths.claudeSettingsLocal)) return;
  const existing = readJson(paths.claudeSettingsLocal, {});
  const hooks = existing.hooks || {};
  let changed = false;
  for (const eventName of Object.keys(hooks)) {
    const before = JSON.stringify(hooks[eventName]);
    hooks[eventName] = stripTokenGuardHooks(hooks[eventName]);
    if (before !== JSON.stringify(hooks[eventName])) changed = true;
    if (Array.isArray(hooks[eventName]) && hooks[eventName].length === 0) { delete hooks[eventName]; changed = true; }
  }
  const next = { ...existing, hooks };
  if (Object.keys(next.hooks || {}).length === 0) delete next.hooks;
  if (isEmptyObject(next)) {
    fs.rmSync(paths.claudeSettingsLocal, { force: true });
    removed.push('.claude/settings.local.json');
    return;
  }
  if (changed) {
    fs.writeFileSync(paths.claudeSettingsLocal, `${JSON.stringify(next, null, 2)}\n`);
    removed.push('Token Guard hooks from .claude/settings.local.json');
  }
}

function appendHook(eventHooks = [], matcher, command) {
  const group = { hooks: [{ type: 'command', command }] };
  if (matcher) group.matcher = matcher;
  return [...(Array.isArray(eventHooks) ? eventHooks : []), group];
}

export function isTokenGuardCommand(command = '') {
  const c = String(command || '');
  return c.includes('token-guard hook') || c.includes('tg hook') || c.includes('token_guard.py') || c.includes('.token-guard') || c.includes('TokenGuard/');
}

function stripTokenGuardHooks(eventHooks = []) {
  if (!Array.isArray(eventHooks)) return [];
  return eventHooks.map(group => ({ ...group, hooks: (group.hooks || []).filter(hook => !isTokenGuardCommand(hook.command)) })).filter(group => (group.hooks || []).length > 0);
}

function installCodexInstructions(projectRoot) {
  const paths = getPaths(projectRoot);
  const section = `${TG_START}
# Token Guard local token-efficiency rules

Token Guard is a local-first token efficiency layer. It should reduce wasted tokens without slowing down development or making communication harder to understand.

## Balanced Signal Mode

Use high-signal, low-waste communication.

Compress:
- greetings, filler, apologies, repeated summaries, and tool-use narration
- obvious restatements of the user's request
- long explanations when the user only needs a command, patch, or direct answer
- repeated status updates after every small tool call

Do not compress:
- root-cause analysis
- architecture or product tradeoffs
- safety, risk, migration, or data-loss warnings
- explanations the user explicitly asks for
- user-facing copy, code, commands, identifiers, paths, or error messages

Default behavior:
- Be concise, but still readable.
- Prefer clear bullets for technical status.
- Keep reasoning summaries useful, not cryptic.
- Match the user's conversation language for explanations.
- Keep commands, code, file paths, identifiers, and error strings unchanged.
- If the user asks for detail, expand normally.

## Long Input Digest

When the user provides a very long prompt, Token Guard may create \`TokenGuard/sessions/input-digest.md\`.

Use it as a compressed working brief for later turns:
- do not restate the original wall of text
- preserve hard requirements, constraints, decisions, commands, files, numbers, and identifiers
- ask focused questions if details are missing
- do not treat the digest as more authoritative than the current user message

## Context efficiency

- Prefer narrow reads and targeted context over full-file reads.
- Narrow Read windows are safe and should be used before Edit.
- When unsure, use \`tg ctx <file>\` first. It returns the smallest useful context.
- If the user mentions a symbol/topic, prefer \`tg ctx <file> --focus <symbol-or-topic>\`.
- Use \`tg ctx <file> --around <text> --context 10\` for exact string neighborhoods.
- Avoid reading generated, build, dependency, coverage, lock, and long log files unless the user explicitly asks.
- If a full read is genuinely needed, ask for or use \`token-guard allow <file> --once\` / \`@tg:force-read <file>\`.

## Memory

- Keep \`TokenGuard/memory/core.md\` and \`TokenGuard/sessions/handoff.md\` concise.
- Handoff is a compressed state summary, never a transcript copy.
${TG_END}
`;
  upsertMarkedSection(paths.agents, section);
}

function writeClaudeLocal(paths) {
  const section = `${TG_START}
# Token Guard

Token Guard is installed for this local project.

Token Guard's goal:
- reduce wasted tokens across the AI coding loop
- preserve development speed and result quality
- avoid making communication harder to understand

## Balanced Signal Mode

Use concise, high-signal communication by default. Compress filler, not meaning.

Compress:
- greetings, filler, apologies, repeated summaries
- "I will now..." tool narration
- obvious restatements
- long explanations when a short answer is enough

Do not compress:
- root-cause analysis
- technical tradeoffs
- migration/data-loss/security warnings
- explanations the user explicitly asks for
- code, commands, identifiers, file paths, error messages
- user-facing product copy unless asked

Style:
- concise, but not cryptic
- clear bullets over dense paragraphs
- expand normally when the user is reasoning, deciding, debugging, or asking why
- match the user's conversation language for explanations
- keep commands and code unchanged

## Long Input Digest

If \`TokenGuard/sessions/input-digest.md\` exists and is relevant:
- use it as a compressed working brief for follow-up turns
- do not restate the original long user input
- preserve hard requirements, constraints, decisions, commands, files, numbers, and identifiers
- if something is missing, ask a focused question instead of re-processing the whole wall of text

## Context rules

Use:
- \`TokenGuard/memory/core.md\` for durable project facts.
- \`TokenGuard/sessions/handoff.md\` for next-session handoff.
- Narrow Read windows before Edit.
- \`tg ctx <file>\` before reading expensive files.
- \`tg ctx <file> --focus <symbol-or-topic>\` when the user mentions a function, class, concept, or bug area.
- \`tg ctx <file> --around <text> --context 10\` when the user mentions an exact string/key/error.
- \`tg ctx <file> --lines A:B\` when you already know the needed line range.

Avoid:
- broad full-file reads when a narrow read is enough
- replaying long Bash/Python heredocs from old sessions
- copying large grep/build/test output into the conversation

Handoff rule:
- Handoff is a compressed state summary, never a transcript copy.
${TG_END}
`;
  upsertMarkedSection(paths.claudeLocal, section);
}

function upsertMarkedSection(file, section) {
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`${escapeRegex(TG_START)}[\\s\\S]*?${escapeRegex(TG_END)}\\n?`, 'm');
  content = re.test(content) ? content.replace(re, section) : `${content}${content && !content.endsWith('\n') ? '\n' : ''}${section}`;
  fs.writeFileSync(file, content);
}

function removeMarkedSectionOrFile(file, removed = []) {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`${escapeRegex(TG_START)}[\\s\\S]*?${escapeRegex(TG_END)}\\n?`, 'm');
  const next = content.replace(re, '').trim();
  if (!next) { fs.rmSync(file, { force: true }); removed.push(path.basename(file)); return; }
  if (next !== content.trim()) { fs.writeFileSync(file, `${next}\n`); removed.push(`Token Guard block from ${path.basename(file)}`); }
}

function cleanGitignore(file, removed = []) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const next = lines.filter(line => !GITIGNORE_ENTRIES.includes(line.trim()));
  if (next.join('\n') !== lines.join('\n')) {
    fs.writeFileSync(file, `${next.join('\n').replace(/\n+$/g, '')}\n`);
    removed.push('Token Guard entries from .gitignore');
  }
}
function removePath(target, removed = []) { if (!target || !fs.existsSync(target)) return; fs.rmSync(target, { recursive: true, force: true }); removed.push(path.basename(target)); }
function cleanupEmptyDir(dir, removed = []) { if (!dir || !fs.existsSync(dir)) return; try { if (fs.readdirSync(dir).length === 0) { fs.rmdirSync(dir); removed.push(path.basename(dir)); } } catch {} }
function isEmptyObject(value) { return value && typeof value === 'object' && Object.keys(value).length === 0; }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
