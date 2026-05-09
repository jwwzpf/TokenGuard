import fs from 'node:fs';
import path from 'node:path';

export const APP_DIR = 'TokenGuard';
export const LEGACY_APP_DIR = '.token-guard';

export const DEFAULT_CONFIG = {
  version: 1,
  enabled: true,
  mode: 'observe',
  signal: {
    enabled: true,
    level: 'balanced'
  },
  longInput: {
    enabled: true,
    minChars: 4000,
    maxDigestChars: 12000,
    maxDigestLines: 180
  },
  cache: {
    enabled: true,
    ttlMs: 5 * 60 * 1000,
    maxOutputChars: 12000,
    autoUseInModes: ['auto', 'strict']
  },
  thresholds: {
    softTokens: 25000,
    hardTokens: 60000,
    hugeFileBytes: 500000,
    logBytes: 120000,
    memoryCoreMaxLines: 150,
    reminderStateTtlMs: 5 * 60 * 1000,
    bashOutputMaxLines: 140,
    precisionReadMaxTokens: 6000,
    symbolContextLines: 30,
    narrowReadMaxLines: 200
  },
  savings: {
    repeatBlockDiscount: 0.12,
    fallbackPenaltyTokens: 450,
    reminderDedupTokens: 180,
    autoAllowAfterFallbacks: 2,
    autoAllowWindowMs: 5 * 60 * 1000
  },
  forceRead: {
    once: []
  },
  state: {
    lastReminderHash: null,
    lastReminderAt: null
  },
  patterns: {
    alwaysGuard: [
      'node_modules/',
      'dist/',
      'build/',
      'coverage/',
      '.next/',
      '.nuxt/',
      '.turbo/',
      '.dart_tool/',
      'ios/Pods/',
      'android/.gradle/',
      'generated/',
      '.min.js',
      '.map',
      '.lock',
      '.log'
    ],
    alwaysAllow: [
      'TokenGuard/',
      '.token-guard/',
      'TokenGuard/sessions/',
      'TokenGuard/memory/',
      'TokenGuard/summaries/',
      'TokenGuard/reports/',
      'TokenGuard/index/',
      'TokenGuard/ledger/',
      'TokenGuard/cache/',
      '.token-guard/sessions/',
      '.token-guard/memory/',
      '.token-guard/summaries/',
      '.token-guard/reports/',
      '.token-guard/index/',
      '.token-guard/ledger/',
      'CLAUDE.local.md',
      'AGENTS.md'
    ]
  }
};

export function getProjectRoot(start = process.cwd()) {
  return start;
}

export function getPaths(projectRoot = process.cwd()) {
  const base = path.join(projectRoot, APP_DIR);

  return {
    projectRoot,
    base,
    legacyBase: path.join(projectRoot, LEGACY_APP_DIR),

    config: path.join(base, 'config.json'),

    reports: path.join(base, 'reports'),
    reportHtml: path.join(base, 'reports', 'weekly-savings.html'),
    reportSvg: path.join(base, 'reports', 'share-card.svg'),
    reportPng: path.join(base, 'reports', 'share-card.png'),

    memory: path.join(base, 'memory'),
    memoryCore: path.join(base, 'memory', 'core.md'),
    decisions: path.join(base, 'memory', 'decisions.md'),
    gotchas: path.join(base, 'memory', 'gotchas.md'),

    sessions: path.join(base, 'sessions'),
    handoff: path.join(base, 'sessions', 'handoff.md'),
    inputDigest: path.join(base, 'sessions', 'input-digest.md'),

    summaries: path.join(base, 'summaries'),
    largeFileSummaries: path.join(base, 'summaries', 'large-files'),
    logSummaries: path.join(base, 'summaries', 'logs'),

    index: path.join(base, 'index'),
    symbolsJson: path.join(base, 'index', 'symbols.json'),

    cache: path.join(base, 'cache'),
    commandCache: path.join(base, 'cache', 'commands.json'),
    fileSnapshots: path.join(base, 'cache', 'file-snapshots.json'),

    ledger: path.join(base, 'ledger'),
    ledgerEvents: path.join(base, 'ledger', 'events.jsonl'),

    claudeDir: path.join(projectRoot, '.claude'),
    claudeSettingsLocal: path.join(projectRoot, '.claude', 'settings.local.json'),
    claudeLocal: path.join(projectRoot, 'CLAUDE.local.md'),

    agents: path.join(projectRoot, 'AGENTS.md'),
    gitignore: path.join(projectRoot, '.gitignore'),

    legacyPythonMvp: path.join(projectRoot, 'token_guard.py')
  };
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function mergeConfig(config) {
  const merged = deepMerge(DEFAULT_CONFIG, config || {});

  merged.patterns = merged.patterns || {};
  merged.patterns.alwaysAllow = unionStrings(
    DEFAULT_CONFIG.patterns.alwaysAllow,
    config?.patterns?.alwaysAllow || []
  );
  merged.patterns.alwaysGuard = unionStrings(
    DEFAULT_CONFIG.patterns.alwaysGuard,
    config?.patterns?.alwaysGuard || []
  );

  for (const key of ['thresholds', 'savings', 'forceRead', 'state', 'signal', 'longInput', 'cache']) {
    merged[key] = {
      ...DEFAULT_CONFIG[key],
      ...(config?.[key] || {}),
      ...(merged[key] || {})
    };
  }

  return merged;
}

function unionStrings(...arrays) {
  return [...new Set(arrays.flat().filter(Boolean).map(String))];
}

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object') return clone(base);

  const out = Array.isArray(base) ? [...base] : { ...base };

  for (const [key, value] of Object.entries(extra)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === 'object' &&
      !Array.isArray(base[key])
    ) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }

  return out;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function loadConfig(projectRoot = process.cwd()) {
  const paths = getPaths(projectRoot);
  return mergeConfig(readJson(paths.config, DEFAULT_CONFIG));
}

