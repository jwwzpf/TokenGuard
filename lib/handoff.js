import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureProjectFiles, rel } from './project.js';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_HANDOFF_LINES = 220;
const MAX_HANDOFF_CHARS = 14000;
const MAX_GOAL_CHARS = 700;
const MAX_ASSISTANT_CHARS = 600;
const MAX_FILES_READ = 20;
const MAX_FILES_TOUCHED = 20;
const MAX_COMMANDS = 12;
const MAX_TESTS = 8;
const MAX_FAILURES = 10;
const MAX_TOOL_SIGNALS = 18;
const MAX_COMMAND_CHARS = 180;
const MAX_FAILURE_CHARS = 220;

export function updateHandoffFromTranscript(projectRoot = process.cwd(), input = {}, options = {}) {
  const paths = ensureProjectFiles(projectRoot);
  const transcriptPath = expandHome(input.transcript_path || input.transcriptPath);
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return { updated: false, reason: 'missing_transcript_path', transcriptPath: transcriptPath || null };

  const records = readJsonlTail(transcriptPath, options.maxBytes || DEFAULT_MAX_BYTES);
  const summary = summarizeTranscript(projectRoot, records);
  if (!hasMeaningfulSummary(summary)) return { updated: false, reason: 'empty_summary', transcriptPath };

  let content = renderHandoff(summary, { source: options.source || input.hook_event_name || input.hookEventName || 'unknown', reason: input.reason || input.trigger || '', transcriptPath });
  content = enforceHandoffBudget(content);
  const previous = fs.existsSync(paths.handoff) ? fs.readFileSync(paths.handoff, 'utf8') : '';
  if (previous === content) return { updated: false, reason: 'unchanged', transcriptPath, filesTouched: summary.filesTouched.length, commandsRun: summary.commandsRun.length, failures: summary.failures.length };
  fs.writeFileSync(paths.handoff, content);
  return { updated: true, reason: 'updated', transcriptPath, filesTouched: summary.filesTouched.length, filesRead: summary.filesRead.length, commandsRun: summary.commandsRun.length, testsRun: summary.testsRun.length, failures: summary.failures.length, handoffLines: content.split(/\r?\n/).length, handoffChars: content.length };
}

export function summarizeTranscript(projectRoot, records) {
  const state = { lastUserPrompt: '', lastAssistantText: '', filesRead: new Set(), filesTouched: new Set(), commandsRun: [], testsRun: [], failures: [], toolsSeen: [] };
  for (const record of records) scanRecord(projectRoot, record, state);
  const commandsRun = dedupe(state.commandsRun).map(summarizeCommand).filter(Boolean).slice(-MAX_COMMANDS);
  const testsRun = dedupe(state.testsRun).map(summarizeCommand).filter(Boolean).slice(-MAX_TESTS);
  return {
    lastUserPrompt: truncate(cleanText(state.lastUserPrompt), MAX_GOAL_CHARS),
    lastAssistantText: truncate(cleanText(state.lastAssistantText), MAX_ASSISTANT_CHARS),
    filesRead: [...state.filesRead].slice(-MAX_FILES_READ),
    filesTouched: [...state.filesTouched].slice(-MAX_FILES_TOUCHED),
    commandsRun,
    testsRun,
    failures: dedupe(state.failures).map(line => truncate(cleanFailureLine(line), MAX_FAILURE_CHARS)).filter(Boolean).slice(-MAX_FAILURES),
    toolsSeen: dedupe(state.toolsSeen).slice(-MAX_TOOL_SIGNALS)
  };
}

function scanRecord(projectRoot, record, state) {
  const message = record.message || record;
  if (message.role === 'user') {
    const text = extractTextContent(message.content);
    if (text && !looksLikeToolResult(text)) state.lastUserPrompt = text;
  }
  if (message.role === 'assistant') {
    const text = extractTextContent(message.content);
    if (text) state.lastAssistantText = text;
  }
  scanAny(projectRoot, record, state, 0);
}

function scanAny(projectRoot, value, state, depth) {
  if (depth > 8 || value == null) return;
  if (typeof value === 'string') { collectFailureLines(value, state); return; }
  if (Array.isArray(value)) { for (const item of value) scanAny(projectRoot, item, state, depth + 1); return; }
  if (typeof value !== 'object') return;

  const toolName = value.tool_name || value.toolName || value.name;
  const maybeInput = value.tool_input || value.toolInput || value.input || value.parameters || value.args;
  if (toolName && maybeInput && typeof maybeInput === 'object') collectToolUse(projectRoot, toolName, maybeInput, state);
  if (value.type === 'tool_use' && value.name && value.input) collectToolUse(projectRoot, value.name, value.input, state);
  if (value.type === 'tool_result') collectFailureLines(extractTextContent(value.content), state);
  for (const child of Object.values(value)) scanAny(projectRoot, child, state, depth + 1);
}

