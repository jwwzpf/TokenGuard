import fs from 'node:fs';
import path from 'node:path';
import { appendEvent } from './ledger.js';
import { ensureProjectFiles, loadConfig, saveConfig, rel } from './project.js';
import { allowOnce, forceReadVariants } from './installer.js';
import { updateHandoffFromTranscript } from './handoff.js';
import {
  buildAgentFacingNotice,
  buildAutopilotDenyMessage,
  buildAutopilotObserveMessage,
  buildContextForFile,
  formatContextResult
} from './context-router.js';
import {
  fileInfo,
  hashText,
  isAlwaysAllowed,
  trimBashOutput
} from './token-utils.js';

export async function handleHook(eventNameArg, inputOverride) {
  const input = inputOverride ?? readStdinJson();
  const eventName = eventNameArg || input.hook_event_name || input.hookEventName;
  const output = runHook(eventName, input);

  if (inputOverride !== undefined) {
    return output;
  }

  if (output && Object.keys(output).length > 0) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }

  return output;
}

export function runHook(eventName, input = {}) {
  const projectRoot = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const paths = ensureProjectFiles(projectRoot);
  const config = loadConfig(projectRoot);

  if (!config.enabled) return {};

  try {
    switch (eventName) {
      case 'SessionStart':
        return onSessionStart(projectRoot, paths, config);
      case 'UserPromptSubmit':
        return onUserPromptSubmit(projectRoot, config, input);
      case 'PreToolUse':
        return onPreToolUse(projectRoot, config, input);
      case 'PostToolUse':
        return onPostToolUse(projectRoot, config, input);
      case 'PreCompact':
        return onPreCompact(projectRoot, paths, config, input);
      case 'Stop':
        return onStop(projectRoot, input);
      case 'SessionEnd':
        return onSessionEnd(projectRoot, input);
      default:
        return {};
    }
  } catch (err) {
    appendEvent(projectRoot, {
      type: 'hook_error',
      eventName,
      message: err.message
    });

    return {
      suppressOutput: true,
      systemMessage: `Token Guard hook error: ${err.message}`
    };
  }
}

function onSessionStart(projectRoot, paths, config) {
  const chunks = [];

  const core = readLimited(paths.memoryCore, Number(config.thresholds?.memoryCoreMaxLines || 150));
  const handoff = readLimited(paths.handoff, 220);

  if (core.trim()) {
    chunks.push(`## Token Guard core memory\n${core.trim()}`);
  }

  if (handoff.trim()) {
    chunks.push(`## Token Guard handoff\n${handoff.trim()}`);
  }

  appendEvent(projectRoot, {
    type: 'session_start',
    mode: config.mode
  });

  if (!chunks.length) return {};

  return additionalContext(
    'SessionStart',
    buildAgentFacingNotice(
      `Token Guard is active in ${config.mode} mode. Local-only, no daemon, no code upload.\n\n${chunks.join('\n\n')}`
    )
  );
}

function onUserPromptSubmit(projectRoot, config, input) {
  const prompt = String(input.prompt || input.user_prompt || input.message || '');

  const forceMatches = [...prompt.matchAll(/@tg:force-read\s+([^\s]+)/gi)].map(m => m[1]);
  const allowFull = /@tg:allow-full-read/i.test(prompt);

  for (const file of forceMatches) {
    allowOnce(projectRoot, file);
  }

  if (allowFull) {
    allowOnce(projectRoot, '*');
  }

  if (forceMatches.length || allowFull) {
    appendEvent(projectRoot, {
      type: 'force_read_requested',
      files: forceMatches.length ? forceMatches : ['*']
    });
  }

  const status = {
    enabled: config.enabled,
    mode: config.mode,
    softTokens: config.thresholds?.softTokens || 25000,
    hardTokens: config.thresholds?.hardTokens || 60000
  };

  const hash = hashText(JSON.stringify(status));
  const now = Date.now();
  const lastAt = config.state?.lastReminderAt ? Date.parse(config.state.lastReminderAt) : 0;
  const ttl = Number(config.thresholds?.reminderStateTtlMs || 5 * 60 * 1000);

  const unchanged = config.state?.lastReminderHash === hash && now - lastAt < ttl;

  if (unchanged) {
    appendEvent(projectRoot, {
      type: 'reminder_deduped',
      estimatedTokens: config.savings?.reminderDedupTokens || 180
    });

    return {};
  }

  saveConfig(projectRoot, {
    ...config,
    state: {
      ...(config.state || {}),
      lastReminderHash: hash,
      lastReminderAt: new Date(now).toISOString()
    }
  });

  const message =
    config.mode === 'observe'
      ? 'Token Guard observe mode is active. It records token waste, keeps handoff memory, and trims noisy Bash output. It does not block Read calls in observe mode. Main precision-context command: `tg ctx <file>`.'
      : config.mode === 'auto'
        ? 'Token Guard auto mode is active. It may replace obvious high-cost full-file dumps with lightweight context. Narrow Read windows are always allowed.'
        : `Token Guard ${config.mode} mode is active. Narrow Read windows are always allowed. High-cost full-file dumps may be guarded.`;

  return additionalContext('UserPromptSubmit', buildAgentFacingNotice(message));
}

