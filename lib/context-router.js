import fs from 'node:fs';
import path from 'node:path';
import { ensureProjectFiles, rel } from './project.js';
import {
  estimateTokens,
  looksLogFile,
  trimBashOutput
} from './token-utils.js';
import {
  smartRead,
  summarizeFile,
  formatSmartReadResult
} from './precision.js';

export const AGENT_LANGUAGE_POLICY =
  'Language policy: Keep Token Guard commands in English. If you explain this notice to the user, translate the explanation into the user’s current conversation language.';

export function buildContextForFile(projectRoot = process.cwd(), filePath, options = {}) {
  ensureProjectFiles(projectRoot);

  if (!filePath) {
    throw new Error('Missing file path.');
  }

  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.join(projectRoot, filePath);

  if (!fs.existsSync(absolute)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const relPath = rel(projectRoot, absolute);
  const content = fs.readFileSync(absolute, 'utf8');
  const tokens = estimateTokens(content);
  const maxTokens = Number(options.maxTokens || options.config?.thresholds?.precisionReadMaxTokens || 6000);
  const focus = options.focus || options.symbol || options.section || '';

  if (options.lines) {
    const result = smartRead(projectRoot, relPath, {
      lines: options.lines,
      maxTokens
    });

    return normalizeContextResult(result, {
      mode: 'lines',
      suggestedCommands: suggestions(relPath, focus)
    });
  }

  if (focus) {
    const symbolResult = smartRead(projectRoot, relPath, {
      symbol: focus,
      maxTokens
    });

    if (symbolResult.kind === 'symbol') {
      return normalizeContextResult(symbolResult, {
        mode: 'symbol',
        suggestedCommands: suggestions(relPath, focus)
      });
    }

    const sectionResult = smartRead(projectRoot, relPath, {
      section: focus,
      maxTokens
    });

    if (sectionResult.kind === 'section') {
      return normalizeContextResult(sectionResult, {
        mode: 'section',
        suggestedCommands: suggestions(relPath, focus)
      });
    }
  }

  if (looksLogFile(relPath)) {
    const trimmed = trimBashOutput(content, '', {
      thresholds: {
        bashOutputMaxLines: 140
      }
    });

    const text = trimmed.changed
      ? trimmed.stdout
      : content;

    return {
      kind: 'log-focused-preview',
      file: relPath,
      originalTokens: tokens,
      returnedTokens: estimateTokens(text),
      text,
      suggestedCommands: suggestions(relPath, focus)
    };
  }

  if (tokens <= maxTokens) {
    const result = smartRead(projectRoot, relPath, {
      maxTokens
    });

    return normalizeContextResult(result, {
      mode: 'full-small-file',
      suggestedCommands: suggestions(relPath, focus)
    });
  }

  const result = smartRead(projectRoot, relPath, {
    maxTokens
  });

  return normalizeContextResult(result, {
    mode: 'large-preview',
    suggestedCommands: suggestions(relPath, focus)
  });
}

export function formatContextResult(result, options = {}) {
  const includeLanguagePolicy = options.includeLanguagePolicy !== false;

  const lines = [];

  lines.push('Token Guard autopilot context');
  lines.push(`File: ${result.file}`);
  lines.push(`Kind: ${result.kind}`);
  lines.push(`Original estimate: ${format(result.originalTokens)} tokens`);
  lines.push(`Returned estimate: ${format(result.returnedTokens)} tokens`);

  if (includeLanguagePolicy) {
    lines.push('');
    lines.push(AGENT_LANGUAGE_POLICY);
  }

  lines.push('');
  lines.push('Suggested next steps:');

  for (const command of result.suggestedCommands || []) {
    lines.push(`- ${command}`);
  }

  lines.push('');
  lines.push(result.text || '');

  return lines.join('\n');
}

export function buildAutopilotDenyMessage(file, tokens) {
  return (
    `Token Guard autopilot prevented a high-cost full read of ${file} (~${format(tokens)} tokens). ` +
    `Use the injected lightweight context first. If more detail is needed, prefer \`tg ctx ${shellQuote(file)} --focus <symbol-or-topic>\` or \`tg ctx ${shellQuote(file)} --lines A:B\`. ` +
    `Force a one-time full read only if necessary with \`token-guard allow ${shellQuote(file)} --once\`.`
  );
}

export function buildAutopilotObserveMessage(file, tokens) {
  return (
    `Token Guard observe notice: full read of ${file} would cost ~${format(tokens)} tokens. ` +
    `Prefer \`tg ctx ${shellQuote(file)}\`, \`tg ctx ${shellQuote(file)} --focus <symbol-or-topic>\`, or \`tg ctx ${shellQuote(file)} --lines A:B\`. ` +
    `This is observe mode, so the read is not blocked.`
  );
}

export function buildAgentFacingNotice(text) {
  return `${AGENT_LANGUAGE_POLICY}\n\n${text}`;
}

export function summarizeForAutopilot(projectRoot, filePath, options = {}) {
  const result = summarizeFile(projectRoot, filePath, options);

  return {
    ...result,
    suggestedCommands: suggestions(result.file)
  };
}

function normalizeContextResult(result, extra = {}) {
  return {
    ...result,
    kind: extra.mode || result.kind,
    suggestedCommands: extra.suggestedCommands || []
  };
}

function suggestions(file, focus = '') {
  const quoted = shellQuote(file);
  const commands = [];

  commands.push(`tg ctx ${quoted}`);

  if (focus) {
    commands.push(`tg ctx ${quoted} --focus ${shellQuote(focus)}`);
  } else {
    commands.push(`tg ctx ${quoted} --focus <symbol-or-topic>`);
  }

  commands.push(`tg ctx ${quoted} --lines A:B`);
  commands.push(`token-guard summarize ${quoted}`);
  commands.push(`token-guard allow ${quoted} --once`);

  return commands;
}

function shellQuote(value) {
  const s = String(value || '');

  if (/^[a-zA-Z0-9_./:-]+$/.test(s)) return s;

  return `'${s.replaceAll("'", "'\\''")}'`;
}

function format(n) {
  return Math.round(Number(n || 0)).toLocaleString('en-US');
}
