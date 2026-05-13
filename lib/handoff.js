import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureProjectFiles, rel } from './project.js';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_HANDOFF_LINES = 160;
const MAX_HANDOFF_CHARS = 11000;
const MAX_FILES = 18;
const MAX_COMMANDS = 10;
const MAX_FAILURES = 8;

export function writeHandoffManual(projectRoot = process.cwd(), options = {}) {
  const paths = ensureProjectFiles(projectRoot);
  const ledgerEvents = readRecentLedgerEvents(paths, options.lookbackEvents || 400);
  const turnLog = readRecentTurnLog(paths, options.lookbackTurns || 60);

  const summary = summarizeFromManualSources(ledgerEvents, turnLog);

  applyOverrides(summary, options);

  if (!hasMeaningfulSummary(summary)) {
    return { updated: false, reason: 'empty_summary' };
  }

  let content = renderHandoff(summary, {
    source: options.source || 'manual_codex',
    reason: options.reason || 'cli_handoff_write'
  });

  content = enforceHandoffBudget(content);

  const previous = fs.existsSync(paths.handoff) ? fs.readFileSync(paths.handoff, 'utf8') : '';

  if (previous === content && !options.force) {
    return { updated: false, reason: 'unchanged' };
  }

  fs.writeFileSync(paths.handoff, content);

  return {
    updated: true,
    reason: 'updated',
    handoffPath: paths.handoff,
    filesTouched: summary.filesTouched.length,
    filesRead: summary.filesRead.length,
    commandsRun: summary.commandsRun.length,
    failures: summary.failures.length,
    handoffLines: content.split(/\r?\n/).length,
    handoffChars: content.length
  };
}

function summarizeFromManualSources(ledgerEvents, turnLog) {
  const filesRead = new Map();
  const filesTouched = new Map();
  const commandsRun = [];
  const tools = new Set();
  let lastGoal = '';

  for (const event of ledgerEvents) {
    if (event.type === 'context_read_saved' && event.file) {
      addFileStat(filesRead, event.file, { lineCount: 0 });
      if (event.method === 'focus' || event.method === 'section' || event.method === 'symbol') {
        tools.add(`tg ctx --focus`);
      } else if (event.method === 'around') {
        tools.add(`tg ctx --around`);
      } else if (event.method === 'lines') {
        tools.add(`tg ctx --lines`);
      } else {
        tools.add('tg ctx');
      }
    }

    if (event.type === 'codex_turn_tick') {
      for (const tool of event.tools || []) tools.add(String(tool));
    }
  }

  for (const record of turnLog) {
    if (record.note) lastGoal = record.note;
    for (const tool of record.tools || []) tools.add(String(tool));
  }

  return {
    currentGoal: lastGoal,
    filesRead: rankFiles(filesRead, filesTouched).slice(0, MAX_FILES),
    filesTouched: rankFiles(filesTouched, filesTouched).slice(0, MAX_FILES),
    commandsRun,
    testsRun: [],
    failures: [],
    toolsSeen: [...tools].slice(-18),
    hasSpecificDoNot: false
  };
}

function applyOverrides(summary, options) {
  if (options.goal) summary.currentGoal = String(options.goal).slice(0, 700);
  if (options.note) summary.currentGoal = summary.currentGoal ? `${summary.currentGoal} — ${options.note}` : String(options.note).slice(0, 700);
}

function readRecentLedgerEvents(paths, max = 400) {
  if (!fs.existsSync(paths.ledgerEvents)) return [];

  const lines = fs
    .readFileSync(paths.ledgerEvents, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);

  return lines
    .slice(-max)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function readRecentTurnLog(paths, max = 60) {
  const file = path.join(paths.sessions, 'codex-turns.jsonl');
  if (!fs.existsSync(file)) return [];

  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);

  let startIdx = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const record = JSON.parse(lines[i]);
      if (record.type === 'session_start' || record.type === 'handoff_written') { startIdx = i + 1; break; }
    } catch {}
  }

  return lines
    .slice(Math.max(startIdx, lines.length - max))
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

