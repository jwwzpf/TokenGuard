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
  const out = path.join(paths.largeFileSummaries
