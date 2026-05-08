import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureProjectFiles, rel } from './project.js';

const DEFAULT_MAX_BYTES = 1024 * 1024;

export function updateHandoffFromTranscript(projectRoot = process.cwd(), input = {}, options = {}) {
  const paths = ensureProjectFiles(projectRoot);

  const transcriptPath = expandHome(input.transcript_path || input.transcriptPath);

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return {
      updated: false,
      reason: 'missing_transcript_path',
      transcriptPath: transcriptPath || null
    };
  }

  const records = readJsonlTail(transcriptPath, options.maxBytes || DEFAULT_MAX_BYTES);
  const summary = summarizeTranscript(projectRoot, records);

  if (!hasMeaningfulSummary(summary)) {
    return {
      updated: false,
      reason: 'empty_summary',
      transcriptPath
    };
  }

  const content = renderHandoff(summary, {
    source: options.source || input.hook_event_name || input.hookEventName || 'unknown',
    reason: input.reason || input.trigger || '',
    transcriptPath
  });

  const previous = fs.existsSync(paths.handoff)
    ? fs.readFileSync(paths.handoff, 'utf8')
    : '';

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
    failures: summary.failures.length
  };
}

export function summarizeTranscript(projectRoot, records) {
  const state = {
    lastUserPrompt: '',
    lastAssistantText: '',
    filesRead: new Set(),
    filesTouched: new Set(),
    commandsRun: [],
    testsRun: [],
    failures: [],
    toolsSeen: []
  };

  for (const record of records) {
    scanRecord(projectRoot, record, state);
  }

  return {
    lastUserPrompt: cleanText(state.lastUserPrompt),
    lastAssistantText: cleanText(state.lastAssistantText),
    filesRead: [...state.filesRead].slice(-30),
    filesTouched: [...state.filesTouched].slice(-30),
    commandsRun: dedupe(state.commandsRun).slice(-20),
    testsRun: dedupe(state.testsRun).slice(-12),
    failures: dedupe(state.failures).slice(-12),
    toolsSeen: dedupe(state.toolsSeen).slice(-30)
  };
}

function scanRecord(projectRoot, record, state) {
  const message = record.message || record;

  if (message.role === 'user') {
    const text = extractTextContent(message.content);

    if (text && !looksLikeToolResult(text) && !contentHasToolResult(message.content)) {
      state.lastUserPrompt = text;
    }
  }

  if (message.role === 'assistant') {
    const text = extractTextContent(message.content);

    if (text) {
      state.lastAssistantText = text;
    }
  }

  scanAny(projectRoot, record, state, 0);
}

function scanAny(projectRoot, value, state, depth) {
  if (depth > 8 || value == null) return;

  if (typeof value === 'string') {
    collectFailureLines(value, state);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      scanAny(projectRoot, item, state, depth + 1);
    }

    return;
  }

  if (typeof value !== 'object') return;

  const toolName = value.tool_name || value.toolName || value.name;

  const maybeInput =
    value.tool_input ||
    value.toolInput ||
    value.input ||
    value.parameters ||
    value.args;

  if (toolName && maybeInput && typeof maybeInput === 'object') {
    collectToolUse(projectRoot, toolName, maybeInput, state);
  }

  if (value.type === 'tool_use' && value.name && value.input) {
    collectToolUse(projectRoot, value.name, value.input, state);
  }

  if (value.type === 'tool_result') {
    const resultText = extractTextContent(value.content);
    collectFailureLines(resultText, state);
  }

  for (const child of Object.values(value)) {
    scanAny(projectRoot, child, state, depth + 1);
  }
}

function collectToolUse(projectRoot, toolName, input, state) {
  state.toolsSeen.push(String(toolName));

  const filePath = input.file_path || input.path || input.notebook_path;

  if (filePath) {
    const normalized = normalizeProjectPath(projectRoot, filePath);

    if (toolName === 'Read') {
      state.filesRead.add(normalized);
    }

    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
      state.filesTouched.add(normalized);
    }
  }

  if (toolName === 'Bash' && input.command) {
    const command = String(input.command).trim();

    if (command) {
      state.commandsRun.push(command);

      if (looksLikeTestCommand(command)) {
        state.testsRun.push(command);
      }
    }
  }
}