export function updateHandoffFromTranscript(projectRoot = process.cwd(), input = {}, options = {}) {
  const paths = ensureProjectFiles(projectRoot);
  const transcriptPath = expandHome(input.transcript_path || input.transcriptPath);

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { updated: false, reason: 'missing_transcript_path', transcriptPath: transcriptPath || null };
  }

  const records = readJsonlTail(transcriptPath, options.maxBytes || DEFAULT_MAX_BYTES);
  const summary = summarizeTranscript(projectRoot, records, paths);

  if (!hasMeaningfulSummary(summary)) {
    return { updated: false, reason: 'empty_summary', transcriptPath };
  }

  let content = renderHandoff(summary, {
    source: options.source || input.hook_event_name || input.hookEventName || 'unknown',
    reason: input.reason || input.trigger || ''
  });

  content = enforceHandoffBudget(content);

  const previous = fs.existsSync(paths.handoff) ? fs.readFileSync(paths.handoff, 'utf8') : '';
  if (previous === content) {
    return {
      updated: false,
      reason: 'unchanged',
      transcriptPath,
      filesTouched: summary.filesTouched.length,
      commandsRun: summary.commandsRun.length,
      failures: summary.failures.length
    };
  }

  fs.writeFileSync(paths.handoff, content);

  return {
    updated: true,
    reason: 'updated',
    transcriptPath,
    filesTouched: summary.filesTouched.length,
    filesRead: summary.filesRead.length,
    commandsRun: summary.commandsRun.length,
    testsRun: summary.testsRun.length,
    failures: summary.failures.length,
    handoffLines: content.split(/\r?\n/).length,
    handoffChars: content.length
  };
}

export function summarizeTranscript(projectRoot, records, paths = ensureProjectFiles(projectRoot)) {
  const state = {
    lastUserPrompt: '',
    filesRead: new Map(),
    filesTouched: new Map(),
    commandsRun: [],
    testsRun: [],
    failures: [],
    toolsSeen: []
  };

  for (const record of records) scanRecord(projectRoot, record, state);

  const goal = chooseGoal(state.lastUserPrompt, paths);

  return {
    currentGoal: goal,
    filesRead: rankFiles(state.filesRead, state.filesTouched).slice(0, MAX_FILES),
    filesTouched: rankFiles(state.filesTouched, state.filesTouched).slice(0, MAX_FILES),
    commandsRun: dedupe(state.commandsRun).map(summarizeCommand).filter(Boolean).slice(-MAX_COMMANDS),
    testsRun: dedupe(state.testsRun).map(summarizeCommand).filter(Boolean).slice(-6),
    failures: dedupe(state.failures).map(line => truncate(line, 220)).filter(Boolean).slice(-MAX_FAILURES),
    toolsSeen: dedupe(state.toolsSeen).slice(-18),
    hasSpecificDoNot: state.commandsRun.some(command => /<<|grep|rg|python|python3|node\s+-e/.test(command))
  };
}

function scanRecord(projectRoot, record, state) {
  const message = record.message || record;

  if (message.role === 'user' && !containsToolResult(message.content)) {
    const text = extractTextContent(message.content);
    if (text && !looksLikeToolResult(text) && !looksLikeDump(text)) state.lastUserPrompt = text;
  }

  scanAny(projectRoot, record, state, 0, null);
}

function scanAny(projectRoot, value, state, depth, currentTool) {
  if (depth > 8 || value == null) return;

  if (typeof value === 'string') {
    // Do not collect failures from arbitrary strings. Failures are collected only from tool_result-ish content.
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) scanAny(projectRoot, item, state, depth + 1, currentTool);
    return;
  }

  if (typeof value !== 'object') return;

  const toolName = value.tool_name || value.toolName || value.name || currentTool;
  const maybeInput = value.tool_input || value.toolInput || value.input || value.parameters || value.args;

  if (toolName && maybeInput && typeof maybeInput === 'object') collectToolUse(projectRoot, toolName, maybeInput, state);
  if (value.type === 'tool_use' && value.name && value.input) collectToolUse(projectRoot, value.name, value.input, state);

  if (value.type === 'tool_result') {
    const resultText = extractTextContent(value.content);
    collectFailureLines(resultText, state);
  }

  // Claude transcripts often store tool output as user content blocks.
  if (value.tool_use_id && value.content) {
    collectFailureLines(extractTextContent(value.content), state);
  }

  for (const child of Object.values(value)) scanAny(projectRoot, child, state, depth + 1, toolName);
}

function collectToolUse(projectRoot, toolName, input, state) {
  state.toolsSeen.push(String(toolName));

  const filePath = input.file_path || input.path || input.notebook_path;
  if (filePath) {
    const normalized = normalizeProjectPath(projectRoot, filePath);
    const lineCount = Number(input.limit || 0);

    if (toolName === 'Read') addFileStat(state.filesRead, normalized, { lineCount });
    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) addFileStat(state.filesTouched, normalized, { lineCount });
  }

  if (toolName === 'Bash' && input.command) {
    const command = sanitizeCommand(String(input.command).trim());
    if (command) {
      state.commandsRun.push(command);
      if (looksLikeTestCommand(command)) state.testsRun.push(command);
    }
  }
}