function onPreToolUse(projectRoot, config, input) {
  const toolName = input.tool_name || input.toolName;

  if (toolName === 'Read') {
    return onPreRead(projectRoot, config, input);
  }

  if (toolName === 'Bash') {
    return onPreBash(projectRoot, config, input);
  }

  return {};
}

function onPreRead(projectRoot, config, input) {
  const toolInput = input.tool_input || input.toolInput || {};
  const filePath =
    toolInput.file_path ||
    toolInput.path ||
    input.file_path ||
    input.path;

  const info = fileInfo(projectRoot, filePath, config);

  if (!info || !info.relPath) return {};
  if (isAlwaysAllowed(info.relPath, config)) return {};

  const readWindow = getReadWindow(toolInput, input);
  const narrowMax = Number(config.thresholds?.narrowReadMaxLines || 200);

  if (readWindow.hasWindow && readWindow.limit > 0 && readWindow.limit <= narrowMax) {
    appendEvent(projectRoot, {
      type: 'narrow_read_allowed',
      file: info.relPath,
      offset: readWindow.offset,
      limit: readWindow.limit,
      estimatedTokens: Math.max(1, readWindow.limit * 18)
    });

    return {};
  }

  if (consumeForceRead(projectRoot, config, info.relPath, info.absolute)) {
    appendEvent(projectRoot, {
      type: 'force_read_used',
      file: info.relPath,
      estimatedTokens: info.tokens
    });

    return preToolDecision(
      'allow',
      `Token Guard force-read used for ${info.relPath}. Estimated full-read cost: ~${format(info.tokens)} tokens.`,
      buildAgentFacingNotice(`Force-read was used for ${info.relPath}. This was a one-time override.`)
    );
  }

  if (!info.exists) return {};

  const soft = Number(config.thresholds?.softTokens || 25000);
  const hard = Number(config.thresholds?.hardTokens || 60000);

  const guardReason = info.alwaysGuarded
    ? 'generated/dependency/build/lock pattern'
    : info.looksLog
      ? 'log/noisy output file'
      : 'large source file';

  if (info.tokens < soft && !info.alwaysGuarded && !info.looksLog) {
    return {};
  }

  const eventBase = {
    file: info.relPath,
    estimatedTokens: info.tokens,
    reason: guardReason,
    repeatDiscount: config.savings?.repeatBlockDiscount ?? 0.12,
    fullRead: !readWindow.hasWindow
  };

  if (config.mode === 'observe') {
    appendEvent(projectRoot, {
      type: 'read_guard_warn',
      ...eventBase,
      observeOnly: true
    });

    // Critical friction fix:
    // observe mode must never alter or interrupt Read/Edit flow.
    return {};
  }

  if (config.mode === 'auto') {
    if (!readWindow.hasWindow && (info.tokens >= hard || info.alwaysGuarded || info.looksLog)) {
      appendEvent(projectRoot, {
        type: 'read_guard_block',
        ...eventBase,
        autopilot: true
      });

      const context = safeBuildAutopilotContext(projectRoot, info.relPath, config);
      const message = buildAutopilotDenyMessage(info.relPath, info.tokens);

      return preToolDecision(
        'deny',
        message,
        buildAgentFacingNotice(`${message}\n\n${context}`)
      );
    }

    appendEvent(projectRoot, {
      type: 'read_guard_warn',
      ...eventBase,
      autoSoft: true
    });

    return {};
  }

  const message = costMessage(info.relPath, info.tokens, guardReason);

  if (!readWindow.hasWindow && (info.tokens >= hard || info.alwaysGuarded || info.looksLog || config.mode === 'strict')) {
    appendEvent(projectRoot, {
      type: 'read_guard_block',
      ...eventBase
    });

    return preToolDecision('deny', message, buildAgentFacingNotice(message));
  }

  appendEvent(projectRoot, {
    type: 'read_guard_warn',
    ...eventBase
  });

  return preToolDecision('ask', message, buildAgentFacingNotice(message));
}