function collectFailureLines(text, state) {
  if (!text) return;

  const lines = String(text).split(/\r?\n/);
  const re = /(error|failed|failure|exception|traceback|expected|received|assert|panic|fatal|timeout|not found|undefined|cannot)/i;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length < 4) continue;
    if (!re.test(trimmed)) continue;

    state.failures.push(trimmed.slice(0, 240));
  }
}

function renderHandoff(summary, meta) {
  const now = new Date().toISOString();

  return `# Next Session Handoff

Generated: ${now}
Generated by: Token Guard
Hook source: ${meta.source}${meta.reason ? ` (${meta.reason})` : ''}

## Current Goal

${bulletOrFallback([truncate(summary.lastUserPrompt, 900)], 'Unknown. Re-read the latest user request if needed.')}

## What Changed

${summary.filesTouched.length
  ? `The session appears to have modified or prepared edits for these files:\n\n${bulletOrFallback(summary.filesTouched)}`
  : 'No Write/Edit/MultiEdit file activity detected in the captured transcript window.'}

## Files Touched

${bulletOrFallback(summary.filesTouched)}

## Files Read

${bulletOrFallback(summary.filesRead)}

## Commands Run

${codeBlockOrFallback(summary.commandsRun)}

## Tests Run

${codeBlockOrFallback(summary.testsRun)}

## Current Blocker / Failure Signals

${bulletOrFallback(summary.failures, 'No explicit error/failure lines detected in the captured transcript window.')}

## Next Smallest Task

- Continue from the current goal above.
- Inspect the files under "Files Touched" first.
- Prefer targeted reads over full-file reads.
- If a full read is genuinely needed, use \`@tg:force-read <file>\` or \`token-guard allow <file> --once\`.

## Do Not Re-investigate

- Token Guard already captured the last session’s local transcript into this handoff.
- Avoid re-reading generated/build/dependency/log files unless the user explicitly asks.
- Keep this handoff short enough to load into a fresh session.

## Tool Signals

${bulletOrFallback(summary.toolsSeen)}

`;
}

function hasMeaningfulSummary(summary) {
  return Boolean(
    summary.lastUserPrompt ||
    summary.filesRead.length ||
    summary.filesTouched.length ||
    summary.commandsRun.length ||
    summary.failures.length
  );
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

    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
    }

    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function extractTextContent(content) {
  if (!content) return '';

  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (!item) return '';

        if (typeof item === 'string') return item;

        if (item.type === 'text' && item.text) return item.text;
        if (item.type === 'tool_result') return extractTextContent(item.content);

        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (typeof content === 'object') {
    if (content.text) return String(content.text);
    if (content.content) return extractTextContent(content.content);
  }

  return '';
}

function normalizeProjectPath(projectRoot, filePath) {
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.join(projectRoot, filePath);

  const relative = rel(projectRoot, absolute);

  if (relative.startsWith('..')) {
    return filePath;
  }

  return relative;
}

function looksLikeTestCommand(command) {
  return /\b(test|pytest|vitest|jest|mocha|gradle test|mvn test|flutter test|npm test|pnpm test|yarn test|lint|tsc|build)\b/i.test(command);
}

function looksLikeToolResult(text) {
  return /^(tool_result|<tool_use|Error:|ERROR |File content|stdout|stderr)/i.test(String(text || '').trim());
}

function contentHasToolResult(content) {
  if (!Array.isArray(content)) return false;
  return content.some(item => item && typeof item === 'object' && item.type === 'tool_result');
}

function bulletOrFallback(items, fallback = 'None detected.') {
  const clean = items
    .filter(Boolean)
    .map(item => String(item).trim())
    .filter(Boolean);

  if (!clean.length) return fallback;

  return clean.map(item => `- ${item}`).join('\n');
}

function codeBlockOrFallback(items, fallback = 'None detected.') {
  const clean = items
    .filter(Boolean)
    .map(item => String(item).trim())
    .filter(Boolean);

  if (!clean.length) return fallback;

  return `\`\`\`text\n${clean.join('\n')}\n\`\`\``;
}

function dedupe(items) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = String(item || '').trim();

    if (!key || seen.has(key)) continue;

    seen.add(key);
    out.push(key);
  }

  return out;
}

function cleanText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(text, max) {
  const clean = cleanText(text);

  if (clean.length <= max) return clean;

  return `${clean.slice(0, max - 3)}...`;
}

function expandHome(filePath) {
  if (!filePath) return '';

  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  return filePath;
}