function addFileStat(map, file, info = {}) {
  if (!file || file.startsWith('TokenGuard/')) return;
  const row = map.get(file) || { file, count: 0, lines: 0 };
  row.count += 1;
  row.lines += Number(info.lineCount || 0);
  map.set(file, row);
}

function renderHandoff(summary, meta) {
  const now = new Date().toISOString();
  const doNot = summary.hasSpecificDoNot ? `
## Do Not Re-investigate

- Do not replay broad grep/Python/heredoc commands from the previous session unless targeted reads are insufficient.
` : '';

  return `# Next Session Handoff

Generated: ${now}
Generated by: Token Guard
Hook source: ${meta.source}${meta.reason ? ` (${meta.reason})` : ''}

## Current Goal

${bulletOrFallback([summary.currentGoal], 'Unknown. Re-read the latest user request if needed.')}

## Compact State

${summary.filesTouched.length ? `Previous session touched ${summary.filesTouched.length} file(s). Start with Files Touched.` : 'Previous session appears read-only; no Write/Edit activity detected.'}
${summary.failures.length ? `Failure signals detected: ${summary.failures.length}. Check Failure Signals before rerunning broad commands.` : 'No command failure signal detected.'}

## Files Touched

${bulletOrFallback(summary.filesTouched.map(formatFileStat))}

## Top Files Read

${bulletOrFallback(summary.filesRead.map(formatFileStat))}

## Commands Run

${bulletOrFallback(summary.commandsRun)}

## Tests Run

${bulletOrFallback(summary.testsRun)}

## Failure Signals

${bulletOrFallback(summary.failures, 'No explicit command/test failure lines detected.')}

## Next Smallest Task

- Continue from Current Goal.
- Inspect Files Touched first.
- Prefer narrow Read windows before Edit.
- Use git status/diff for exact working tree state.
${doNot}
## Tool Signals

${bulletOrFallback(summary.toolsSeen)}
`;
}

function chooseGoal(lastUserPrompt, paths) {
  const clean = cleanText(lastUserPrompt);
  if (clean && !looksLikeDump(clean)) return truncate(clean, 700);

  const digestGoal = extractGoalFromDigest(paths.inputDigest);
  if (digestGoal) return digestGoal;

  return '';
}

function extractGoalFromDigest(file) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const match = content.match(/## User Intent\n\n([\s\S]*?)(?:\n## |$)/);
    if (!match) return '';
    return match[1].split(/\r?\n/).map(line => line.replace(/^[-*]\s*/, '').trim()).filter(Boolean).slice(0, 3).join(' ');
  } catch {
    return '';
  }
}

function rankFiles(readMap, touchedMap) {
  return [...readMap.values()].sort((a, b) => {
    const at = touchedMap.has(a.file) ? 1 : 0;
    const bt = touchedMap.has(b.file) ? 1 : 0;
    return bt - at || b.count - a.count || b.lines - a.lines || a.file.localeCompare(b.file);
  });
}

function formatFileStat(row) {
  const parts = [`${row.file}`, `read ${row.count}x`];
  if (row.lines) parts.push(`${row.lines} lines`);
  return parts.join(' — ');
}

function collectFailureLines(text, state) {
  if (!text) return;
  const lines = stripHugeBlocks(String(text)).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = cleanFailureLine(line);
    if (!isRuntimeFailureLine(trimmed)) continue;
    state.failures.push(trimmed.slice(0, 220));
  }
}

function isRuntimeFailureLine(line) {
  const s = String(line || '').trim();
  if (s.length < 4) return false;
  if (looksLikeSourceCode(s)) return false;
  return /^(error|error:|exception|traceback|failed|failure|fatal|assertionerror|exit code|command failed|npm err!|✖|❌|stderr:)/i.test(s) || /\b(exit code \d+|command failed|tests? failed|failed tests?)\b/i.test(s);
}

function sanitizeCommand(command) {
  let c = String(command || '').trim().replace(/\r/g, '');
  if (!c) return '';
  if (containsHeredoc(c)) return `${truncate(c.split('\n')[0], 120)} [heredoc/script body omitted, sha=${shortHash(c)}]`;
  if (c.split('\n').length > 3) return `${truncate(c.split('\n')[0], 140)} [${c.split('\n').length} command lines omitted, sha=${shortHash(c)}]`;
  c = stripHugeBlocks(c).replace(/\s+/g, ' ').trim();
  return truncate(c, 180);
}

