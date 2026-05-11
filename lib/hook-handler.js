import fs from 'node:fs';
import path from 'node:path';
import { appendEvent } from './ledger.js';
import { ensureProjectFiles, loadConfig, rel } from './project.js';
import { allowOnce } from './installer.js';
import { updateHandoffFromTranscript } from './handoff.js';
import { maybeWriteInputDigest } from './input-digest.js';
import { getCachedCommand, saveCommandCache } from './cache.js';
import { buildAgentFacingNotice, buildAutopilotDenyMessage, buildContextForFile, formatContextResult } from './context-router.js';
import { estimateTokens, fileInfo, isAlwaysAllowed, trimBashOutput } from './token-utils.js';

export async function handleHook(eventNameArg, inputOverride) {
  const input = inputOverride ?? readStdinJson();
  const eventName = eventNameArg || input.hook_event_name || input.hookEventName;
  const output = runHook(eventName, input);
  if (inputOverride !== undefined) return output;
  if (output && Object.keys(output).length > 0) process.stdout.write(`${JSON.stringify(output)}\n`);
  return output;
}

export function runHook(eventName, input = {}) {
  const projectRoot = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const paths = ensureProjectFiles(projectRoot);
  const config = loadConfig(projectRoot);
  if (!config.enabled) return {};
  try {
    switch (eventName) {
      case 'SessionStart': return onSessionStart(projectRoot, paths, config);
      case 'UserPromptSubmit': return onUserPromptSubmit(projectRoot, config, input);
      case 'PreToolUse': return onPreToolUse(projectRoot, config, input);
      case 'PostToolUse': return onPostToolUse(projectRoot, config, input);
      case 'PreCompact': return onPreCompact(projectRoot, paths, config, input);
      case 'Stop': return onStop(projectRoot, input);
      case 'SessionEnd': return onSessionEnd(projectRoot, input);
      default: return {};
    }
  } catch (err) {
    appendEvent(projectRoot, { type: 'hook_error', eventName, message: err.message });
    return { suppressOutput: true, systemMessage: `Token Guard hook error: ${err.message}` };
  }
}

function onSessionStart(projectRoot, paths, config) {
  const chunks = [];
  const core = meaningfulFile(paths.memoryCore, Number(config.thresholds?.memoryCoreMaxLines || 150));
  const handoff = meaningfulFile(paths.handoff, 140);
  const inputDigest = meaningfulFile(paths.inputDigest, 120);

  if (core) chunks.push(`## Project Memory\n${core}`);
  if (handoff && !handoff.includes('No handoff has been generated yet')) chunks.push(`## Token Guard Handoff\n${handoff}`);
  if (inputDigest && !inputDigest.includes('No long user input')) chunks.push(`## Long Input Digest\n${inputDigest}`);

  appendEvent(projectRoot, { type: 'session_start', policy: config.policy?.strategy || 'smart' });

  if (!chunks.length) return {};

  const text = `Token Guard dynamic context. Local-only, no daemon, no code upload.\n\n${chunks.join('\n\n')}`;
  appendOverhead(projectRoot, 'session_start_context', text);
  return additionalContext('SessionStart', buildAgentFacingNotice(text));
}

function onUserPromptSubmit(projectRoot, config, input) {
  const prompt = String(input.prompt || input.user_prompt || input.message || '');
  const forceMatches = [...prompt.matchAll(/@tg:force-read\s+([^\s]+)/gi)].map(m => m[1]);
  const allowFull = /@tg:allow-full-read/i.test(prompt);

  for (const file of forceMatches) allowOnce(projectRoot, file);
  if (allowFull) allowOnce(projectRoot, '*');

  if (forceMatches.length || allowFull) {
    appendEvent(projectRoot, { type: 'force_read_requested', files: forceMatches.length ? forceMatches : ['*'] });
  }

  if (config.longInput?.enabled === false) return {};

  const digestResult = maybeWriteInputDigest(projectRoot, prompt, {
    minChars: config.longInput?.minChars || 4000,
    maxChars: config.longInput?.maxDigestChars || 10000,
    maxLines: config.longInput?.maxDigestLines || 140
  });

  if (!digestResult.written) return {};

  appendEvent(projectRoot, {
    type: 'long_input_digest_written',
    originalTokens: digestResult.estimatedTokens,
    digestTokens: digestResult.digestTokens,
    originalChars: digestResult.chars,
    digestChars: digestResult.digestChars,
    requirements: digestResult.requirements,
    anchors: digestResult.anchors,
    questions: digestResult.questions,
    hash: digestResult.hash
  });

  const message = 'Token Guard compressed this long user input into TokenGuard/sessions/input-digest.md. Use it as the working brief for later turns; do not restate the raw prompt.';
  appendOverhead(projectRoot, 'long_input_digest_notice', message);
  return additionalContext('UserPromptSubmit', buildAgentFacingNotice(message));
}

