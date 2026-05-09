import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, ensureProjectFiles, rel, readJson, writeJson } from './project.js';
import { estimateTokens, looksTextFile, isAlwaysAllowed, isAlwaysGuarded, hashText } from './token-utils.js';
import { appendEvent } from './ledger.js';

const DEFAULT_MAX_READ_TOKENS = 6000;
const DEFAULT_SYMBOL_CONTEXT_LINES = 30;

export function buildSymbolIndex(projectRoot = process.cwd(), config = {}) {
  const paths = ensureProjectFiles(projectRoot);
  ensureDir(paths.index);
  const files = [];
  const symbols = [];

  walk(projectRoot, absolute => {
    const relPath = rel(projectRoot, absolute);
    if (shouldSkip(projectRoot, relPath, absolute, config)) return;
    if (!looksTextFile(absolute)) return;
    const content = safeRead(absolute, 2 * 1024 * 1024);
    const fileSymbols = extractSymbols(content, relPath);
    files.push({ path: relPath, tokens: estimateTokens(content), symbols: fileSymbols.length });
    symbols.push(...fileSymbols);
  });

  const model = {
    generatedAt: new Date().toISOString(),
    version: 1,
    files: files.sort((a, b) => b.tokens - a.tokens),
    symbols: symbols.sort((a, b) => a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file))
  };
  fs.writeFileSync(paths.symbolsJson, `${JSON.stringify(model, null, 2)}\n`);
  return model;
}

export function loadSymbolIndex(projectRoot = process.cwd()) {
  const paths = ensureProjectFiles(projectRoot);
  try { return JSON.parse(fs.readFileSync(paths.symbolsJson, 'utf8')); } catch { return null; }
}

export function findSymbols(projectRoot = process.cwd(), query = '', options = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  let index = loadSymbolIndex(projectRoot);
  if (!index || options.rebuild) index = buildSymbolIndex(projectRoot, options.config || {});
  const results = [];
  for (const symbol of index.symbols || []) {
    const name = String(symbol.name || '').toLowerCase();
    const file = String(symbol.file || '').toLowerCase();
    const signature = String(symbol.signature || '').toLowerCase();
    let score = 0;
    if (name === q) score += 100;
    if (name.startsWith(q)) score += 60;
    if (name.includes(q)) score += 35;
    if (signature.includes(q)) score += 20;
    if (file.includes(q)) score += 10;
    if (score > 0) results.push({ ...symbol, score });
  }
  return results.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line).slice(0, Number(options.limit || 20));
}