function summarizeCommand(command) {
  const c = sanitizeCommand(command);
  if (!c) return '';
  if (/npm\s+test|pnpm\s+test|yarn\s+test|pytest|flutter\s+test|gradle\s+test|mvn\s+test|vitest|jest/i.test(c)) return `test: ${c}`;
  if (/git\s+status/i.test(c)) return 'git status';
  if (/\brg\b|\bgrep\b/i.test(c)) return `search: ${truncate(c, 160)}`;
  if (/python|python3|node\s+-e|ruby|perl/i.test(c) && /read_text|open\(|readFileSync|fs\.readFile/i.test(c)) return `${truncate(c, 120)} [fallback file-read command summarized]`;
  return c;
}

function hasMeaningfulSummary(summary) {
  return Boolean(summary.currentGoal || summary.filesRead.length || summary.filesTouched.length || summary.commandsRun.length || summary.failures.length);
}

function readJsonlTail(file, maxBytes) {
  const stat = fs.statSync(file);
  const size = stat.size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
    return text.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function extractTextContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(item => {
    if (!item) return '';
    if (typeof item === 'string') return item;
    if (item.type === 'text' && item.text) return item.text;
    if (item.type === 'tool_result') return extractTextContent(item.content);
    return '';
  }).filter(Boolean).join('\n');
  if (typeof content === 'object') {
    if (content.text) return String(content.text);
    if (content.content) return extractTextContent(content.content);
  }
  return '';
}

function containsToolResult(content) {
  if (!Array.isArray(content)) return false;
  return content.some(item => item?.type === 'tool_result');
}

function normalizeProjectPath(projectRoot, filePath) {
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  const relative = rel(projectRoot, absolute);
  if (relative.startsWith('..')) return filePath;
  return relative;
}

function looksLikeTestCommand(command) { return /\b(test|pytest|vitest|jest|mocha|gradle test|mvn test|flutter test|npm test|pnpm test|yarn test|lint|tsc|build)\b/i.test(command); }
function looksLikeToolResult(text) { return /^(tool_result|<tool_use|stdout|stderr)/i.test(String(text || '').trim()); }
function containsHeredoc(command) { return /<<\s*['"]?[A-Za-z0-9_-]+['"]?/.test(command); }
function stripHugeBlocks(text) { return String(text || '').replace(/```[\s\S]*?```/g, '[code block omitted]').replace(/<<\s*['"]?([A-Za-z0-9_-]+)['"]?[\s\S]*?\n\1\b/g, '[heredoc omitted]'); }
function looksLikeSourceCode(line) { return /^(const|let|var|function|class|def|import|export|if|else|throw|return|case|switch|try|catch|finally|module\.exports|\/\/|\*)\b/.test(line.trim()) || /^\d+[:|]\s*(const|let|var|if|else|throw|return|import|export)/.test(line.trim()); }
function looksLikeDump(text) { const lines = String(text || '').split(/\r?\n/).slice(0, 30); if (lines.length > 8 && lines.filter(looksLikeSourceCode).length >= 4) return true; if (lines.filter(line => /^\d+[:|]/.test(line.trim())).length >= 4) return true; return false; }
function cleanFailureLine(line) { return String(line || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim(); }
function enforceHandoffBudget(content) { let out = String(content || '').trimEnd() + '\n'; const lines = out.split(/\r?\n/); if (lines.length > MAX_HANDOFF_LINES) out = `${lines.slice(0, MAX_HANDOFF_LINES).join('\n')}\n\n[Token Guard: handoff clipped from ${lines.length} to ${MAX_HANDOFF_LINES} lines.]\n`; if (out.length > MAX_HANDOFF_CHARS) out = `${out.slice(0, MAX_HANDOFF_CHARS)}\n\n[Token Guard: handoff clipped to ${MAX_HANDOFF_CHARS.toLocaleString('en-US')} chars.]\n`; return out; }
function bulletOrFallback(items, fallback = 'None detected.') { const clean = items.filter(Boolean).map(item => String(item).trim()).filter(Boolean); return clean.length ? clean.map(item => `- ${item}`).join('\n') : fallback; }
function dedupe(items) { const seen = new Set(); const out = []; for (const item of items) { const key = String(item || '').trim(); if (!key || seen.has(key)) continue; seen.add(key); out.push(key); } return out; }
function cleanText(text) { return String(text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim(); }
function truncate(text, max) { const clean = cleanText(text); return clean.length <= max ? clean : `${clean.slice(0, max - 3)}...`; }
function expandHome(filePath) { if (!filePath) return ''; return filePath.startsWith('~/') ? path.join(os.homedir(), filePath.slice(2)) : filePath; }
function shortHash(text) { return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 8); }