function onPreBash(projectRoot, config, input) {
  const command = String(input.tool_input?.command || input.command || '');

  if (!command.trim()) return {};

  if (/\b(sed|grep|rg|awk|perl|python|python3|node)\b/.test(command)) {
    appendEvent(projectRoot, {
      type: 'fallback_tool_use',
      command: command.slice(0, 240),
      estimatedCost: config.savings?.fallbackPenaltyTokens || 450
    });
  }

  const candidate = extractBashFileCandidate(command);

  if (!candidate) return {};

  const info = fileInfo(projectRoot, candidate, config);

  if (!info || !info.exists || isAlwaysAllowed(info.relPath, config)) return {};

  const soft = Number(config.thresholds?.softTokens || 25000);

  const isNoisyDirectRead =
    /\b(cat|less|more)\b/.test(command) &&
    (info.tokens >= soft || info.looksLog);

  if (!isNoisyDirectRead) return {};

  const message =
    `Bash command may dump ~${format(info.tokens)} tokens from ${info.relPath}. ` +
    `Prefer a narrow Read window or \`tg ctx ${info.relPath}\`. ` +
    `Force once with: \`token-guard allow ${info.relPath} --once\`.`;

  appendEvent(projectRoot, {
    type: config.mode === 'observe' ? 'read_guard_warn' : 'read_guard_block',
    file: info.relPath,
    estimatedTokens: info.tokens,
    reason: 'bash direct noisy read',
    repeatDiscount: config.savings?.repeatBlockDiscount ?? 0.12
  });

  if (config.mode === 'observe') {
    return {};
  }

  if (config.mode === 'auto') {
    const context = safeBuildAutopilotContext(projectRoot, info.relPath, config);

    return preToolDecision(
      'deny',
      message,
      buildAgentFacingNotice(`${message}\n\n${context}`)
    );
  }

  return preToolDecision(
    info.tokens >= Number(config.thresholds?.hardTokens || 60000) || info.looksLog
      ? 'deny'
      : 'ask',
    message,
    buildAgentFacingNotice(message)
  );
}

function onPostToolUse(projectRoot, config, input) {
  const toolName = input.tool_name || input.toolName;

  if (toolName !== 'Bash') return {};

  const response = input.tool_response || input.toolResponse || {};
  const stdout = typeof response === 'string' ? response : String(response.stdout || '');
  const stderr = typeof response === 'string' ? '' : String(response.stderr || '');

  const result = trimBashOutput(stdout, stderr, config);

  if (!result.changed) return {};

  appendEvent(projectRoot, {
    type: 'bash_output_trimmed',
    originalTokens: result.originalTokens,
    trimmedTokens: result.trimmedTokens,
    omittedLines: result.omittedLines,
    command: String(input.tool_input?.command || '').slice(0, 240)
  });

  const additionalContext = buildAgentFacingNotice(
    `Token Guard trimmed noisy Bash output. Estimated saved: ~${format(Math.max(0, result.originalTokens - result.trimmedTokens))} tokens. Head/tail and error/failure lines were preserved when detected.`
  );

  const updatedToolOutput = {
    stdout: result.stdout,
    stderr: result.stderr,
    interrupted: Boolean(response.interrupted),
    isImage: Boolean(response.isImage)
  };

  return {
    additionalContext,
    updatedToolOutput,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext
    }
  };
}

function onPreCompact(projectRoot, paths, config, input) {
  const handoffResult = updateHandoffFromTranscript(projectRoot, input, {
    source: 'PreCompact'
  });

  appendEvent(projectRoot, {
    type: handoffResult.updated ? 'handoff_generated' : 'handoff_skipped',
    source: 'PreCompact',
    reason: handoffResult.reason,
    filesTouched: handoffResult.filesTouched || 0,
    commandsRun: handoffResult.commandsRun || 0,
    failures: handoffResult.failures || 0
  });

  appendEvent(projectRoot, {
    type: 'precompact_summary'
  });

  const handoff = readLimited(paths.handoff, 260).trim();
  const core = readLimited(paths.memoryCore, Number(config.thresholds?.memoryCoreMaxLines || 150)).trim();

  return additionalContext(
    'PreCompact',
    buildAgentFacingNotice(
      `Before compacting, preserve Token Guard handoff/core facts.\n\n## Core\n${core}\n\n## Handoff\n${handoff}`
    )
  );
}

function onStop(projectRoot, input) {
  const result = updateHandoffFromTranscript(projectRoot, input, {
    source: 'Stop'
  });

  appendEvent(projectRoot, {
    type: result.updated ? 'handoff_generated' : 'handoff_skipped',
    source: 'Stop',
    reason: result.reason,
    filesTouched: result.filesTouched || 0,
    commandsRun: result.commandsRun || 0,
    failures: result.failures || 0
  });

  appendEvent(projectRoot, {
    type: 'stop'
  });

  return {};
}

