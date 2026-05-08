import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { rel } from './project.js';

const TEXT_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.mdx',
  '.yml',
  '.yaml',
  '.html',
  '.css',
  '.scss',
  '.py',
  '.java',
  '.kt',
  '.kts',
  '.go',
  '.rs',
  '.swift',
  '.dart',
  '.php',
  '.rb',
  '.sh',
  '.zsh',
  '.bash',
  '.sql',
  '.xml',
  '.txt',
  '.env',
  '.log'
]);

const LOG_EXTENSIONS = new Set(['.log', '.out', '.err']);

export function estimateTokens(textOrBytes) {
  if (typeof textOrBytes === 'number') return Math.ceil(textOrBytes / 4);
  if (!textOrBytes) return 0;
  return Math.ceil(String(textOrBytes).length / 4);
}

export function hashText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

export function normalizeRelPath(filePath, projectRoot = process.cwd()) {
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.join(projectRoot, filePath || '');

  return rel(projectRoot, absolute);
}

export function isAlwaysAllowed(relPath, config) {
  return matchesAny(relPath, config.patterns?.alwaysAllow || []);
}

export function isAlwaysGuarded(relPath, config) {
  return matchesAny(relPath, config.patterns?.alwaysGuard || []);
}

export function matchesAny(relPath, patterns = []) {
  const p = String(relPath || '').split(path.sep).join('/');

  return patterns.some(pattern => {
    if (!pattern) return false;

    if (pattern.endsWith('/')) {
      return p.startsWith(pattern) || p.includes(`/${pattern}`);
    }

    return p === pattern || p.endsWith(`/${pattern}`) || p.includes(pattern);
  });
}

export function looksTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

export function looksLogFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const p = String(filePath || '').toLowerCase();

  return LOG_EXTENSIONS.has(ext) || p.includes('/logs/') || p.includes('log/');
}

export function safeReadText(filePath, maxBytes = 1024 * 1024) {
  const stat = fs.statSync(filePath);

  if (stat.size > maxBytes) {
    return fs.readFileSync(filePath, 'utf8').slice(0, maxBytes);
  }

  return fs.readFileSync(filePath, 'utf8');
}

export function fileTokenEstimate(filePath) {
  try {
    const stat = fs.statSync(filePath);

    if (!stat.isFile()) return 0;

    return estimateTokens(stat.size);
  } catch {
    return 0;
  }
}

export function fileInfo(projectRoot, filePath, config) {
  if (!filePath) return null;

  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.join(projectRoot, filePath);

  const relPath = rel(projectRoot, absolute);

  let stat = null;

  try {
    stat = fs.statSync(absolute);
  } catch {
    return {
      absolute,
      relPath,
      exists: false,
      tokens: 0,
      bytes: 0
    };
  }

  const bytes = stat.isFile() ? stat.size : 0;

  return {
    absolute,
    relPath,
    exists: stat.isFile(),
    bytes,
    tokens: estimateTokens(bytes),
    alwaysAllowed: isAlwaysAllowed(relPath, config),
    alwaysGuarded: isAlwaysGuarded(relPath, config),
    looksText: looksTextFile(absolute),
    looksLog: looksLogFile(relPath)
  };
}

export function scanProject(projectRoot, config) {
  const files = [];
  let scannedFiles = 0;

  walk(projectRoot, absolute => {
    const rp = rel(projectRoot, absolute);

    if (shouldSkipScan(rp, config)) return;
    if (!looksTextFile(absolute)) return;

    const tokens = fileTokenEstimate(absolute);

    if (tokens <= 0) return;

    scannedFiles += 1;
    files.push({
      path: rp,
      tokens
    });
  });

  files.sort((a, b) => b.tokens - a.tokens);

  return {
    scannedFiles,
    totalTokens: files.reduce((sum, f) => sum + f.tokens, 0),
    files
  };
}

function shouldSkipScan(relPath, config) {
  if (relPath.startsWith('.git/')) return true;
  if (relPath.startsWith('TokenGuard/')) return true;
  if (relPath.startsWith('.token-guard/')) return true;
  if (relPath.includes('/node_modules/')) return true;
  if (isAlwaysGuarded(relPath, config)) return true;

  return false;
}

function walk(dir, visit) {
  let entries = [];

  try {
    entries = fs.readdirSync(dir, {
      withFileTypes: true
    });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (
        entry.name === '.git' ||
        entry.name === 'node_modules' ||
        entry.name === 'TokenGuard' ||
        entry.name === '.token-guard'
      ) {
        continue;
      }

      walk(absolute, visit);
    } else if (entry.isFile()) {
      visit(absolute);
    }
  }
}

export function trimBashOutput(stdout = '', stderr = '', config = {}) {
  const maxLines = Number(config.thresholds?.bashOutputMaxLines || 140);
  const originalText = [stdout, stderr].filter(Boolean).join('\n');
  const originalTokens = estimateTokens(originalText);
  const lines = originalText.split(/\r?\n/);

  if (lines.length <= maxLines && originalTokens < 12000) {
    return {
      changed: false,
      stdout,
      stderr,
      originalTokens,
      trimmedTokens: originalTokens,
      omittedLines: 0
    };
  }

  const trimmed = smartTrimLines(lines, maxLines);

  const text = trimmed.rows
    .map(row => `${String(row.n).padStart(5, ' ')} | ${row.line}`)
    .join('\n');

  const banner = `[Token Guard: trimmed ${trimmed.omitted.toLocaleString('en-US')} noisy Bash output lines. Preserved head/tail and error/failure context.]`;

  const newStdout = `${banner}\n${text}\n[... ${trimmed.omitted.toLocaleString('en-US')} lines elided ...]\n`;

  return {
    changed: true,
    stdout: newStdout,
    stderr: '',
    originalTokens,
    trimmedTokens: estimateTokens(newStdout),
    omittedLines: trimmed.omitted
  };
}

export function smartTrimLines(lines, maxLines = 140) {
  const keywords = /(error|fail|failed|failure|exception|traceback|expected|received|actual|assert|panic|fatal|denied|cannot|not found|undefined|segmentation|timeout|caused by)/i;

  const keep = new Map();

  const addRange = (start, end) => {
    for (let i = Math.max(0, start); i < Math.min(lines.length, end); i += 1) {
      keep.set(i, lines[i]);
    }
  };

  addRange(0, Math.min(50, lines.length));
  addRange(Math.max(0, lines.length - 50), lines.length);

  for (let i = 0; i < lines.length; i += 1) {
    if (keywords.test(lines[i])) {
      addRange(i - 3, i + 5);
    }
  }

  let rows = [...keep.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, line]) => ({
      n: idx + 1,
      line
    }));

  if (rows.length > maxLines) {
    const headCount = Math.floor(maxLines * 0.35);
    const tailCount = Math.floor(maxLines * 0.35);

    const head = rows.slice(0, headCount);
    const tail = rows.slice(Math.max(headCount, rows.length - tailCount));
    const middle = rows
      .filter(row => keywords.test(row.line))
      .slice(0, maxLines - head.length - tail.length);

    const seen = new Set();

    rows = [...head, ...middle, ...tail]
      .filter(row => {
        if (seen.has(row.n)) return false;
        seen.add(row.n);
        return true;
      })
      .sort((a, b) => a.n - b.n);
  }

  return {
    rows,
    omitted: Math.max(0, lines.length - rows.length)
  };
}

export function extractRelevantLogLines(text, maxLines = 140) {
  const lines = String(text || '').split(/\r?\n/);
  return smartTrimLines(lines, maxLines);
}
