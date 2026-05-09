import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { rel } from './project.js';

const TEXT_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.jsonl', '.md', '.txt', '.yml', '.yaml', '.toml', '.xml', '.html', '.css', '.scss', '.less', '.sh', '.zsh', '.bash', '.py', '.java', '.kt', '.kts', '.go', '.rs', '.dart', '.swift', '.php', '.rb', '.c', '.cpp', '.h', '.hpp', '.cs', '.sql', '.graphql', '.gql', '.env', '.log', '.lock'
]);

export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;

  const cjk = (s.match(/[\u3400-\u9FFF]/g) || []).length;
  const ascii = s.length - cjk;
  return Math.max(1, Math.ceil(cjk * 1.1 + ascii / 4));
}

export function hashText(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex');
}

export function looksTextFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;

  try {
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(512);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    return !buffer.subarray(0, bytes).includes(0);
  } catch {
    return false;
  }
}

export function looksLogFile(file) {
  const p = String(file || '').toLowerCase();
  return p.endsWith('.log') || p.includes('/logs/') || p.includes('/log/');
}

export function isAlwaysAllowed(relPath, config = {}) {
  const p = normalizeRel(relPath);
  return (config.patterns?.alwaysAllow || []).some(pattern => matchesPattern(p, pattern));
}

export function isAlwaysGuarded(relPath, config = {}) {
  const p = normalizeRel(relPath);
  if (isAlwaysAllowed(p, config)) return false;
  return (config.patterns?.alwaysGuard || []).some(pattern => matchesPattern(p, pattern));
}

export function fileInfo(projectRoot, filePath, config = {}) {
  if (!filePath) return null;

  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.join(projectRoot, filePath);
  const relPath = rel(projectRoot, absolute);

  const out = {
    absolute,
    relPath: normalizeRel(relPath),
    exists: false,
    bytes: 0,
    tokens: 0,
    alwaysGuarded: false,
    looksLog: false,
    text: false
  };

  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) return out;
    out.exists = true;
    out.bytes = stat.size;
    out.looksLog = looksLogFile(relPath) || stat.size >= Number(config.thresholds?.logBytes || 120000) && /\.log$/.test(relPath);
    out.alwaysGuarded = isAlwaysGuarded(relPath, config);
    out.text = looksTextFile(absolute);

    if (out.text) {
      const content = fs.readFileSync(absolute, 'utf8');
      out.tokens = estimateTokens(content);
    } else {
      out.tokens = Math.ceil(out.bytes / 4);
    }
  } catch {
    // Keep defaults.
  }

  return out;
}

export function scanProject(projectRoot, config = {}) {
  const files = [];
  let totalTokens = 0;
  let scannedFiles = 0;

  walk(projectRoot, absolute => {
    const r = normalizeRel(rel(projectRoot, absolute));
    if (shouldSkipScan(r, config)) return;
    if (!looksTextFile(absolute)) return;

    let content = '';
    try {
      const stat = fs.statSync(absolute);
      if (stat.size > 2 * 1024 * 1024) return;
      content = fs.readFileSync(absolute, 'utf8');
    } catch {
      return;
    }

    const tokens = estimateTokens(content);
    scannedFiles += 1;
    totalTokens += tokens;
    files.push({ path: r, tokens });
  });

  return {
    totalTokens,
    scannedFiles,
    files: files.sort((a, b) => b.tokens - a.tokens)
  };
}

export function trimBashOutput(stdout = '', stderr = '', config = {}) {
  const maxLines = Number(config.thresholds?.bashOutputMaxLines || 140);
  const combined = [stdout, stderr].filter(Boolean).join('\n');
  const originalTokens = estimateTokens(combined);
  const lines = combined.split(/\r?\n/);

  const deduped = dedupeRepeatedLines(lines);
  const useful = pickUsefulLines(deduped.lines);

  let finalLines = deduped.lines;
  let changed = deduped.changed;

  if (deduped.lines.length > maxLines) {
    const headCount = Math.max(30, Math.floor(maxLines * 0.35));
    const tailCount = Math.max(30, Math.floor(maxLines * 0.35));
    const head = deduped.lines.slice(0, headCount);
    const tail = deduped.lines.slice(-tailCount);
    const usefulMiddle = useful.filter(line => !head.includes(line) && !tail.includes(line)).slice(0, maxLines - head.length - tail.length);
    const omitted = Math.max(0, deduped.lines.length - head.length - tail.length - usefulMiddle.length);

    finalLines = [
      ...head,
      `[Token Guard: ${omitted.toLocaleString('en-US')} middle lines omitted; preserved head/tail and error/failure signals]`,
      ...usefulMiddle,
      ...tail
    ];
    changed = true;
  }

  const output = finalLines.join('\n');
  const trimmedTokens = estimateTokens(output);

  if (!changed && trimmedTokens >= originalTokens) {
    return {
      changed: false,
      stdout,
      stderr,
      originalTokens,
      trimmedTokens: originalTokens,
      omittedLines: 0
    };
  }

  return {
    changed: true,
    stdout: `Token Guard: trimmed noisy Bash output.\n${output}`,
    stderr: '',
    originalTokens,
    trimmedTokens,
    omittedLines: Math.max(0, lines.length - finalLines.length)
  };
}

export function summarizeCommandOutput(output = '', options = {}) {
  const maxChars = Number(options.maxChars || 12000);
  const trimmed = trimBashOutput(output, '', { thresholds: { bashOutputMaxLines: options.maxLines || 140 } });
  const text = trimmed.changed ? trimmed.stdout : String(output || '');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[Token Guard: cached output clipped]` : text;
}

function dedupeRepeatedLines(lines) {
  const counts = new Map();
  const normalized = line => line.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const out = [];
  let changed = false;

  for (const line of lines) {
    const key = normalized(line);
    const count = counts.get(key) || 0;
    counts.set(key, count + 1);
    if (key && count >= 3) {
      changed = true;
      continue;
    }
    out.push(line);
  }

  const repeated = [...counts.entries()].filter(([, count]) => count > 3).slice(0, 20);
  if (repeated.length) {
    out.push('');
    out.push('[Token Guard: repeated output deduped]');
    for (const [line, count] of repeated) {
      out.push(`- repeated ${count}x: ${line.slice(0, 180)}`);
    }
  }

  return { lines: out, changed };
}

function pickUsefulLines(lines) {
  const re = /(error|failed|failure|exception|traceback|expected|received|assert|panic|fatal|timeout|not found|undefined|cannot|warning|denied|exit code|compilation failed)/i;
  return lines.filter(line => re.test(line)).slice(0, 80);
}

function shouldSkipScan(relPath, config) {
  const p = normalizeRel(relPath);
  return p.startsWith('.git/') || isAlwaysAllowed(p, config) || isAlwaysGuarded(p, config);
}

function walk(dir, visit) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['.git', 'node_modules', 'TokenGuard', '.token-guard'].includes(entry.name)) continue;
      walk(absolute, visit);
    } else if (entry.isFile()) {
      visit(absolute);
    }
  }
}

function normalizeRel(value) {
  return String(value || '').replaceAll(path.sep, '/').replace(/^\.\//, '');
}

function matchesPattern(relPath, pattern) {
  const p = normalizeRel(pattern);
  if (!p) return false;
  if (p.endsWith('/')) return relPath === p.slice(0, -1) || relPath.startsWith(p);
  if (p.startsWith('.')) return relPath.endsWith(p);
  return relPath === p || relPath.includes(p) || relPath.startsWith(p);
}