function onSessionEnd(projectRoot, input) {
  const result = updateHandoffFromTranscript(projectRoot, input, {
    source: 'SessionEnd'
  });

  appendEvent(projectRoot, {
    type: result.updated ? 'handoff_generated' : 'handoff_skipped',
    source: 'SessionEnd',
    reason: result.reason,
    filesTouched: result.filesTouched || 0,
    commandsRun: result.commandsRun || 0,
    failures: result.failures || 0
  });

  appendEvent(projectRoot, {
    type: 'session_end'
  });

  return {};
}

function getReadWindow(toolInput, input) {
  const offset = Number(toolInput.offset ?? input.offset ?? 0);
  const limitRaw = toolInput.limit ?? input.limit;
  const limit = limitRaw == null ? 0 : Number(limitRaw);

  return {
    hasWindow: limitRaw != null || toolInput.offset != null || input.offset != null,
    offset: Number.isFinite(offset) ? offset : 0,
    limit: Number.isFinite(limit) ? limit : 0
  };
}

function safeBuildAutopilotContext(projectRoot, file, config) {
  try {
    const context = buildContextForFile(projectRoot, file, {
      config,
      maxTokens: config.thresholds?.precisionReadMaxTokens || 6000
    });

    appendEvent(projectRoot, {
      type: 'autopilot_context_injected',
      file,
      originalTokens: context.originalTokens || 0,
      returnedTokens: context.returnedTokens || 0,
      savedTokens: Math.max(0, Number(context.originalTokens || 0) - Number(context.returnedTokens || 0)),
      kind: context.kind
    });

    return formatContextResult(context);
  } catch (err) {
    appendEvent(projectRoot, {
      type: 'autopilot_context_failed',
      file,
      message: err.message
    });

    return `Token Guard could not generate autopilot context for ${file}: ${err.message}\nTry: tg ctx ${file}`;
  }
}

function costMessage(file, tokens, reason) {
  return (
    `Token Guard: full read of ${file} costs ~${format(tokens)} tokens (${reason}). ` +
    `Prefer a narrow Read window, \`tg ctx ${file}\`, \`tg ctx ${file} --focus <symbol-or-topic>\`, or \`tg ctx ${file} --lines A:B\`. ` +
    `Force once with \`token-guard allow ${file} --once\` / \`@tg:force-read ${file}\`.`
  );
}

function preToolDecision(permissionDecision, reason, additionalContext = '') {
  const hookSpecificOutput = {
    hookEventName: 'PreToolUse',
    permissionDecision,
    permissionDecisionReason: reason
  };

  if (additionalContext) {
    hookSpecificOutput.additionalContext = additionalContext;
  }

  return {
    hookSpecificOutput
  };
}

function additionalContext(hookEventName, text) {
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext: text
    }
  };
}

function consumeForceRead(projectRoot, config, relPath, absolutePath) {
  const once = [...(config.forceRead?.once || [])];

  if (!once.length) return false;

  const candidates = new Set([
    '*',
    relPath,
    relPath.replace(/^\.\//, ''),
    absolutePath,
    path.basename(relPath)
  ]);

  if (absolutePath) {
    candidates.add(rel(projectRoot, absolutePath));
  }

  const idx = once.findIndex(entry => {
    const e = String(entry || '').replace(/^\.\//, '');
    if (e === '*') return true;

    if (candidates.has(e)) return true;

    const entryAbs = path.isAbsolute(e) ? e : path.join(projectRoot, e);
    const entryRel = rel(projectRoot, entryAbs);

    return (
      candidates.has(entryAbs) ||
      candidates.has(entryRel) ||
      relPath === entryRel ||
      relPath.endsWith(`/${e}`) ||
      relPath.endsWith(`/${path.basename(e)}`)
    );
  });

  if (idx < 0) return false;

  once.splice(idx, 1);

  saveConfig(projectRoot, {
    ...config,
    forceRead: {
      ...(config.forceRead || {}),
      once
    }
  });

  return true;
}

function extractBashFileCandidate(command) {
  const tokens =
    command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(t =>
      t.replace(/^['"]|['"]$/g, '')
    ) || [];

  const readCommands = new Set(['cat', 'less', 'more', 'head', 'tail']);

  for (let i = 0; i < tokens.length; i += 1) {
    const cmd = tokens[i];

    if (!readCommands.has(cmd)) continue;

    const candidates = [];

    for (let j = i + 1; j < tokens.length; j += 1) {
      const t = tokens[j];

      if (['|', '&&', '||', ';'].includes(t)) break;
      if (t.startsWith('-')) continue;
      if (/^\d+$/.test(t)) continue;

      candidates.push(t);
    }

    if (candidates.length) {
      return candidates[candidates.length - 1];
    }
  }

  return null;
}

function readLimited(file, maxLines) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(0, maxLines).join('\n');
  } catch {
    return '';
  }
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function format(n) {
  return Math.round(Number(n || 0)).toLocaleString('en-US');
}
