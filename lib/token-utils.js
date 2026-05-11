import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { rel } from './project.js';

const DEFAULT_IGNORE_DIRS = [
  '.git',
  'TokenGuard',
  '.token-guard',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.dart_tool',
  'ios/Pods',
  'android/.gradle'
];

const MIN_TRIM_BYTES = 1024;

export function estimateTokens(text = '') {
  const s = String(text || '');
  if (!s) return 0;

  // Conservative enough for source/log text. Exact tokenization is model-dependent.
  return Math.ceil(s.length / 4);
}

export function hashText(text = '') {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex');
}

export function looksLogFile(filePath = '') {
  const p = String(filePath || '').toLowerCase();

  return (
    p.endsWith('.log') ||
    p.includes('/logs/') ||
    p.includes('/log/') ||
    p.includes('surefire-reports') ||
    p.includes('failsafe-reports')
  );
}

export function isAlwaysAllowed(relPath = '', config = {}) {
  const p = normalizePath(relPath);
  const allow = config.patterns?.alwaysAllow || [];

  return allow.some(pattern => matchesPattern(p, pattern));
}

export function isAlwaysGuarded(relPath = '', config = {}) {
  const p = normalizePath(relPath);
  const guard = config.patterns?.alwaysGuard || [];

  return guard.some(pattern => matchesPattern(p, pattern));
}

export function fileInfo(projectRoot = process.cwd(), filePath = '', config = {}) {
  if (!filePath) return null;

  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.join(projectRoot, filePath);

  const relPath = normalizePath(rel(projectRoot, absolute));
  const exists = fs.existsSync(absolute);

  let bytes = 0;
  let tokens = 0;

  if (exists) {
    try {
      const stat = fs.statSync(absolute);
      bytes = stat.size;

      if (stat.isFile()) {
        const content = fs.readFileSync(absolute, 'utf8');
        tokens = estimateTokens(content);
      }
    } catch {
      bytes = 0;
      tokens = 0;
    }
  }

  return {
    absolute,
    relPath,
    exists,
    bytes,
    tokens,
    looksLog: looksLogFile(relPath),
    alwaysAllowed: isAlwaysAllowed(relPath, config),
    alwaysGuarded: isAlwaysGuarded(relPath, config)
  };
}

export function scanProject(projectRoot = process.cwd(), config = {}) {
  const files = [];

  walk(projectRoot, projectRoot, files, config);

  files.sort((a, b) => b.tokens - a.tokens);

  return {
    totalTokens: files.reduce((sum, row) => sum + row.tokens, 0),
    scannedFiles: files.length,
    files
  };
}

function walk(projectRoot, dir, files, config) {
  let entries = [];

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const relPath = normalizePath(rel(projectRoot, absolute));

    if (entry.isDirectory()) {
      if (shouldSkipDir(relPath, entry.name, config)) continue;
      walk(projectRoot, absolute, files, config);
      continue;
    }

    if (!entry.isFile()) continue;
    if (isBinaryLike(entry.name)) continue;
    if (isAlwaysAllowed(relPath, config)) continue;

    try {
      const content = fs.readFileSync(absolute, 'utf8');
      files.push({
        path: relPath,
        bytes: Buffer.byteLength(content, 'utf8'),
        tokens: estimateTokens(content)
      });
    } catch {
      // Ignore unreadable/binary files.
    }
  }
}

function shouldSkipDir(relPath, name, config) {
  const normalized = normalizePath(relPath);

  if (DEFAULT_IGNORE_DIRS.includes(name)) return true;
  if (DEFAULT_IGNORE_DIRS.some(dir => normalized === dir || normalized.startsWith(`${dir}/`))) return true;
  if (isAlwaysAllowed(normalized, config)) return true;

  return false;
}

function isBinaryLike(name = '') {
  return /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tar|7z|mp4|mov|mp3|wav|woff|woff2|ttf|otf|jar|class|so|dylib|dll|exe)$/i.test(name);
}

function matchesPattern(relPath, pattern) {
  const p = normalizePath(relPath);
  const raw = normalizePath(String(pattern || ''));

  if (!raw) return false;

  if (raw.endsWith('/')) {
    return p === raw.slice(0, -1) || p.startsWith(raw);
  }

  if (raw.includes('*')) {
    const re = new RegExp(`^${escapeRegex(raw).replaceAll('\\*', '.*')}$`);
    return re.test(p);
  }

  return p === raw || p.endsWith(`/${raw}`) || p.includes(raw);
}

