import fs from 'node:fs';
import path from 'node:path';
import { rel } from './project.js';

const TEXT_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.yml', '.yaml', '.html', '.css', '.scss',
  '.py', '.java', '.kt', '.kts', '.go', '.rs', '.swift', '.dart', '.php', '.rb', '.sh', '.zsh', '.bash', '.sql', '.xml', '.txt', '.env'
]);

export function estimateTokens(textOrBytes) {
  if (typeof textOrBytes === 'number') return Math.ceil(textOrBytes / 4);
  if (!textOrBytes) return 0;
  return Math.ceil(String(textOrBytes).length / 4);
}

export function normalizeRelPath(filePath, projectRoot = process.cwd()) {
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  return rel(projectRoot, absolute);
}

export function isAlwaysAllowed(relPath, config) {
  return matchesAny(relPath, config.patterns?.alwaysAllow || []);
}

export function isAlwaysGuarded(relPath, config) {
  return matchesAny(relPath, config.patterns?.alwaysGuard || []);
}

export function matchesAny(relPath, patterns = []) {
  const p = relPath.split(path.sep).join('/');
  return patterns.some((pattern) => {
    if (!pattern) return false;
    if (pattern.endsWith('/')) return p.startsWith(pattern) || p.includes(`/${pattern}`);
    return p === pattern || p.includes(pattern);
  });
}

export function looksTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

export function safeReadText(filePath, maxBytes = 1024 * 1024) {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) return fs.readFileSync(filePath, 'utf8').slice(0, maxBytes);
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

export function scanProject(projectRoot, config) {
  const files = [];
  let scannedFiles = 0;
  walk(projectRoot, (absolute) => {
    const rp = rel(projectRoot, absolute);
    if (shouldSkipScan(rp, config)) return;
    if (!looksTextFile(absolute)) return;
    const tokens = fileTokenEstimate(absolute);
    if (tokens <= 0) return;
    scannedFiles += 1;
    files.push({ path: rp, tokens });
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
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'TokenGuard' || entry.name === '.token-guard') continue;
      walk(absolute, visit);
    } else if (entry.isFile()) {
      visit(absolute);
    }
  }
}

export function extractRelevantLogLines(text, maxLines = 140) {
  const lines = String(text || '').split(/\r?\n/);
  const keywords = /(error|fail|failed|failure|exception|traceback|expected|received|actual|assert|panic|fatal|denied|cannot|not found|undefined|segmentation|timeout)/i;
  const picked = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (keywords.test(lines[i])) {
      const start = Math.max(0, i - 3);
      const end = Math.min(lines.length, i + 5);
      for (let j = start; j < end; j += 1) picked.push({ n: j + 1, line: lines[j] });
    }
  }
  const unique = [];
  const seen = new Set();
  for (const row of picked) {
    const key = `${row.n}:${row.line}`;
    if (!seen.has(key)) {
      unique.push(row);
      seen.add(key);
    }
    if (unique.length >= maxLines) break;
  }
  if (unique.length === 0) {
    const head = lines.slice(0, 50).map((line, idx) => ({ n: idx + 1, line }));
    const tailStart = Math.max(50, lines.length - 50);
    const tail = lines.slice(tailStart).map((line, idx) => ({ n: tailStart + idx + 1, line }));
    return { rows: [...head, ...tail], omitted: Math.max(0, lines.length - head.length - tail.length) };
  }
  return { rows: unique, omitted: Math.max(0, lines.length - unique.length) };
}
