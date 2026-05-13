import fs from 'node:fs';
import path from 'node:path';
import { ensureProjectFiles, loadConfig } from './project.js';
import { appendEvent } from './ledger.js';
import { estimateTokens } from './token-utils.js';

const TURN_LOG_BASENAME = 'codex-turns.jsonl';
const DEFAULT_WARN_TOKENS = 80000;
const DEFAULT_SWITCH_TOKENS = 120000;
const DEFAULT_WARN_TURNS = 40;
const DEFAULT_SWITCH_TURNS = 80;

export function turnTick(projectRoot = process.cwd(), input = {}) {
  const paths = ensureProjectFiles(projectRoot);
  const config = loadConfig(projectRoot);
  const turnLog = path.join(paths.sessions, TURN_LOG_BASENAME);

  const prompt = String(input.prompt || '');
  const outputTokens = Number(input.output_tokens || input.outputTokens || 0);
  const tools = normalizeTools(input.tool || input.tools);
  const note = String(input.note || '').slice(0, 200);

  const promptTokens = prompt ? estimateTokens(prompt) : Number(input.prompt_tokens || input.promptTokens || 0);
  const turnTokens = promptTokens + outputTokens;

  const previous = readTurnLog(turnLog);
  const lastSession = findCurrentSession(previous);
  const cumulative = (lastSession?.cumulative || 0) + turnTokens;
  const turnIndex = (lastSession?.turnCount || 0) + 1;

  const record = {
    ts: new Date().toISOString(),
    type: 'turn_tick',
    turn: turnIndex,
    promptTokens,
    outputTokens,
    turnTokens,
    cumulative,
    tools,
    note
  };

  fs.appendFileSync(turnLog, `${JSON.stringify(record)}\n`);

  appendEvent(projectRoot, {
    type: 'codex_turn_tick',
    turn: turnIndex,
    cumulative,
    turnTokens,
    promptTokens,
    outputTokens,
    tools
  });

  return assessSession(record, config);
}

export function sessionCheck(projectRoot = process.cwd(), options = {}) {
  const paths = ensureProjectFiles(projectRoot);
  const config = loadConfig(projectRoot);
  const turnLog = path.join(paths.sessions, TURN_LOG_BASENAME);

  if (options.reset) {
    return resetSession(projectRoot, turnLog);
  }

  const records = readTurnLog(turnLog);
  const current = findCurrentSession(records);

  const state = current || {
    sessionStartedAt: null,
    turnCount: 0,
    cumulative: 0,
    lastTickAt: null,
    handoffWrittenAt: null
  };

  appendEvent(projectRoot, {
    type: 'codex_session_check',
    cumulative: state.cumulative,
    turnCount: state.turnCount
  });

  return assessSession(state, config);
}

export function resetSession(projectRoot = process.cwd(), turnLogPath = null) {
  const paths = ensureProjectFiles(projectRoot);
  const config = loadConfig(projectRoot);
  const turnLog = turnLogPath || path.join(paths.sessions, TURN_LOG_BASENAME);

  const marker = {
    ts: new Date().toISOString(),
    type: 'session_start'
  };

  fs.appendFileSync(turnLog, `${JSON.stringify(marker)}\n`);

  appendEvent(projectRoot, {
    type: 'codex_session_reset'
  });

  const assessed = assessSession({ cumulative: 0, turnCount: 0 }, config);
  return { ...assessed, reason: 'session_reset', recommendation: 'New Codex session marker recorded. Start fresh.' };
}

export function getCodexActivity(projectRoot = process.cwd()) {
  const paths = ensureProjectFiles(projectRoot);
  const turnLog = path.join(paths.sessions, TURN_LOG_BASENAME);

  if (!fs.existsSync(turnLog)) {
    return {
      present: false,
      turnCount: 0,
      cumulative: 0,
      lastTickAt: null,
      sessionStartedAt: null
    };
  }

  const records = readTurnLog(turnLog);
  const current = findCurrentSession(records);

  return {
    present: records.length > 0,
    turnCount: current?.turnCount || 0,
    cumulative: current?.cumulative || 0,
    lastTickAt: current?.lastTickAt || null,
    sessionStartedAt: current?.sessionStartedAt || null
  };
}