export function trimBashOutput(stdout = '', stderr = '', config = {}) {
  const command = String(config.command || config.cmd || '');
  const out = String(stdout || '');
  const err = String(stderr || '');
  const combined = err ? `${out}\n${err}` : out;
  const inBytes = Buffer.byteLength(combined, 'utf8');

  if (inBytes < MIN_TRIM_BYTES) {
    return unchanged(out, err, command, 'small-output');
  }

  const profile = classifyToolOutput(command, out, err);
  const result =
    profile === 'maven'
      ? trimMavenOutput(out, err, command, config)
      : profile === 'git'
        ? trimGitOutput(out, err, command, config)
        : trimGenericOutput(out, err, command, config);

  if (!result.changed) return result;

  result.profile = profile;
  result.inBytes = inBytes;
  result.outBytes = Buffer.byteLength(`${result.stdout || ''}\n${result.stderr || ''}`, 'utf8');
  result.savedBytes = Math.max(0, result.inBytes - result.outBytes);
  result.originalTokens = estimateTokens(combined);
  result.trimmedTokens = estimateTokens(`${result.stdout || ''}\n${result.stderr || ''}`);
  result.savedTokens = Math.max(0, result.originalTokens - result.trimmedTokens);

  return result;
}

function classifyToolOutput(command, stdout, stderr) {
  const c = String(command || '').toLowerCase();
  const text = `${stdout || ''}\n${stderr || ''}`;

  if (
    /\b(\.\/mvnw|mvnw|mvn)\b/.test(c) ||
    /\bBUILD (SUCCESS|FAILURE)\b/.test(text) ||
    /\[INFO\]\s+---\s+[^ ]+:[^ ]+:[^ ]+\s+/.test(text) ||
    /Tests run:\s*\d+,\s*Failures:\s*\d+,\s*Errors:\s*\d+,\s*Skipped:\s*\d+/i.test(text)
  ) {
    return 'maven';
  }

  if (
    /\bgit\s+(diff|show|status|log)\b/.test(c) ||
    /^diff --git /m.test(text) ||
    /^@@\s+[-+0-9, ]+@@/m.test(text) ||
    /^commit\s+[a-f0-9]{7,40}/m.test(text)
  ) {
    return 'git';
  }

  return 'generic';
}

function trimMavenOutput(stdout, stderr, command, config) {
  const raw = String(stderr || '').trim()
    ? `${stdout || ''}\n${stderr || ''}`
    : String(stdout || '');

  const lines = raw.split(/\r?\n/);
  const keep = new Set();
  const preserved = {
    buildResult: false,
    testSummary: 0,
    failedTests: 0,
    compileErrors: 0,
    causedBy: 0,
    assertions: 0,
    projectFrames: 0,
    exceptions: 0
  };

  const packagePrefixes = config.project?.packagePrefixes || config.packagePrefixes || [];

  addHeadTail(keep, lines, 20, 50);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (/\bBUILD (SUCCESS|FAILURE)\b/.test(line)) {
      preserved.buildResult = true;
      addAround(keep, i, lines.length, 2);
      continue;
    }

    if (/Tests run:\s*\d+,\s*Failures:\s*\d+,\s*Errors:\s*\d+,\s*Skipped:\s*\d+/i.test(line)) {
      preserved.testSummary += 1;
      addAround(keep, i, lines.length, 1);
      continue;
    }

    if (/Failed tests?:/i.test(line)) {
      preserved.failedTests += 1;
      addBlock(keep, lines, i, 40, isLikelyMavenNoise);
      continue;
    }

    if (/^\[ERROR\].*(\.java|\.kt|\.scala):\[\d+,\d+\]/.test(line) || /^\[ERROR\].*:[0-9]+:[0-9]+:/.test(line)) {
      preserved.compileErrors += 1;
      addAround(keep, i, lines.length, 2);
      continue;
    }

    if (/Caused by:/i.test(line)) {
      preserved.causedBy += 1;
      addAround(keep, i, lines.length, 3);
      continue;
    }

    if (/(AssertionFailedError|expected:|but was:|expected .* but was|InvalidTypeIdException|ComparisonFailure)/i.test(line)) {
      preserved.assertions += 1;
      addAround(keep, i, lines.length, 3);
      continue;
    }

    if (/(Exception|Error):\s+.+/.test(line) && !looksLikeSourceCodeErrorLine(line)) {
      preserved.exceptions += 1;
      addAround(keep, i, lines.length, 2);
      continue;
    }

    if (isProjectStackFrame(line, packagePrefixes)) {
      preserved.projectFrames += 1;
      addAround(keep, i, lines.length, 1);
      continue;
    }

    if (/^\[ERROR\]\s+There are test failures/i.test(line)) {
      addAround(keep, i, lines.length, 3);
      continue;
    }

    if (/Please refer to .*surefire-reports/i.test(line)) {
      addAround(keep, i, lines.length, 1);
      continue;
    }

    if (/JaCoCo|jacoco/i.test(line) && /(coverage|covered|missed|ratio|total)/i.test(line)) {
      keep.add(i);
      continue;
    }
  }

  const selected = buildSelectedLines(lines, keep, {
    dropNoise: isLikelyMavenNoise,
    maxLines: 520,
    profile: 'maven'
  });

  const compacted = dedupSimilarLines(selected.lines);
  const output = renderTrimmedOutput({
    profile: 'maven',
    command,
    originalLineCount: lines.length,
    omittedLineCount: Math.max(0, lines.length - compacted.lines.length),
    preserved,
    bodyLines: compacted.lines,
    dedupNotes: compacted.notes
  });

  return changedResult(raw, output, '', {
    profile: 'maven',
    command,
    omittedLines: Math.max(0, lines.length - compacted.lines.length),
    preservedSignals: preserved
  });
}