export function saveConfig(projectRoot, config) {
  const paths = getPaths(projectRoot);
  writeJson(paths.config, mergeConfig(config));
  return loadConfig(projectRoot);
}

export function ensureProjectFiles(projectRoot = process.cwd()) {
  migrateLegacy(projectRoot);

  const paths = getPaths(projectRoot);

  for (const dir of [
    paths.base,
    paths.reports,
    paths.memory,
    paths.sessions,
    paths.summaries,
    paths.largeFileSummaries,
    paths.logSummaries,
    paths.index,
    paths.cache,
    paths.ledger
  ]) {
    ensureDir(dir);
  }

  if (!fs.existsSync(paths.config)) {
    writeJson(paths.config, DEFAULT_CONFIG);
  } else {
    saveConfig(projectRoot, loadConfig(projectRoot));
  }

  ensureFile(paths.memoryCore, '# Token Guard Core Memory\n\nKeep this file short. Put only durable project facts, architecture rules, and current workflow constraints here.\n');
  ensureFile(paths.decisions, '# Decisions\n\n');
  ensureFile(paths.gotchas, '# Gotchas\n\n');
  ensureFile(paths.handoff, '# Next Session Handoff\n\n## Current Goal\n\n## What Changed\n\n## Files Touched\n\n## Tests Run\n\n## Current Blocker\n\n## Next Smallest Task\n\n## Do Not Re-investigate\n\n');
  ensureFile(paths.inputDigest, '# Long Input Digest\n\nNo long user input has been digested yet.\n');
  ensureFile(paths.ledgerEvents, '');
  ensureFile(paths.commandCache, '{}\n');
  ensureFile(paths.fileSnapshots, '{}\n');

  return paths;
}

function ensureFile(file, content) {
  if (!fs.existsSync(file)) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, content);
  }
}

function migrateLegacy(projectRoot) {
  const paths = getPaths(projectRoot);

  if (!fs.existsSync(paths.legacyBase) || fs.existsSync(paths.base)) return;

  try {
    fs.cpSync(paths.legacyBase, paths.base, {
      recursive: true,
      force: false
    });
  } catch {
    // Best effort only.
  }
}

export function updateGitignore(projectRoot = process.cwd()) {
  const paths = getPaths(projectRoot);
  const entries = ['TokenGuard/', '.token-guard/', 'CLAUDE.local.md', '.claude/settings.local.json'];

  let content = fs.existsSync(paths.gitignore)
    ? fs.readFileSync(paths.gitignore, 'utf8')
    : '';

  let changed = false;

  for (const entry of entries) {
    if (!content.split(/\r?\n/).includes(entry)) {
      content += `${content.endsWith('\n') || content.length === 0 ? '' : '\n'}${entry}\n`;
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(paths.gitignore, content);
  }
}

export function rel(projectRoot, absolutePath) {
  return path.relative(projectRoot, absolutePath).split(path.sep).join('/');
}