function onPreToolUse(projectRoot, config, input) {
  const toolName = input.tool_name || input.toolName;
  if (toolName === 'Read') return onPreRead(projectRoot, config, input);
  if (toolName === 'Bash') return onPreBash(projectRoot, config, input);
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return onPreWeb(projectRoot, config, input, toolName);
  return {};
}

function onPreRead(projectRoot, config, input) {
  const toolInput = input.tool_input || input.toolInput || {};
  const filePath = toolInput.file_path || toolInput.path || input.file_path || input.path;
  const info = fileInfo(projectRoot, filePath, config);
  if (!info || !info.relPath) return {};
  if (isAlwaysAllowed(info.relPath, config)) return {};

  const readWindow = getReadWindow(toolInput, input);
  const narrowMax = Number(config.thresholds?.narrowReadMaxLines || 200);
  if (readWindow.hasWindow && readWindow.limit > 0 && readWindow.limit <= narrowMax) {
    appendEvent(projectRoot, { type: 'narrow_read_allowed', file: info.relPath, offset: readWindow.offset, limit: readWindow.limit, estimatedTokens: Math.max(1, readWindow.limit * 18) });
    return {};
  }

  if (consumeForceRead(projectRoot, config, info.relPath, info.absolute)) {
    appendEvent(projectRoot, { type: 'force_read_used', file: info.relPath, estimatedTokens: info.tokens });
    const message = `Token Guard force-read used for ${info.relPath}. This one-time override allowed a full read (~${format(info.tokens)} tokens).`;
    appendOverhead(projectRoot, 'force_read_notice', message);
    return preToolDecision('allow', message, buildAgentFacingNotice(message));
  }

  if (!info.exists) return {};

  const soft = Number(config.thresholds?.softTokens || 25000);
  const hard = Number(config.thresholds?.hardTokens || 60000);
  const fullRead = !readWindow.hasWindow;
  const highConfidenceWaste = fullRead && (info.alwaysGuarded || info.looksLog || info.tokens >= hard);
  const potentialWaste = fullRead && info.tokens >= soft;

  if (!highConfidenceWaste) {
    if (potentialWaste) appendEvent(projectRoot, { type: 'read_guard_warn', file: info.relPath, estimatedTokens: info.tokens, reason: 'large full read allowed by smart policy', fullRead: true });
    return {};
  }

  appendEvent(projectRoot, { type: 'read_guard_block', file: info.relPath, estimatedTokens: info.tokens, reason: info.alwaysGuarded ? 'generated/dependency/build/lock pattern' : info.looksLog ? 'log/noisy output file' : 'huge full read', repeatDiscount: config.savings?.repeatBlockDiscount ?? 0.12, smart: true });

  const context = safeBuildAutopilotContext(projectRoot, info.relPath, config);
  const message = buildAutopilotDenyMessage(info.relPath, info.tokens);
  const injected = `${message}\n\n${context}`;
  appendOverhead(projectRoot, 'read_guard_replacement_context', injected);
  return preToolDecision('deny', message, buildAgentFacingNotice(injected));
}