function trimGitOutput(stdout, stderr, command, config) {
  const raw = String(stderr || '').trim()
    ? `${stdout || ''}\n${stderr || ''}`
    : String(stdout || '');

  const lines = raw.split(/\r?\n/);

  if (isCleanGitStatus(command, raw)) {
    const output = 'Token Guard: git status compacted\n\nworking tree clean\n';

    return changedResult(raw, output, '', {
      profile: 'git',
      command,
      omittedLines: Math.max(0, lines.length - 2),
      preservedSignals: {
        cleanStatus: true
      }
    });
  }

  const keep = new Set();
  const preserved = {
    commits: 0,
    files: 0,
    hunks: 0,
    changedLines: 0,
    stats: 0
  };

  addHeadTail(keep, lines, 12, 30);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (/^commit\s+[a-f0-9]{7,40}/.test(line)) {
      preserved.commits += 1;
      addAround(keep, i, lines.length, 4);
      continue;
    }

    if (/^(Author|Date):/.test(line)) {
      keep.add(i);
      continue;
    }

    if (/^diff --git /.test(line) || /^index [a-f0-9]+\.\.[a-f0-9]+/.test(line) || /^(\+\+\+|---) /.test(line)) {
      preserved.files += 1;
      keep.add(i);
      continue;
    }

    if (/^@@\s+[-+0-9, ]+@@/.test(line)) {
      preserved.hunks += 1;
      addAround(keep, i, lines.length, 1);
      continue;
    }

    if (/^[+-](?![+-])/.test(line)) {
      preserved.changedLines += 1;
      keep.add(i);
      continue;
    }

    if (/\d+\s+files? changed|\d+\s+insertions?|\d+\s+deletions?/.test(line)) {
      preserved.stats += 1;
      keep.add(i);
      continue;
    }
  }

  const selected = buildSelectedLines(lines, keep, {
    maxLines: Number(config.gitMaxLines || 500),
    profile: 'git'
  });

  const compacted = dedupSimilarLines(selected.lines);
  const output = renderTrimmedOutput({
    profile: 'git',
    command,
    originalLineCount: lines.length,
    omittedLineCount: Math.max(0, lines.length - compacted.lines.length),
    preserved,
    bodyLines: compacted.lines,
    dedupNotes: compacted.notes
  });

  return changedResult(raw, output, '', {
    profile: 'git',
    command,
    omittedLines: Math.max(0, lines.length - compacted.lines.length),
    preservedSignals: preserved
  });
}