function collectToolUse(projectRoot, toolName, input, state) {
  state.toolsSeen.push(String(toolName));
  const filePath = input.file_path || input.path || input.notebook_path;
  if (filePath) {
    const normalized = normalizeProjectPath(projectRoot, filePath);
    if (toolName === 'Read') state.filesRead.add(normalized);
    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) state.filesTouched.add(normalized);
  }
  if (toolName === 'Bash' && input.command) {
    const command = sanitizeCommand(String(input.command).trim());
    if (command) {
      state.commandsRun.push(command);
      if (looksLikeTestCommand(command)) state.testsRun.push(command);
    }
  }
}

function collectFailureLines(text, state) {
  if (!text) return;
  const cleaned = stripHugeBlocks(String(text));
  const lines = cleaned.split(/\r?\n/);
  const re = /(error|failed|failure|exception|traceback|expected|received|assert|panic|fatal|timeout|not found|undefined|cannot|denied|exit code|compilation failed)/i;
  for (const line of lines) {
    const trimmed = cleanFailureLine(line);
    if (trimmed.length < 4) continue;
    if (!re.test(trimmed)) continue;
    if (looksLikeLongCodeLine(trimmed)) continue;
    state.failures.push(trimmed.slice(0, MAX_FAILURE_CHARS));
  }
}

function renderHandoff(summary, meta) {
  return `# Next Session Handoff\n\nGenerated: ${new Date().toISOString()}\nGenerated by: Token Guard\nHook source: ${meta.source}${meta.reason ? ` (${meta.reason})` : ''}\n\n## Current Goal\n\n${bulletOrFallback([summary.lastUserPrompt], 'Unknown. Re-read the latest user request if needed.')}\n\n## Compact State\n\n${summary.filesTouched.length ? `The previous session touched ${summary.filesTouched.length} file(s). Start with "Files Touched" and avoid re-reading unrelated large files.` : 'No Write/Edit/MultiEdit activity detected in the captured transcript window.'}\n\n${summary.failures.length ? `There were ${summary.failures.length} failure/error signal(s). Check "Failure Signals" before rerunning broad commands.` : 'No explicit failure signal detected.'}\n\n## Files Touched\n\n${bulletOrFallback(summary.filesTouched)}\n\n## Files Read\n\n${bulletOrFallback(summary.filesRead)}\n\n## Commands Run\n\n${bulletOrFallback(summary.commandsRun)}\n\n## Tests Run\n\n${bulletOrFallback(summary.testsRun)}\n\n## Failure Signals\n\n${bulletOrFallback(summary.failures, 'No explicit error/failure lines detected in the captured transcript window.')}\n\n## Next Smallest Task\n\n- Continue from the current goal above.\n- Inspect "Files Touched" first.\n- Prefer narrow Read windows before Edit.\n- Avoid reading generated/build/dependency/log files unless the user explicitly asks.\n- If a full read is genuinely needed, use \`@tg:force-read <file>\` or \`token-guard allow <file> --once\`.\n\n## Do Not Re-investigate\n\n- Do not replay long Bash/Python heredoc commands from the previous session.\n- Do not re-run broad grep scans unless a targeted read is insufficient.\n- This handoff is intentionally compressed; use git status/diff for exact working tree state.\n\n## Tool Signals\n\n${bulletOrFallback(summary.toolsSeen)}\n`;
}

function sanitizeCommand(command) {
  let c = String(command || '').trim().replace(/\r/g, '');
  if (!c) return '';
  if (containsHeredoc(c)) return `${truncate(c.split('\n')[0].trim(), 120)}  [heredoc/script body omitted, sha=${shortHash(c)}]`;
  if (c.split('\n').length > 3) return `${truncate(c.split('\n')[0].trim(), 140)}  [${c.split('\n').length} command lines omitted, sha=${shortHash(c)}]`;
  c = stripHugeBlocks(c).replace(/\s+/g, ' ').trim();
  if (looksLikePythonReadTextDump(c)) return `${truncate(c, 120)}  [possible full-file fallback read]`;
  return truncate(c, MAX_COMMAND_CHARS);
}