function onPreBash(projectRoot, config, input) {
  const command = String(input.tool_input?.command || input.toolInput?.command || input.command || '');
  if (!command.trim()) return {};

  const cached = safeCommandCacheHit(projectRoot, command, config);
  if (cached) {
    const saved = Math.max(0, Number(cached.originalTokens || cached.outputTokens || 0) - 20);
    appendEvent(projectRoot, { type: 'command_cache_hit', command: command.slice(0, 240), savedTokens: saved });
    const message = `Token Guard reused cached output for a repeated read-only command.\n\nCommand:\n${command}\n\nCached output:\n${cached.output}`;
    appendOverhead(projectRoot, 'command_cache_context', message);
    return preToolDecision('deny', `Token Guard reused cached command output for: ${command.slice(0, 160)}`, buildAgentFacingNotice(message));
  }

  if (/\b(sed|grep|rg|awk|perl|python|python3|node)\b/.test(command)) {
    appendEvent(projectRoot, { type: 'fallback_tool_use', command: command.slice(0, 240), estimatedCost: config.savings?.fallbackPenaltyTokens || 450 });
  }

  const candidate = extractBashFileCandidate(command);
  if (!candidate) return {};
  const info = fileInfo(projectRoot, candidate, config);
  if (!info || !info.exists || isAlwaysAllowed(info.relPath, config)) return {};

  const soft = Number(config.thresholds?.softTokens || 25000);
  const isHighConfidenceNoisyDump = /\b(cat|less|more)\b/.test(command) && (info.tokens >= soft || info.looksLog || info.alwaysGuarded);
  if (!isHighConfidenceNoisyDump) return {};

  appendEvent(projectRoot, { type: 'read_guard_block', file: info.relPath, estimatedTokens: info.tokens, reason: 'bash direct noisy read', repeatDiscount: config.savings?.repeatBlockDiscount ?? 0.12, smart: true });
  const context = safeBuildAutopilotContext(projectRoot, info.relPath, config);
  const message = `Bash command may dump ~${format(info.tokens)} tokens from ${info.relPath}. Token Guard replaced it with targeted context.`;
  const injected = `${message}\n\n${context}`;
  appendOverhead(projectRoot, 'bash_dump_replacement_context', injected);
  return preToolDecision('deny', message, buildAgentFacingNotice(injected));
}

function onPreWeb(projectRoot, config, input, toolName) {
  const toolInput = input.tool_input || input.toolInput || {};
  const query = toolInput.query || toolInput.url || toolInput.prompt || JSON.stringify(toolInput).slice(0, 300);
  if (!query) return {};
  appendEvent(projectRoot, { type: 'web_budget_observed', toolName, query: String(query).slice(0, 240), estimatedTokens: 2500 });
  // Claude Code web tools may not be replaceable through hooks. Record budget signal only.
  return {};
}

function onPostToolUse(projectRoot, config, input) {
  const toolName = input.tool_name || input.toolName;

  if (toolName !== 'Bash') return {};

  const response = input.tool_response || input.toolResponse || {};
  const stdout = typeof response === 'string' ? response : String(response.stdout || '');
  const stderr = typeof response === 'string' ? '' : String(response.stderr || '');
  const command = String(input.tool_input?.command || input.toolInput?.command || input.command || '');

  const result = trimBashOutput(stdout, stderr, {
    ...config,
    command
  });

  if (!result.changed) return {};

  const originalTokens = Number(result.originalTokens || 0);
  const trimmedTokens = Number(result.trimmedTokens || 0);
  const saved = Math.max(0, Number(result.savedTokens || 0) || originalTokens - trimmedTokens);

  // Critical fix:
  // If Token Guard did not actually reduce tokens, do not replace tool output,
  // do not write a trim event, and do not add a notice. This avoids false savings
  // and prevents small outputs from becoming larger due to trim headers.
  if (saved <= 0 || trimmedTokens >= originalTokens) {
    return {};
  }

  appendEvent(projectRoot, {
    type: 'bash_output_trimmed',
    profile: result.profile || 'generic',
    command: command.slice(0, 240),
    originalTokens,
    trimmedTokens,
    savedTokens: saved,
    inBytes: result.inBytes || Buffer.byteLength(`${stdout}\n${stderr}`, 'utf8'),
    outBytes: result.outBytes || Buffer.byteLength(`${result.stdout || ''}\n${result.stderr || ''}`, 'utf8'),
    savedBytes: result.savedBytes || 0,
    omittedLines: result.omittedLines,
    preservedSignals: result.preservedSignals || {}
  });

  const additionalContext =
    `Token Guard compressed ${result.profile || 'tool'} output and preserved diagnostic signals. ` +
    `Estimated saved: ~${format(saved)} tokens.`;

  const updatedToolOutput = {
    stdout: result.stdout,
    stderr: result.stderr,
    interrupted: Boolean(response.interrupted),
    isImage: Boolean(response.isImage)
  };

  appendEvent(projectRoot, {
    type: 'token_guard_overhead',
    source: 'bash_trim_notice',
    tokens: Math.ceil(additionalContext.length / 4),
    chars: additionalContext.length
  });

  return {
    additionalContext,
    updatedToolOutput,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext
    }
  };
}