function trimGenericOutput(stdout, stderr, command, config) {
  const raw = String(stderr || '').trim()
    ? `${stdout || ''}\n${stderr || ''}`
    : String(stdout || '');

  const lines = raw.split(/\r?\n/);
  const maxLines = Number(config.thresholds?.bashOutputMaxLines || config.bashOutputMaxLines || 140);

  if (lines.length <= maxLines) {
    return unchanged(stdout, stderr, command, 'generic-small-line-count');
  }

  const keep = new Set();
  const preserved = {
    errors: 0,
    failures: 0,
    exceptions: 0
  };

  addHeadTail(keep, lines, 30, 60);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (/(error|failed|failure|exception|traceback|assert|expected|received|panic|fatal|timeout|exit code|denied)/i.test(line)) {
      preserved.errors += /error/i.test(line) ? 1 : 0;
      preserved.failures += /fail/i.test(line) ? 1 : 0;
      preserved.exceptions += /exception|traceback/i.test(line) ? 1 : 0;
      addAround(keep, i, lines.length, 2);
    }
  }

  const selected = buildSelectedLines(lines, keep, {
    maxLines,
    profile: 'generic'
  });

  const compacted = dedupSimilarLines(selected.lines);
  const output = renderTrimmedOutput({
    profile: 'generic',
    command,
    originalLineCount: lines.length,
    omittedLineCount: Math.max(0, lines.length - compacted.lines.length),
    preserved,
    bodyLines: compacted.lines,
    dedupNotes: compacted.notes
  });

  return changedResult(raw, output, '', {
    profile: 'generic',
    command,
    omittedLines: Math.max(0, lines.length - compacted.lines.length),
    preservedSignals: preserved
  });
}

