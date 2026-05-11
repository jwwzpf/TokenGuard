import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir,
  ensureProjectFiles,
  getPaths,
  loadConfig,
  saveConfig,
  updateGitignore,
  rel
} from './project.js';

const TG_START = '<!-- TOKEN_GUARD_START -->';
const TG_END = '<!-- TOKEN_GUARD_END -->';

const GITIGNORE_ENTRIES = [
  'TokenGuard/',
  '.token-guard/',
  'CLAUDE.local.md',
  '.claude/settings.local.json'
];

export function install(projectRoot = process.cwd(), options = {}) {
  const paths = ensureProjectFiles(projectRoot);

  let config = loadConfig(projectRoot);

  config.enabled = true;
  config.mode = 'smart';
  config.policy = {
    ...(config.policy || {}),
    strategy: 'smart',
    guardOnlyHighConfidenceWaste: true
  };

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
      const config = saveConfig(projectRoot, {
        ...loadConfig(projectRoot),
        enabled: false
      });

      removed.push('disabled TokenGuard/config.json');

      return {
        paths,
        config,
        removed
      };
    } catch {
      // Continue with best effort.
    }
  }

  cleanupEmptyDir(paths.claudeDir, removed);

  return {
    paths,
    config: null,
    removed
  };
}

export function setEnabled(projectRoot = process.cwd(), enabled) {
  ensureProjectFiles(projectRoot);

  const config = loadConfig(projectRoot);

  config.enabled = Boolean(enabled);

  return saveConfig(projectRoot, config);
}

// Backward-compatible hidden API. Product-facing Token Guard has one smart policy.
export function setMode(projectRoot = process.cwd()) {
  ensureProjectFiles(projectRoot);

  const config = loadConfig(projectRoot);

  config.mode = 'smart';
  config.policy = {
    ...(config.policy || {}),
    strategy: 'smart'
  };

  return saveConfig(projectRoot, config);
}

export function allowOnce(projectRoot = process.cwd(), file = '*') {
  ensureProjectFiles(projectRoot);

  const config = loadConfig(projectRoot);
  const once = new Set(config.forceRead?.once || []);

  for (const variant of forceReadVariants(projectRoot, file)) {
    once.add(variant);
  }

  config.forceRead = {
    ...(config.forceRead || {}),
    once: [...once]
  };

  return saveConfig(projectRoot, config);
}