function onPostBash(projectRoot, config, input) {
  const response = input.tool_response || input.toolResponse || {};
  const stdout = typeof response === 'string' ? response : String(response.stdout || '');
  const stderr = typeof response === 'string' ? '' : String(response.stderr || '');
  const command = String(input.tool_input?.command || input.toolInput?.command || '').slice(0, 2000);
  saveCommandCache(projectRoot, command, stdout, stderr, config);
  const result = trimBashOutput(stdout, stderr, config);
  if (!result.changed) return {};

  appendEvent(projectRoot, { type: 'bash_output_trimmed', originalTokens: result.originalTokens, trimmedTokens: result.trimmedTokens, omittedLines: result.omittedLines, command: command.slice(0, 240) });
  const additionalContext = buildAgentFacingNotice(`Token Guard trimmed noisy Bash output. Estimated saved: ~${format(Math.max(0, result.originalTokens - result.trimmedTokens))} tokens. Head/tail and error/failure lines were preserved when detected.`);
  appendOverhead(projectRoot, 'bash_trim_notice', additionalContext);
  return { additionalContext, updatedToolOutput: { stdout: result.stdout, stderr: result.stderr, interrupted: Boolean(response.interrupted), isImage: Boolean(response.isImage) }, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } };
}

function onPostWeb(projectRoot, config, input, toolName) {
  const response = input.tool_response || input.toolResponse || {};
  const text = typeof response === 'string' ? response : JSON.stringify(response).slice(0, 20000);
  const tokens = estimateTokens(text);
  appendEvent(projectRoot, { type: 'web_output_observed', toolName, outputTokens: tokens });
  return {};
}

function onPreCompact(projectRoot, paths, config, input) {
  const r = updateHandoffFromTranscript(projectRoot, input, { source: 'PreCompact' });
  appendEvent(projectRoot, { type: r.updated ? 'handoff_generated' : 'handoff_skipped', source: 'PreCompact', reason: r.reason, filesTouched: r.filesTouched || 0, commandsRun: r.commandsRun || 0, failures: r.failures || 0, handoffTokens: estimateTokens(readLimited(paths.handoff, 200)) });
  appendEvent(projectRoot, { type: 'precompact_summary' });
  const handoff = meaningfulFile(paths.handoff, 160);
  if (!handoff) return {};
  const text = `Before compacting, preserve this compressed Token Guard handoff.\n\n${handoff}`;
  appendOverhead(projectRoot, 'precompact_handoff_context', text);
  return additionalContext('PreCompact', buildAgentFacingNotice(text));
}
function onStop(projectRoot, input) { const r = updateHandoffFromTranscript(projectRoot, input, { source: 'Stop' }); appendEvent(projectRoot, { type: r.updated ? 'handoff_generated' : 'handoff_skipped', source: 'Stop', reason: r.reason, filesTouched: r.filesTouched || 0, commandsRun: r.commandsRun || 0, failures: r.failures || 0 }); appendEvent(projectRoot, { type: 'stop' }); return {}; }
function onSessionEnd(projectRoot, input) { const r = updateHandoffFromTranscript(projectRoot, input, { source: 'SessionEnd' }); appendEvent(projectRoot, { type: r.updated ? 'handoff_generated' : 'handoff_skipped', source: 'SessionEnd', reason: r.reason, filesTouched: r.filesTouched || 0, commandsRun: r.commandsRun || 0, failures: r.failures || 0 }); appendEvent(projectRoot, { type: 'session_end' }); return {}; }