function isLikelyMavenNoise(line) {
  const s = String(line || '');

  if (/Downloading from|Downloaded from|Progress \(|^\s*\[INFO\]\s+---\s+[^ ]+:[^ ]+:[^ ]+\s+/.test(s)) return true;
  if (/\[INFO\]\s+Building\s+.+/.test(s)) return true;
  if (/^\[INFO\]\s+[-]{5,}/.test(s)) return true;
  if (/^\[INFO\]\s+Reactor (Build Order|Summary)/.test(s)) return false;
  if (/^\[INFO\]\s+\[INFO\]/.test(s)) return true;
  if (/Quarkus|ASCII|banner|Testcontainers|Pulling image|Creating container|Starting container/i.test(s)) return true;
  if (/Lombok|annotation processor|Jacoco|JaCoCo agent|Surefire|Failsafe/i.test(s) && !/Tests run|Failed tests|There are test failures/i.test(s)) return true;

  if (isFrameworkStackFrame(s)) return true;

  return false;
}

function isFrameworkStackFrame(line) {
  const s = String(line || '');

  return /^\s*at\s+(org\.junit|org\.apache|java\.base|jdk\.internal|io\.quarkus|io\.smallrye|io\.vertx|io\.netty|org\.jboss|org\.mockito|reactor\.|com\.sun\.)/.test(s);
}

function isProjectStackFrame(line, packagePrefixes = []) {
  const s = String(line || '');

  if (!/^\s*at\s+/.test(s)) return false;

  if (packagePrefixes.length) {
    return packagePrefixes.some(prefix => s.includes(prefix));
  }

  // Generic project-frame fallback: keep non-framework frames.
  return !isFrameworkStackFrame(s);
}

function looksLikeSourceCodeErrorLine(line) {
  const s = String(line || '').trim();

  return (
    /^throw\s+new\s+\w*Error\b/.test(s) ||
    /if\s*\(.+\berror\b.+\)/i.test(s) ||
    /error\.contains\(/i.test(s) ||
    /(const|let|var)\s+\w*error\w*\s*=/.test(s)
  );
}

function isCleanGitStatus(command, output) {
  const c = String(command || '').toLowerCase();
  const s = String(output || '').toLowerCase();

  return (
    c.includes('git status') &&
    (
      s.includes('nothing to commit, working tree clean') ||
      s.includes('working tree clean') ||
      s.includes('nothing to commit')
    )
  );
}

function addHeadTail(keep, lines, head, tail) {
  for (let i = 0; i < Math.min(head, lines.length); i += 1) keep.add(i);
  for (let i = Math.max(0, lines.length - tail); i < lines.length; i += 1) keep.add(i);
}

function addAround(keep, index, total, radius) {
  for (let i = Math.max(0, index - radius); i <= Math.min(total - 1, index + radius); i += 1) {
    keep.add(i);
  }
}

function addBlock(keep, lines, start, max, shouldStop) {
  for (let i = start; i < Math.min(lines.length, start + max); i += 1) {
    const line = lines[i];

    if (i > start && shouldStop(line) && !/Failed tests?:/i.test(line)) break;

    keep.add(i);
  }
}

function buildSelectedLines(lines, keep, options = {}) {
  const maxLines = Number(options.maxLines || 500);
  const dropNoise = options.dropNoise || (() => false);

  const indices = [...keep].sort((a, b) => a - b);
  const selected = [];

  let last = -1;

  for (const index of indices) {
    const line = lines[index];

    if (dropNoise(line)) continue;

    if (last >= 0 && index > last + 1) {
      selected.push(`[... ${index - last - 1} lines omitted ...]`);
    }

    selected.push(line);
    last = index;

    if (selected.length >= maxLines) {
      selected.push(`[Token Guard: clipped ${options.profile || 'tool'} output at ${maxLines} preserved lines.]`);
      break;
    }
  }

  return {
    lines: selected
  };
}

function dedupSimilarLines(lines) {
  const output = [];
  const notes = [];

  let previousKey = null;
  let repeatCount = 0;

  function flushRepeat() {
    if (repeatCount > 0) {
      const note = `[Token Guard: ${repeatCount} similar repeated line(s) omitted.]`;
      output.push(note);
      notes.push(note);
      repeatCount = 0;
    }
  }

  for (const line of lines) {
    const key = normalizeRepeatKey(line);

    if (key && key === previousKey) {
      repeatCount += 1;
      continue;
    }

    flushRepeat();
    output.push(line);
    previousKey = key;
  }

  flushRepeat();

  return {
    lines: output,
    notes
  };
}

function normalizeRepeatKey(line) {
  const s = String(line || '').trim();

  if (!s) return '';

  if (/Downloading from|Downloaded from|Progress \(|Pulling image|Downloaded layer|^\[INFO\]\s+Building\s+/.test(s)) {
    return s.replace(/\d+(\.\d+)?\s?(kB|MB|GB|B|%)/gi, '#').replace(/\d+/g, '#');
  }

  if (/^\[INFO\]\s+---\s+[^ ]+:[^ ]+:[^ ]+/.test(s)) {
    return '[INFO] plugin-banner';
  }

  if (/^\s*at\s+/.test(s)) {
    return s.replace(/\([^)]*\)/g, '(...)');
  }

  if (s.length > 120) {
    return s.slice(0, 80);
  }

  return '';
}

function renderTrimmedOutput({ profile, command, originalLineCount, omittedLineCount, preserved, bodyLines, dedupNotes }) {
  const header = [
    `Token Guard: trimmed ${profile} output`,
    command ? `Command: ${command}` : '',
    `Original lines: ${originalLineCount.toLocaleString('en-US')}`,
    `Omitted lines: ${Math.max(0, omittedLineCount).toLocaleString('en-US')}`,
    `Preserved signals: ${formatPreservedSignals(preserved)}`,
    ''
  ].filter(Boolean);

  const dedup = dedupNotes?.length
    ? ['Repeated output folded:', ...dedupNotes, '']
    : [];

  return [...header, ...dedup, ...bodyLines].join('\n').trimEnd() + '\n';
}

function formatPreservedSignals(preserved = {}) {
  return Object.entries(preserved)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key}=${value}`)
    .join(', ') || 'head/tail';
}

function unchanged(stdout, stderr, command, reason) {
  return {
    changed: false,
    stdout,
    stderr,
    command,
    reason,
    originalTokens: estimateTokens(`${stdout || ''}\n${stderr || ''}`),
    trimmedTokens: estimateTokens(`${stdout || ''}\n${stderr || ''}`),
    omittedLines: 0,
    profile: 'none'
  };
}

function changedResult(original, stdout, stderr, extra = {}) {
  return {
    changed: true,
    stdout,
    stderr,
    originalTokens: estimateTokens(original),
    trimmedTokens: estimateTokens(`${stdout || ''}\n${stderr || ''}`),
    omittedLines: extra.omittedLines || 0,
    ...extra
  };
}

function normalizePath(value = '') {
  return String(value || '').split(path.sep).join('/');
}

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