export function smartRead(projectRoot = process.cwd(), filePath, options = {}) {
  ensureProjectFiles(projectRoot);
  if (!filePath) throw new Error('Missing file path.');
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  if (!fs.existsSync(absolute)) throw new Error(`File not found: ${filePath}`);
  const relPath = rel(projectRoot, absolute);
  const content = fs.readFileSync(absolute, 'utf8');
  const lines = content.split(/\r?\n/);
  const maxTokens = Number(options.maxTokens || DEFAULT_MAX_READ_TOKENS);
  const contextLines = Number(options.contextLines || DEFAULT_SYMBOL_CONTEXT_LINES);

  if (options.diff) return diffRead(projectRoot, relPath, content, maxTokens);
  if (options.lines) {
    const range = parseLineRange(options.lines);
    return makeSnippetResult({ kind: 'lines', file: relPath, content, lines, startLine: range.start, endLine: range.end, reason: `explicit line range ${range.start}:${range.end}`, maxTokens });
  }
  if (options.around) return readAroundText(projectRoot, relPath, content, lines, options.around, Number(options.context || options.contextLines || 10), maxTokens);
  if (options.symbol || options.focus) {
    const requested = options.symbol || options.focus;
    const symbols = extractSymbols(content, relPath);
    const match = findBestSymbolMatch(symbols, requested);
    if (!match) return { kind: 'symbol-not-found', file: relPath, requested, text: `Token Guard could not find symbol "${requested}" in ${relPath}.\n\nKnown symbols:\n${symbols.slice(0, 60).map(s => `- ${s.name} (${s.kind}) at line ${s.line}`).join('\n') || '- none detected'}\n`, originalTokens: estimateTokens(content), returnedTokens: 0 };
    const range = findSymbolRange(lines, symbols, match, contextLines);
    return makeSnippetResult({ kind: 'symbol', file: relPath, content, lines, startLine: range.start, endLine: range.end, reason: `symbol ${match.name}`, maxTokens, meta: { symbol: match } });
  }
  if (options.section) {
    const section = findSection(lines, options.section);
    if (!section) return { kind: 'section-not-found', file: relPath, requested: options.section, text: `Token Guard could not find section/key "${options.section}" in ${relPath}.\n\nTip: use --lines A:B, --around TEXT, or --symbol NAME for targeted reads.\n`, originalTokens: estimateTokens(content), returnedTokens: 0 };
    return makeSnippetResult({ kind: 'section', file: relPath, content, lines, startLine: section.start, endLine: section.end, reason: `section ${options.section}`, maxTokens, meta: { section } });
  }

  const totalTokens = estimateTokens(content);
  if (totalTokens <= maxTokens) return { kind: 'full', file: relPath, startLine: 1, endLine: lines.length, originalTokens: totalTokens, returnedTokens: totalTokens, text: addLineNumbers(lines, 1) };
  return makeLargeFilePreview(relPath, content, lines, maxTokens);
}

export function summarizeFile(projectRoot = process.cwd(), filePath, options = {}) {
  const paths = ensureProjectFiles(projectRoot);
  if (!filePath) throw new Error('Missing file path.');
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  if (!fs.existsSync(absolute)) throw new Error(`File not found: ${filePath}`);
  ensureDir(paths.largeFileSummaries);
  const relPath = rel(projectRoot, absolute);
  const content = fs.readFileSync(absolute, 'utf8');
  const lines = content.split(/\r?\n/);
  const symbols = extractSymbols(content, relPath);
  const sections = extractMarkdownSections(lines);
  const summary = `# Token Guard File Summary\n\nFile: ${relPath}\nGenerated: ${new Date().toISOString()}\n\n## Size\n\n- Lines: ${lines.length.toLocaleString('en-US')}\n- Estimated tokens: ${estimateTokens(content).toLocaleString('en-US')}\n\n## Detected Symbols\n\n${symbols.length ? symbols.slice(0, 120).map(s => `- ${s.kind} \`${s.name}\` at line ${s.line}: ${s.signature}`).join('\n') : 'No symbols detected.'}\n\n## Detected Markdown Sections\n\n${sections.length ? sections.slice(0, 80).map(s => `- line ${s.line}: ${s.title}`).join('\n') : 'No Markdown sections detected.'}\n\n## Suggested Targeted Reads\n\n\`\`\`bash\ntg ctx ${shellQuote(relPath)}\n${symbols.slice(0, 8).map(s => `tg ctx ${shellQuote(relPath)} --focus ${shellQuote(s.name)}`).join('\n')}\ntg ctx ${shellQuote(relPath)} --around <text> --context 10\n\`\`\`\n\n## Preview\n\n\`\`\`text\n${lines.slice(0, 80).join('\n')}\n${lines.length > 80 ? `\n... ${lines.length - 80} more lines omitted ...` : ''}\n\`\`\`\n`;
  const out = path.join(paths.largeFileSummaries, `${sanitizeFileName(relPath)}.md`);
  fs.writeFileSync(out, summary);
  return { file: relPath, summaryPath: out, symbols: symbols.length, sections: sections.length, tokens: estimateTokens(content) };
}