export function forceReadVariants(projectRoot, file = '*') {
  const raw = String(file || '*').trim();

  if (!raw || raw === '*') {
    return ['*'];
  }

  const variants = new Set();

  variants.add(raw);
  variants.add(raw.replace(/^\.\//, ''));

  const absolute = path.isAbsolute(raw)
    ? raw
    : path.join(projectRoot, raw);

  variants.add(absolute);
  variants.add(rel(projectRoot, absolute));
  variants.add(path.basename(raw));

  return [...variants].filter(Boolean);
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
  hooks.PreToolUse = appendHook(hooks.PreToolUse, 'Read|Bash|WebFetch|WebSearch', `${command} PreToolUse`);
  hooks.PostToolUse = appendHook(hooks.PostToolUse, 'Bash|WebFetch|WebSearch', `${command} PostToolUse`);
  hooks.Stop = appendHook(hooks.Stop, null, `${command} Stop`);
  hooks.SessionEnd = appendHook(hooks.SessionEnd, null, `${command} SessionEnd`);
  hooks.PreCompact = appendHook(hooks.PreCompact, null, `${command} PreCompact`);

  const next = {
    ...existing,
    hooks
  };

  fs.writeFileSync(paths.claudeSettingsLocal, `${JSON.stringify(next, null, 2)}\n`);
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
    const after = JSON.stringify(hooks[eventName]);

    if (before !== after) changed = true;

    if (Array.isArray(hooks[eventName]) && hooks[eventName].length === 0) {
      delete hooks[eventName];
      changed = true;
    }
  }

  const next = {
    ...existing,
    hooks
  };

  if (Object.keys(next.hooks || {}).length === 0) {
    delete next.hooks;
  }

  if (isEmptyObject(next)) {
    fs.rmSync(paths.claudeSettingsLocal, {
      force: true
    });
    removed.push('.claude/settings.local.json');
    return;
  }

  if (changed) {
    fs.writeFileSync(paths.claudeSettingsLocal, `${JSON.stringify(next, null, 2)}\n`);
    removed.push('Token Guard hooks from .claude/settings.local.json');
  }
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

export function isTokenGuardCommand(command = '') {
  const c = String(command || '');

  return (
    c.includes('token-guard hook') ||
    c.includes('tg hook') ||
    c.includes('token_guard.py') ||
    c.includes('.token-guard') ||
    c.includes('TokenGuard/')
  );
}

function stripTokenGuardHooks(eventHooks = []) {
  if (!Array.isArray(eventHooks)) return [];

  return eventHooks
    .map(group => ({
      ...group,
      hooks: (group.hooks || []).filter(
        hook => !isTokenGuardCommand(hook.command)
      )
    }))
    .filter(group => (group.hooks || []).length > 0);
}

function installCodexInstructions(projectRoot) {
  const paths = getPaths(projectRoot);

  const section = `${TG_START}
# Token Guard Smart Savings rules

Token Guard is a local-first smart token savings layer. It should save tokens automatically without slowing down development or degrading result quality.

## Communication

Use Balanced Signal Mode:
- compress filler, greetings, apologies, repeated summaries, and tool-use narration
- do not compress root-cause analysis, tradeoffs, warnings, user-requested explanations, code, commands, paths, identifiers, or error strings
- be concise but not cryptic
- match the user's conversation language for explanations; keep commands/code unchanged

## Long input

When \`TokenGuard/sessions/input-digest.md\` is relevant, use it as a compressed working brief for follow-up turns. Do not restate the user's raw wall of text. Preserve requirements, decisions, constraints, open questions, files, commands, numbers, and identifiers.

## Context

- Narrow Read windows are safe and should be used before Edit.
- Prefer native narrow Read when you already know the line range.
- Use \`tg ctx <file> --focus <symbol-or-topic>\` when you need to locate a symbol/topic.
- Use \`tg ctx <file> --around <text> --context 10\` when you need nearby context for a literal string.
- Avoid full dumps from generated/build/dependency/coverage/lock/log files.
- If a full read is genuinely needed, use \`token-guard allow <file> --once\` / \`@tg:force-read <file>\`.

## Web/search budget

- Do not repeat the same WebSearch query when existing context is enough.
- Prefer fewer, targeted searches over broad parallel searches.
- Summarize fetched pages; do not paste long excerpts.

## Memory

- Handoff is a compressed state summary, never a transcript copy.
- Static rules are written here; do not repeat them in normal responses.
${TG_END}
`;

  upsertMarkedSection(paths.agents, section);
}

function writeClaudeLocal(paths) {
  const section = `${TG_START}
# Token Guard

Token Guard is installed for this local project.

Goal:
- save tokens automatically across the AI coding loop
- preserve agent speed and result quality
- stay quiet unless it is saving tokens or preventing obvious waste

## Balanced Signal Mode

Compress filler, not meaning.

Compress:
- greetings, apologies, filler, repeated summaries
- tool-use narration such as "I will now..."
- obvious restatements

Do not compress:
- root-cause analysis
- technical/product tradeoffs
- migration/data-loss/security warnings
- explanations the user asks for
- code, commands, identifiers, file paths, error messages
- user-facing product copy unless asked

## Long Input Digest

If \`TokenGuard/sessions/input-digest.md\` is relevant, use it as a compressed working brief for follow-up turns. Do not restate the original long input. If something is missing, ask a focused question.

## Context rules

- Use narrow Read windows before Edit.
- Use native Read offset/limit when line ranges are known.
- Use \`tg ctx <file> --focus <symbol-or-topic>\` to locate symbol/topic context.
- Use \`tg ctx <file> --around <text> --context 10\` for literal nearby context.
- Avoid broad full-file dumps when a narrow read is enough.
- Avoid replaying long Bash/Python heredocs from old sessions.
- Avoid copying large grep/build/test output into the conversation.

## Handoff rule

Handoff is a compressed state summary, never a transcript copy.
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

function removeMarkedSectionOrFile(file, removed = []) {
  if (!fs.existsSync(file)) return;

  const content = fs.readFileSync(file, 'utf8');

  const re = new RegExp(
    `${escapeRegex(TG_START)}[\\s\\S]*?${escapeRegex(TG_END)}\\n?`,
    'm'
  );

  const next = content.replace(re, '').trim();

  if (!next) {
    fs.rmSync(file, {
      force: true
    });
    removed.push(path.basename(file));
    return;
  }

  if (next !== content.trim()) {
    fs.writeFileSync(file, `${next}\n`);
    removed.push(`Token Guard block from ${path.basename(file)}`);
  }
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

function removePath(target, removed = []) {
  if (!target || !fs.existsSync(target)) return;

  fs.rmSync(target, {
    recursive: true,
    force: true
  });

  removed.push(path.basename(target));
}

function cleanupEmptyDir(dir, removed = []) {
  if (!dir || !fs.existsSync(dir)) return;

  try {
    if (fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      removed.push(path.basename(dir));
    }
  } catch {
    // Best effort.
  }
}

function isEmptyObject(value) {
  return value && typeof value === 'object' && Object.keys(value).length === 0;
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