function assessSession(state, config) {
  const warnTokens = Number(config.codex?.sessionWarnTokens || DEFAULT_WARN_TOKENS);
  const switchTokens = Number(config.codex?.sessionSwitchTokens || DEFAULT_SWITCH_TOKENS);
  const warnTurns = Number(config.codex?.sessionWarnTurns || DEFAULT_WARN_TURNS);
  const switchTurns = Number(config.codex?.sessionSwitchTurns || DEFAULT_SWITCH_TURNS);

  const cumulative = Number(state.cumulative || 0);
  const turnCount = Number(state.turnCount || state.turn || 0);

  let level = 'ok';
  const reasons = [];

  if (cumulative >= switchTokens || turnCount >= switchTurns) {
    level = 'switch';
    if (cumulative >= switchTokens) reasons.push(`cumulative ~${cumulative.toLocaleString('en-US')} tok ≥ ${switchTokens.toLocaleString('en-US')}`);
    if (turnCount >= switchTurns) reasons.push(`${turnCount} turns ≥ ${switchTurns}`);
  } else if (cumulative >= warnTokens || turnCount >= warnTurns) {
    level = 'warn';
    if (cumulative >= warnTokens) reasons.push(`cumulative ~${cumulative.toLocaleString('en-US')} tok ≥ ${warnTokens.toLocaleString('en-US')}`);
    if (turnCount >= warnTurns) reasons.push(`${turnCount} turns ≥ ${warnTurns}`);
  }

  const recommendation = recommendFor(level);

  return {
    level,
    cumulative,
    turnCount,
    warnTokens,
    switchTokens,
    warnTurns,
    switchTurns,
    reason: reasons.join('; ') || 'within budget',
    recommendation,
    handoffSuggested: level !== 'ok'
  };
}

function recommendFor(level) {
  if (level === 'switch') {
    return 'Context heavy. Run `tg handoff write` then start a new Codex session. The new session can SessionStart-load TokenGuard/sessions/handoff.md.';
  }

  if (level === 'warn') {
    return 'Approaching context budget. Prefer narrow Read / `tg ctx`. Consider writing a handoff soon.';
  }

  return 'OK to continue. Keep using narrow reads.';
}

function readTurnLog(file) {
  if (!fs.existsSync(file)) return [];

  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function findCurrentSession(records) {
  if (!records.length) return null;

  let sessionStartedAt = null;
  let turnCount = 0;
  let cumulative = 0;
  let lastTickAt = null;
  let handoffWrittenAt = null;

  for (const record of records) {
    if (record.type === 'session_start') {
      sessionStartedAt = record.ts;
      turnCount = 0;
      cumulative = 0;
      lastTickAt = null;
      handoffWrittenAt = null;
      continue;
    }

    if (record.type === 'handoff_written') {
      handoffWrittenAt = record.ts;
      sessionStartedAt = record.ts;
      turnCount = 0;
      cumulative = 0;
      lastTickAt = null;
      continue;
    }

    if (record.type === 'turn_tick') {
      turnCount = Number(record.turn || turnCount + 1);
      cumulative = Number(record.cumulative || cumulative + (record.turnTokens || 0));
      lastTickAt = record.ts;
    }
  }

  return {
    sessionStartedAt,
    turnCount,
    cumulative,
    lastTickAt,
    handoffWrittenAt
  };
}

function normalizeTools(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean).slice(0, 12);
  return [String(value)].filter(Boolean);
}

export function recordHandoffWritten(projectRoot = process.cwd()) {
  const paths = ensureProjectFiles(projectRoot);
  const turnLog = path.join(paths.sessions, TURN_LOG_BASENAME);
  const marker = {
    ts: new Date().toISOString(),
    type: 'handoff_written'
  };

  fs.appendFileSync(turnLog, `${JSON.stringify(marker)}\n`);
}

export function buildPressureFooter(projectRoot = process.cwd(), increment = 0) {
  const paths = ensureProjectFiles(projectRoot);
  const config = loadConfig(projectRoot);
  const turnLog = path.join(paths.sessions, TURN_LOG_BASENAME);
  const records = readTurnLog(turnLog);
  const current = findCurrentSession(records) || { cumulative: 0, turnCount: 0 };

  const projectedCumulative = current.cumulative + Math.max(0, Number(increment || 0));
  const projectedTurns = current.turnCount;
  const assessed = assessSession({ cumulative: projectedCumulative, turnCount: projectedTurns }, config);

  if (assessed.level === 'ok') return '';

  const icon = assessed.level === 'switch' ? '!' : '*';
  const tag = assessed.level.toUpperCase();
  return `\nToken Guard session-pressure ${icon} ${tag} · ~${projectedCumulative.toLocaleString('en-US')} tok cumulative · ${projectedTurns} turns. ${assessed.recommendation}`;
}

export function formatSessionCheck(result) {
  const lines = [];
  const icon = result.level === 'switch' ? '!' : result.level === 'warn' ? '*' : '✓';

  lines.push(`Token Guard session-check: ${icon} ${result.level.toUpperCase()}`);
  lines.push(`Cumulative: ~${Number(result.cumulative || 0).toLocaleString('en-US')} tokens · Turns: ${result.turnCount || 0}`);
  lines.push(`Thresholds: warn=${result.warnTokens.toLocaleString('en-US')} tok / ${result.warnTurns} turns · switch=${result.switchTokens.toLocaleString('en-US')} tok / ${result.switchTurns} turns`);
  lines.push(`Reason: ${result.reason}`);
  lines.push(`Recommendation: ${result.recommendation}`);

  return lines.join('\n');
}