export function formatSmartReadResult(result) {
  const header = ['Token Guard targeted read', `File: ${result.file}`, result.kind ? `Kind: ${result.kind}` : '', result.startLine && result.endLine ? `Lines: ${result.startLine}:${result.endLine}` : '', result.originalTokens != null ? `Original estimate: ${format(result.originalTokens)} tokens` : '', result.returnedTokens != null ? `Returned estimate: ${format(result.returnedTokens)} tokens` : ''].filter(Boolean).join('\n');
  return `${header}\n\n${result.text || ''}`;
}

export function formatFindResults(results) { return results.length ? results.map(row => `${row.file}:${row.line}  ${row.kind} ${row.name}  ${row.signature}`).join('\n') : 'No matching symbols found. Try `token-guard index` first, or search with a shorter query.'; }

function diffRead(projectRoot, relPath, content, maxTokens) {
  const paths = ensureProjectFiles(projectRoot);
  const snapshots = readJson(paths.fileSnapshots, {});
  const currentHash = hashText(content);
  const previous = snapshots[relPath];
  snapshots[relPath] = { hash: currentHash, content: content.slice(0, 500000), ts: new Date().toISOString() };
  writeJson(paths.fileSnapshots, snapshots);

  if (!previous) return { kind: 'diff-first-read', file: relPath, originalTokens: estimateTokens(content), returnedTokens: 0, text: 'No previous snapshot. Snapshot saved for future diff-only reads.' };
  if (previous.hash === currentHash) {
    const saved = estimateTokens(content);
    appendEvent(projectRoot, { type: 'diff_read_saved', file: relPath, savedTokens: saved });
    return { kind: 'diff-unchanged', file: relPath, originalTokens: saved, returnedTokens: 12, text: `Unchanged since ${previous.ts}. Full reread avoided.` };
  }
  const text = buildSimpleDiff(previous.content || '', content, maxTokens);
  const saved = Math.max(0, estimateTokens(content) - estimateTokens(text));
  appendEvent(projectRoot, { type: 'diff_read_saved', file: relPath, savedTokens: saved });
  return { kind: 'diff', file: relPath, originalTokens: estimateTokens(content), returnedTokens: estimateTokens(text), text };
}

function buildSimpleDiff(oldText, newText, maxTokens) {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  const hunks = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i += 1) {
    if (oldLines[i] !== newLines[i]) {
      const start = Math.max(0, i - 3);
      const end = Math.min(newLines.length, i + 8);
      hunks.push(`@@ lines ${start + 1}-${end} @@\n${newLines.slice(start, end).map((line, idx) => `${String(start + idx + 1).padStart(5, ' ')} | ${line}`).join('\n')}`);
      i = end;
    }
    if (hunks.length >= 20) break;
  }
  let out = hunks.join('\n\n') || 'Changed, but no simple line hunks could be produced.';
  while (estimateTokens(out) > maxTokens && hunks.length > 1) {
    hunks.pop();
    out = hunks.join('\n\n') + '\n\n[Token Guard: diff clipped]';
  }
  return out;
}

function readAroundText(projectRoot, relPath, content, lines, query, context, maxTokens) {
  const q = String(query || '');
  const idx = lines.findIndex(line => line.includes(q));
  if (idx < 0) return { kind: 'around-not-found', file: relPath, requested: q, text: `Token Guard could not find text "${q}" in ${relPath}.`, originalTokens: estimateTokens(content), returnedTokens: 0 };
  const start = Math.max(1, idx + 1 - context);
  const end = Math.min(lines.length, idx + 1 + context);
  return makeSnippetResult({ kind: 'around', file: relPath, content, lines, startLine: start, endLine: end, reason: `around ${q}`, maxTokens, meta: { around: q } });
}

function extractSymbols(content, relPath) {
  const lines = String(content || '').split(/\r?\n/);
  const ext = path.extname(relPath).toLowerCase();
  const symbols = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    for (const pattern of symbolPatternsForExtension(ext)) {
      const match = trimmed.match(pattern.re);
      if (!match) continue;
      const name = match[pattern.nameIndex || 1];
      if (!name) continue;
      symbols.push({ file: relPath, line: i + 1, kind: pattern.kind, name, signature: trimmed.slice(0, 240) });
      break;
    }
  }
  return symbols;
}