function safeCommandCacheHit(projectRoot, command, config) {
  if (config.cache?.enabled === false || config.cache?.smartReuse === false) return null;
  if (!isLowRiskCacheableCommand(command)) return null;
  return getCachedCommand(projectRoot, command, config);
}
function isLowRiskCacheableCommand(command) { return /^(git status|git diff --stat|git branch|pwd|ls\b|rg\b|grep\b)/.test(String(command || '').trim()); }
function getReadWindow(toolInput, input) { const offset = Number(toolInput.offset ?? input.offset ?? 0); const limitRaw = toolInput.limit ?? input.limit; const limit = limitRaw == null ? 0 : Number(limitRaw); return { hasWindow: limitRaw != null || toolInput.offset != null || input.offset != null, offset: Number.isFinite(offset) ? offset : 0, limit: Number.isFinite(limit) ? limit : 0 }; }
function safeBuildAutopilotContext(projectRoot, file, config) { try { const context = buildContextForFile(projectRoot, file, { config, maxTokens: config.thresholds?.precisionReadMaxTokens || 6000 }); appendEvent(projectRoot, { type: 'autopilot_context_injected', file, originalTokens: context.originalTokens || 0, returnedTokens: context.returnedTokens || 0, savedTokens: Math.max(0, Number(context.originalTokens || 0) - Number(context.returnedTokens || 0)), kind: context.kind }); return formatContextResult(context); } catch (err) { appendEvent(projectRoot, { type: 'autopilot_context_failed', file, message: err.message }); return `Token Guard could not generate autopilot context for ${file}: ${err.message}\nTry: tg ctx ${file}`; } }
function preToolDecision(permissionDecision, reason, additionalContext = '') { const hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: reason }; if (additionalContext) hookSpecificOutput.additionalContext = additionalContext; return { hookSpecificOutput }; }
function additionalContext(hookEventName, text) { return { hookSpecificOutput: { hookEventName, additionalContext: text } }; }
function consumeForceRead(projectRoot, config, relPath, absolutePath) { const once = [...(config.forceRead?.once || [])]; if (!once.length) return false; const candidates = new Set(['*', relPath, relPath.replace(/^\.\//, ''), absolutePath, path.basename(relPath)]); if (absolutePath) candidates.add(rel(projectRoot, absolutePath)); const idx = once.findIndex(entry => { const e = String(entry || '').replace(/^\.\//, ''); if (e === '*') return true; if (candidates.has(e)) return true; const entryAbs = path.isAbsolute(e) ? e : path.join(projectRoot, e); const entryRel = rel(projectRoot, entryAbs); return candidates.has(entryAbs) || candidates.has(entryRel) || relPath === entryRel || relPath.endsWith(`/${e}`) || relPath.endsWith(`/${path.basename(e)}`); }); if (idx < 0) return false; once.splice(idx, 1); config.forceRead = { ...(config.forceRead || {}), once }; fs.writeFileSync(path.join(projectRoot, 'TokenGuard', 'config.json'), `${JSON.stringify(config, null, 2)}\n`); return true; }
function extractBashFileCandidate(command) { const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(t => t.replace(/^["']|["']$/g, '')) || []; const readCommands = new Set(['cat', 'less', 'more', 'head', 'tail']); for (let i = 0; i < tokens.length; i += 1) { if (!readCommands.has(tokens[i])) continue; const candidates = []; for (let j = i + 1; j < tokens.length; j += 1) { const t = tokens[j]; if (['|', '&&', '||', ';'].includes(t)) break; if (t.startsWith('-') || /^\d+$/.test(t)) continue; candidates.push(t); } if (candidates.length) return candidates[candidates.length - 1]; } return null; }
function meaningfulFile(file, maxLines) { try { const raw = fs.readFileSync(file, 'utf8'); if (!raw.trim()) return ''; const meaningful = raw.split(/\r?\n/).filter(line => line.trim() && !/^#\s*(Token Guard Core Memory|Decisions|Gotchas|Long Input Digest|Next Session Handoff)\s*$/.test(line.trim()) && !/No long user input|No handoff has been generated/.test(line)).join('\n').trim(); if (!meaningful) return ''; return raw.split(/\r?\n/).slice(0, maxLines).join('\n'); } catch { return ''; } }
function readLimited(file, maxLines) { try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(0, maxLines).join('\n'); } catch { return ''; } }
function appendOverhead(projectRoot, source, text) { appendEvent(projectRoot, { type: 'token_guard_overhead', source, tokens: estimateTokens(text), chars: String(text || '').length }); }
function readStdinJson() { try { const raw = fs.readFileSync(0, 'utf8'); return raw.trim() ? JSON.parse(raw) : {}; } catch { return {}; } }
function format(n) { return Math.round(Number(n || 0)).toLocaleString('en-US'); }