function summarizeCommand(command) {
  const c = sanitizeCommand(command);
  if (!c) return '';
  if (/npm\s+test|pnpm\s+test|yarn\s+test|pytest|flutter\s+test|gradle\s+test|mvn\s+test|vitest|jest/i.test(c)) return `test: ${c}`;
  if (/git\s+status/i.test(c)) return 'git status';
  if (/git\s+diff/i.test(c)) return truncate(c, MAX_COMMAND_CHARS);
  if (/\brg\b|\bgrep\b/i.test(c)) return `search: ${truncate(c, MAX_COMMAND_CHARS - 8)}`;
  if (/python|python3|node\s+-e|ruby|perl/i.test(c) && /read_text|open\(|readFileSync|fs\.readFile/i.test(c)) return `${truncate(c, 120)}  [fallback file-read command summarized]`;
  return c;
}
function containsHeredoc(command) { return /<<\s*['"]?[A-Za-z0-9_-]+['"]?/.test(command); }
function stripHugeBlocks(text) { return String(text || '').replace(/```[\s\S]*?```/g, '[code block omitted]').replace(/<<\s*['"]?([A-Za-z0-9_-]+)['"]?[\s\S]*?\n\1\b/g, '[heredoc omitted]').replace(/python\s+[-\w]*\s*<<[\s\S]*$/i, 'python heredoc [script body omitted]').replace(/node\s+[-\w]*\s*<<[\s\S]*$/i, 'node heredoc [script body omitted]'); }
function looksLikePythonReadTextDump(text) { return /read_text\(|Path\(.+\)\.read_text|open\(.+\)\.read\(/.test(String(text || '')); }
function looksLikeLongCodeLine(line) { const s = String(line || ''); return s.length > 240 || /^\s*(const|let|var|function|class|def|import|export)\s+/.test(s) && s.length > 140 || /[{}();]/.test(s) && s.length > 180; }
function cleanFailureLine(line) { return String(line || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim(); }
function enforceHandoffBudget(content) { let out = String(content || '').trimEnd() + '\n'; const lines = out.split(/\r?\n/); if (lines.length > MAX_HANDOFF_LINES) out = lines.slice(0, MAX_HANDOFF_LINES).join('\n') + `\n\n[Token Guard: handoff clipped from ${lines.length} to ${MAX_HANDOFF_LINES} lines to protect fresh-session context.]\n`; if (out.length > MAX_HANDOFF_CHARS) out = out.slice(0, MAX_HANDOFF_CHARS) + `\n\n[Token Guard: handoff clipped to ${MAX_HANDOFF_CHARS.toLocaleString('en-US')} chars to protect fresh-session context.]\n`; return out; }
function hasMeaningfulSummary(summary) { return Boolean(summary.lastUserPrompt || summary.filesRead.length || summary.filesTouched.length || summary.commandsRun.length || summary.failures.length); }
function readJsonlTail(file, maxBytes) { const stat = fs.statSync(file); const start = Math.max(0, stat.size - maxBytes); const length = stat.size - start; const fd = fs.openSync(file, 'r'); try { const buffer = Buffer.alloc(length); fs.readSync(fd, buffer, 0, length, start); let text = buffer.toString('utf8'); if (start > 0) { const firstNewline = text.indexOf('\n'); text = firstNewline >= 0 ? text.slice(firstNewline + 1) : text; } return text.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); } finally { fs.closeSync(fd); } }
function extractTextContent(content) { if (!content) return ''; if (typeof content === 'string') return content; if (Array.isArray(content)) return content.map(item => { if (!item) return ''; if (typeof item === 'string') return item; if (item.type === 'text' && item.text) return item.text; if (item.type === 'tool_result') return extractTextContent(item.content); return ''; }).filter(Boolean).join('\n'); if (typeof content === 'object') { if (content.text) return String(content.text); if (content.content) return extractTextContent(content.content); } return ''; }
function normalizeProjectPath(projectRoot, filePath) { const absolute = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath); const relative = rel(projectRoot, absolute); return relative.startsWith('..') ? filePath : relative; }
function looksLikeTestCommand(command) { return /\b(test|pytest|vitest|jest|mocha|gradle test|mvn test|flutter test|npm test|pnpm test|yarn test|lint|tsc|build)\b/i.test(command); }
function looksLikeToolResult(text) { return /^(tool_result|<tool_use|Error:|File content|stdout|stderr)/i.test(String(text || '').trim()); }
function bulletOrFallback(items, fallback = 'None detected.') { const clean = items.filter(Boolean).map(item => String(item).trim()).filter(Boolean); return clean.length ? clean.map(item => `- ${item}`).join('\n') : fallback; }
function dedupe(items) { const seen = new Set(); const out = []; for (const item of items) { const key = String(item || '').trim(); if (!key || seen.has(key)) continue; seen.add(key); out.push(key); } return out; }
function cleanText(text) { return String(text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim(); }
function truncate(text, max) { const clean = cleanText(text); return clean.length <= max ? clean : `${clean.slice(0, max - 3)}...`; }
function expandHome(filePath) { if (!filePath) return ''; return filePath.startsWith('~/') ? path.join(os.homedir(), filePath.slice(2)) : filePath; }
function shortHash(text) { return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 8); }