function symbolPatternsForExtension(ext) {
  const common = [
    { kind: 'class', re: /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'interface', re: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'enum', re: /^(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'function', re: /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/ },
    { kind: 'function', re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?/ },
    { kind: 'method', re: /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[{=>]/ }
  ];
  if (ext === '.py') return [{ kind: 'class', re: /^class\s+([A-Za-z_]\w*)/ }, { kind: 'function', re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/ }];
  if (ext === '.go') return [{ kind: 'function', re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/ }, { kind: 'type', re: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/ }];
  if (ext === '.rs') return [{ kind: 'function', re: /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(/ }, { kind: 'struct', re: /^(?:pub\s+)?struct\s+([A-Za-z_]\w*)/ }, { kind: 'enum', re: /^(?:pub\s+)?enum\s+([A-Za-z_]\w*)/ }, { kind: 'trait', re: /^(?:pub\s+)?trait\s+([A-Za-z_]\w*)/ }];
  if (['.java', '.kt', '.kts', '.swift', '.dart', '.php', '.cs'].includes(ext)) return [
    { kind: 'class', re: /^(?:public\s+|private\s+|protected\s+|internal\s+|abstract\s+|final\s+|sealed\s+|open\s+)*class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'interface', re: /^(?:public\s+|private\s+|protected\s+|internal\s+)*interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'enum', re: /^(?:public\s+|private\s+|protected\s+|internal\s+)*enum\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'function', re: /^(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|override\s+|async\s+|Future<[^>]+>\s+|Future\s+|void\s+|String\s+|int\s+|double\s+|bool\s+|Widget\s+|var\s+|dynamic\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:async\s*)?[{=>]/ }
  ];
  return common;
}

function findBestSymbolMatch(symbols, query) { const q = String(query || '').trim().toLowerCase(); return symbols.find(s => s.name.toLowerCase() === q) || symbols.find(s => s.name.toLowerCase().startsWith(q)) || symbols.find(s => s.name.toLowerCase().includes(q)); }
function findSymbolRange(lines, symbols, match, contextLines) {
  const next = symbols.filter(s => s.line > match.line).sort((a, b) => a.line - b.line)[0];
  let end = next ? next.line - 1 : Math.min(lines.length, match.line + contextLines * 2);
  end = expandBraceRange(lines, match.line, end);
  return { start: Math.max(1, match.line - contextLines), end: Math.min(lines.length, end + Math.floor(contextLines / 2)) };
}
function expandBraceRange(lines, startLine, fallbackEnd) { let depth = 0; let seen = false; for (let i = startLine - 1; i < lines.length; i += 1) { for (const ch of lines[i]) { if (ch === '{') { depth += 1; seen = true; } if (ch === '}') depth -= 1; } if (seen && depth <= 0 && i > startLine - 1) return i + 1; if (i + 1 > fallbackEnd + 200) break; } return fallbackEnd; }
function parseLineRange(value) { const match = String(value || '').match(/^(\d+)(?::|-|,)(\d+)$/); if (!match) throw new Error(`Invalid line range "${value}". Use A:B, for example 120:180.`); const start = Math.max(1, Number(match[1])); const end = Math.max(start, Number(match[2])); return { start, end }; }
function makeSnippetResult({ kind, file, content, lines, startLine, endLine, reason, maxTokens, meta = {} }) { let start = Math.max(1, startLine); let end = Math.min(lines.length, endLine); let snippetLines = lines.slice(start - 1, end); let text = addLineNumbers(snippetLines, start); let returnedTokens = estimateTokens(text); if (returnedTokens > maxTokens) { const allowedLines = Math.max(20, Math.floor(snippetLines.length * (maxTokens / returnedTokens))); snippetLines = snippetLines.slice(0, allowedLines); end = start + snippetLines.length - 1; text = addLineNumbers(snippetLines, start) + `\n\n[Token Guard: snippet clipped to stay near ${format(maxTokens)} tokens. Use --lines for a narrower range.]`; returnedTokens = estimateTokens(text); } return { kind, file, startLine: start, endLine: end, reason, originalTokens: estimateTokens(content), returnedTokens, text, ...meta }; }
function makeLargeFilePreview(file, content, lines, maxTokens) { const headCount = 80; const tailCount = 60; const head = lines.slice(0, headCount); const tailStart = Math.max(headCount, lines.length - tailCount); const tail = lines.slice(tailStart); const text = addLineNumbers(head, 1) + `\n\n[Token Guard: ${Math.max(0, lines.length - head.length - tail.length).toLocaleString('en-US')} middle lines omitted. Use --focus, --around, or --lines for targeted context.]\n\n` + addLineNumbers(tail, tailStart + 1); return { kind: 'large-preview', file, startLine: 1, endLine: lines.length, originalTokens: estimateTokens(content), returnedTokens: estimateTokens(text), text: `Large file preview. Full read would cost ~${format(estimateTokens(content))} tokens.\nSuggested alternatives:\n- tg ctx ${shellQuote(file)} --focus SYMBOL\n- tg ctx ${shellQuote(file)} --around TEXT --context 10\n- tg ctx ${shellQuote(file)} --lines A:B\n\n${text}` }; }
function findSection(lines, query) { const q = String(query || '').trim().toLowerCase(); if (!q) return null; const sections = extractMarkdownSections(lines); const md = sections.find(section => section.title.toLowerCase().includes(q)); if (md) { const next = sections.find(section => section.line > md.line && section.level <= md.level); return { type: 'markdown', title: md.title, start: md.line, end: next ? next.line - 1 : lines.length }; } const lineIndex = lines.findIndex(line => line.toLowerCase().includes(q)); return lineIndex >= 0 ? { type: 'text-match', title: query, start: Math.max(1, lineIndex + 1 - 25), end: Math.min(lines.length, lineIndex + 1 + 60) } : null; }
function extractMarkdownSections(lines) { const sections = []; for (let i = 0; i < lines.length; i += 1) { const match = lines[i].match(/^(#{1,6})\s+(.+)$/); if (match) sections.push({ line: i + 1, level: match[1].length, title: match[2].trim() }); } return sections; }
function addLineNumbers(lines, startLine) { return lines.map((line, idx) => `${String(startLine + idx).padStart(5, ' ')} | ${line}`).join('\n'); }
function shouldSkip(projectRoot, relPath, absolute, config) { if (relPath.startsWith('.git/')) return true; if (relPath.startsWith('TokenGuard/') || relPath.startsWith('.token-guard/')) return true; if (relPath.includes('/node_modules/')) return true; if (isAlwaysAllowed(relPath, config) || isAlwaysGuarded(relPath, config)) return true; try { const stat = fs.statSync(absolute); return !stat.isFile() || stat.size > 2 * 1024 * 1024; } catch { return true; } }
function walk(dir, visit) { let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const entry of entries) { const absolute = path.join(dir, entry.name); if (entry.isDirectory()) { if (['.git', 'node_modules', 'TokenGuard', '.token-guard'].includes(entry.name)) continue; walk(absolute, visit); } else if (entry.isFile()) visit(absolute); } }
function safeRead(file, maxBytes) { const stat = fs.statSync(file); return fs.readFileSync(file, 'utf8').slice(0, Math.min(stat.size, maxBytes)); }
function sanitizeFileName(value) { return String(value || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180); }
function shellQuote(value) { const s = String(value || ''); return /^[a-zA-Z0-9_./:-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`; }
function format(n) { return Math.round(Number(n || 0)).toLocaleString('en-US'); }
