import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, ensureProjectFiles } from './project.js';

const DIGEST_NET_FACTOR = 0.25;

export function appendEvent(projectRoot = process.cwd(), event = {}) {
  const paths = ensureProjectFiles(projectRoot);
  const row = normalizeEvent(event);

  ensureDir(path.dirname(paths.ledgerEvents));
  fs.appendFileSync(paths.ledgerEvents, `${JSON.stringify(row)}\n`);

  return row;
}

export function readEvents(projectRoot = process.cwd(), options = {}) {
  const paths = ensureProjectFiles(projectRoot);

  if (!fs.existsSync(paths.ledgerEvents)) {
    return [];
  }

  const since = options.since ? new Date(options.since).getTime() : null;
  const until = options.until ? new Date(options.until).getTime() : null;
  const type = options.type || null;

  return fs
    .readFileSync(paths.ledgerEvents, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(event => {
      if (type && event.type !== type) return false;

      const ts = eventTime(event);

      if (since && ts < since) return false;
      if (until && ts > until) return false;

      return true;
    });
}

export function weeklyEvents(projectRoot = process.cwd(), now = new Date()) {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  return readEvents(projectRoot).filter(event => {
    const ts = eventTime(event);
    return ts >= since.getTime() && ts <= now.getTime();
  });
}

export function todayEvents(projectRoot = process.cwd(), now = new Date()) {
  const day = now.toISOString().slice(0, 10);

  return readEvents(projectRoot).filter(event => eventDay(event) === day);
}

export function summarizeSavings(projectRoot = process.cwd(), options = {}) {
  const events = options.events || weeklyEvents(projectRoot);
  const blocksSeen = new Map();
  const topWasters = new Map();
  const topCompressedCommands = new Map();
  const topContextSavings = new Map();
  const daily = new Map();

  const model = {
    events,

    grossAvoidedTokens: 0,
    netSavingsTokens: 0,
    actualSavingsTokens: 0,
    potentialWasteFlaggedTokens: 0,

    repeatedBlocks: 0,
    fallbackToolCalls: 0,
    fallbackPenaltyTokens: 0,

    hardBlocks: 0,
    softWarnings: 0,

    bashOutputTrimmed: 0,
    bashOutputOriginalTokens: 0,
    bashOutputTrimmedTokens: 0,
    bashOutputSavedTokens: 0,

    contextReads: 0,
    contextReadOriginalTokens: 0,
    contextReadReturnedTokens: 0,
    contextReadSavedTokens: 0,

    reminderDeduped: 0,
    reminderDedupSavedTokens: 0,

    forceReadRequests: 0,
    forceReadUses: 0,

    sessionStarts: 0,
    sessionEnds: 0,
    precompactSummaries: 0,

    handoffsGenerated: 0,
    handoffsSkipped: 0,
    handoffCompressedSavedTokens: 0,

    longInputDigests: 0,
    longInputDigestGrossSavedTokens: 0,
    longInputDigestNetSavedTokens: 0,
    longInputDigestSavedTokens: 0,

    commandCacheHits: 0,
    commandCacheSavedTokens: 0,

    diffReadSavedTokens: 0,

    editOperations: 0,

    tokenGuardOverheadTokens: 0,
    staticRuleInjectionTokens: 0,
    handoffInjectedTokens: 0,
    digestNoticeTokens: 0,
    sessionStartInjectionTokens: 0,

    webBudgetEvents: 0,
    webBudgetPotentialTokens: 0,
    webBudgetBlocks: 0,
    webBudgetBlockedTokens: 0,
    digestSkippedUnchanged: 0,

    subagentDelegations: 0,
    subagentSavedTokens: 0,
    subagentByChildModel: {},
    modelRouteHintsInjected: 0,

    eventCount: events.length,
    topWasters: [],
    topCompressedCommands: [],
    topContextSavings: [],
    daily: [],

    savingsSources: {
      readGuards: 0,
      contextReads: 0,
      longInputDigest: 0,
      bashTrim: 0,
      commandCache: 0,
      diffContext: 0,
      handoffCompression: 0,
      reminderDedup: 0,
      subagentDelegation: 0
    }
  };

  for (const event of events) {
    const day = eventDay(event);
    const d = daily.get(day) || {
      day,
      gross: 0,
      net: 0,
      context: 0,
      bash: 0,
      cache: 0,
      digest: 0,
      diff: 0,
      handoff: 0,
      overhead: 0,
      potential: 0
    };

    if (event.type === 'context_read_saved') {
      const original = positive(event.originalTokens);
      const returned = positive(event.returnedTokens);
      const saved = positive(event.savedTokens || Math.max(0, original - returned));

      if (saved > 0) {
        model.contextReads += 1;
        model.contextReadOriginalTokens += original;
        model.contextReadReturnedTokens += returned;
        model.contextReadSavedTokens += saved;

        model.grossAvoidedTokens += saved;
        model.netSavingsTokens += saved;
        model.savingsSources.contextReads += saved;

        d.gross += saved;
        d.net += saved;
        d.context += saved;

        addTopContextSaving(topContextSavings, event.file, saved, event.method || event.kind || 'ctx');
      }
    }

    if (event.type === 'read_guard_block') {
      const tokens = positive(event.estimatedTokens || event.tokens);
      const key = `${event.file || ''}:${event.reason || ''}`;

      model.grossAvoidedTokens += tokens;
      d.gross += tokens;

      const seen = blocksSeen.get(key) || 0;
      const discount = Number(event.repeatDiscount ?? 0.12);
      const saved = seen > 0 ? Math.round(tokens * discount) : tokens;

      if (seen > 0) {
        model.repeatedBlocks += 1;
      }

      model.netSavingsTokens += saved;
      model.savingsSources.readGuards += saved;
      d.net += saved;

      blocksSeen.set(key, seen + 1);

      model.hardBlocks += 1;

      addTopWaster(topWasters, event.file, tokens);
    }

    if (event.type === 'read_guard_warn') {
      const tokens = positive(event.estimatedTokens || event.tokens);

      model.potentialWasteFlaggedTokens += tokens;
      model.softWarnings += 1;
      d.potential += tokens;

      addTopWaster(topWasters, event.file, tokens);
    }

    if (event.type === 'fallback_tool_use') {
      const cost = positive(event.estimatedCost || 450);

      model.fallbackToolCalls += 1;
      model.fallbackPenaltyTokens += cost;
      model.netSavingsTokens -= cost;
      d.net -= cost;
    }

    if (event.type === 'bash_output_trimmed') {
      const original = positive(event.originalTokens);
      const trimmed = positive(event.trimmedTokens);
      const saved = positive(event.savedTokens || Math.max(0, original - trimmed));

      if (saved > 0) {
        model.bashOutputTrimmed += 1;
        model.bashOutputOriginalTokens += original;
        model.bashOutputTrimmedTokens += trimmed;
        model.bashOutputSavedTokens += saved;

        model.grossAvoidedTokens += saved;
        model.netSavingsTokens += saved;
        model.savingsSources.bashTrim += saved;

        d.gross += saved;
        d.net += saved;
        d.bash += saved;

        addTopCompressedCommand(topCompressedCommands, event.command, saved, event.profile || 'tool');
      }
    }

    if (event.type === 'reminder_deduped') {
      const saved = positive(event.estimatedTokens || 180);

      model.reminderDeduped += 1;
      model.reminderDedupSavedTokens += saved;

      model.grossAvoidedTokens += saved;
      model.netSavingsTokens += saved;
      model.savingsSources.reminderDedup += saved;

      d.gross += saved;
      d.net += saved;
    }

    if (event.type === 'long_input_digest_written') {
      const original = positive(event.originalTokens || event.estimatedTokens);
      const digest = positive(event.digestTokens);
      const grossSaved = positive(Math.max(0, original - digest));
      const netSaved = Math.round(grossSaved * DIGEST_NET_FACTOR);

      model.longInputDigests += 1;
      model.longInputDigestGrossSavedTokens += grossSaved;
      model.longInputDigestNetSavedTokens += netSaved;
      model.longInputDigestSavedTokens += grossSaved;

      model.grossAvoidedTokens += grossSaved;
      model.netSavingsTokens += netSaved;
      model.savingsSources.longInputDigest += grossSaved;

      d.gross += grossSaved;
      d.net += netSaved;
      d.digest += netSaved;
    }

    if (event.type === 'command_cache_hit') {
      const saved = positive(event.savedTokens || event.estimatedTokens);

      model.commandCacheHits += 1;
      model.commandCacheSavedTokens += saved;

      model.grossAvoidedTokens += saved;
      model.netSavingsTokens += saved;
      model.savingsSources.commandCache += saved;

      d.gross += saved;
      d.net += saved;
      d.cache += saved;
    }

    if (event.type === 'diff_read_saved') {
      const saved = positive(event.savedTokens || event.estimatedTokens);

      model.diffReadSavedTokens += saved;

      model.grossAvoidedTokens += saved;
      model.netSavingsTokens += saved;
      model.savingsSources.diffContext += saved;

      d.gross += saved;
      d.net += saved;
      d.diff += saved;
    }

    if (event.type === 'handoff_compressed') {
      const saved = positive(event.savedTokens);

      model.handoffCompressedSavedTokens += saved;

      model.grossAvoidedTokens += saved;
      model.netSavingsTokens += saved;
      model.savingsSources.handoffCompression += saved;

      d.gross += saved;
      d.net += saved;
      d.handoff += saved;
    }

    if (event.type === 'token_guard_overhead') {
      const overhead = positive(event.tokens || event.estimatedTokens);

      model.tokenGuardOverheadTokens += overhead;
      model.netSavingsTokens -= overhead;

      d.net -= overhead;
      d.overhead += overhead;

      if (event.kind === 'static_rules' || event.source === 'static_rules') {
        model.staticRuleInjectionTokens += overhead;
      }

      if (event.kind === 'handoff' || event.source === 'handoff') {
        model.handoffInjectedTokens += overhead;
      }

      if (event.kind === 'digest_notice' || event.source === 'long_input_digest_notice') {
        model.digestNoticeTokens += overhead;
      }

      if (event.kind === 'session_start' || event.source === 'session_start') {
        model.sessionStartInjectionTokens += overhead;
      }
    }

    if (event.type === 'web_budget_observed') {
      const tokens = positive(event.estimatedTokens);

      model.webBudgetEvents += 1;
      model.webBudgetPotentialTokens += tokens;
      model.potentialWasteFlaggedTokens += tokens;

      d.potential += tokens;
    }

    if (event.type === 'web_budget_blocked') {
      const tokens = positive(event.estimatedTokens);

      model.webBudgetBlocks += 1;
      model.webBudgetBlockedTokens += tokens;
      model.grossAvoidedTokens += tokens;
      model.netSavingsTokens += tokens;

      d.gross += tokens;
      d.net += tokens;
    }

    if (event.type === 'long_input_digest_skipped' && event.reason === 'unchanged_hash') {
      model.digestSkippedUnchanged += 1;
    }

    if (event.type === 'subagent_delegation_recorded') {
      const saved = positive(event.savedEquivalentTokens);
      model.subagentDelegations += 1;
      model.subagentSavedTokens += saved;
      model.grossAvoidedTokens += saved;
      model.netSavingsTokens += saved;
      model.savingsSources.subagentDelegation += saved;

      d.gross += saved;
      d.net += saved;

      const childKey = String(event.childModel || 'unknown');
      model.subagentByChildModel[childKey] = (model.subagentByChildModel[childKey] || 0) + saved;
    }

    if (event.type === 'model_route_hint_injected') {
      model.modelRouteHintsInjected += 1;
    }

    if (event.type === 'force_read_requested') {
      model.forceReadRequests += 1;
    }

    if (event.type === 'force_read_used') {
      model.forceReadUses += 1;
    }

    if (event.type === 'session_start') {
      model.sessionStarts += 1;
    }

    if (event.type === 'session_end') {
      model.sessionEnds += 1;
    }

    if (event.type === 'precompact_summary') {
      model.precompactSummaries += 1;
    }

    if (event.type === 'handoff_generated') {
      model.handoffsGenerated += 1;
    }

    if (event.type === 'handoff_skipped') {
      model.handoffsSkipped += 1;
    }

    if (event.type === 'tg_edit_applied') {
      model.editOperations += 1;
    }

    daily.set(day, d);
  }

  model.actualSavingsTokens = Math.round(model.netSavingsTokens);
  model.netSavingsTokens = Math.max(0, Math.round(model.netSavingsTokens));
  model.grossAvoidedTokens = Math.round(model.grossAvoidedTokens);
  model.potentialWasteFlaggedTokens = Math.round(model.potentialWasteFlaggedTokens);

  model.topWasters = [...topWasters.entries()]
    .map(([file, tokens]) => ({ file, tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 10);

  model.topCompressedCommands = [...topCompressedCommands.entries()]
    .map(([, value]) => value)
    .sort((a, b) => b.savedTokens - a.savedTokens)
    .slice(0, 10);

  model.topContextSavings = [...topContextSavings.entries()]
    .map(([, value]) => value)
    .sort((a, b) => b.savedTokens - a.savedTokens)
    .slice(0, 10);

  model.daily = [...daily.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));

  return model;
}

export function summarizeStats(projectRoot = process.cwd()) {
  const now = new Date();

  return {
    today: summarizeSavings(projectRoot, {
      events: todayEvents(projectRoot, now)
    }),
    week: summarizeSavings(projectRoot, {
      events: weeklyEvents(projectRoot, now)
    })
  };
}

export function formatStats(projectRoot = process.cwd()) {
  const stats = summarizeStats(projectRoot);
  const today = stats.today;
  const week = stats.week;

  return `Token Guard stats

Today:
  Net saved: ${format(today.netSavingsTokens)} tokens
  Context reads saved: ${format(today.contextReadSavedTokens)} tokens
  Bash output saved: ${format(today.bashOutputSavedTokens)} tokens
  Long input digest gross: ${format(today.longInputDigestGrossSavedTokens)} tokens
  Subagent delegation saved: ${format(today.subagentSavedTokens)} opus-eq tokens (${today.subagentDelegations} runs)
  TG overhead: ${format(today.tokenGuardOverheadTokens)} tokens

7 days:
  Net saved: ${format(week.netSavingsTokens)} tokens
  Context reads saved: ${format(week.contextReadSavedTokens)} tokens
  Bash output saved: ${format(week.bashOutputSavedTokens)} tokens
  Long input digest gross: ${format(week.longInputDigestGrossSavedTokens)} tokens
  Subagent delegation saved: ${format(week.subagentSavedTokens)} opus-eq tokens (${week.subagentDelegations} runs)
  Potential waste flagged: ${format(week.potentialWasteFlaggedTokens)} tokens
  TG overhead: ${format(week.tokenGuardOverheadTokens)} tokens

Top context savings:
${formatTopContextSavings(week.topContextSavings)}

Top compressed commands:
${formatTopCompressedCommands(week.topCompressedCommands)}
`;
}

export function summarizeEvents(projectRoot = process.cwd(), options = {}) {
  const events = readEvents(projectRoot, options);
  const byType = {};

  for (const event of events) {
    const type = event.type || 'unknown';
    byType[type] = (byType[type] || 0) + 1;
  }

  return {
    total: events.length,
    byType
  };
}

export function clearEvents(projectRoot = process.cwd()) {
  const paths = ensureProjectFiles(projectRoot);

  ensureDir(path.dirname(paths.ledgerEvents));
  fs.writeFileSync(paths.ledgerEvents, '');

  return {
    cleared: true,
    path: paths.ledgerEvents
  };
}

export function readLedgerEvents(projectRoot = process.cwd(), options = {}) {
  return readEvents(projectRoot, options);
}

export function getEvents(projectRoot = process.cwd(), options = {}) {
  return readEvents(projectRoot, options);
}

export function appendLedgerEvent(projectRoot = process.cwd(), event = {}) {
  return appendEvent(projectRoot, event);
}

function normalizeEvent(event = {}) {
  const safe = sanitizeForJson(event);
  const now = new Date().toISOString();

  return {
    ts: safe.ts || safe.timestamp || now,
    timestamp: safe.timestamp || safe.ts || now,
    ...safe,
    type: safe.type || 'event'
  };
}

function eventTime(event) {
  const raw = event.ts || event.timestamp || event.time || 0;
  const value = new Date(raw).getTime();

  return Number.isFinite(value) ? value : 0;
}

export function eventDay(event) {
  const raw = event.ts || event.timestamp || '';

  if (typeof raw === 'string' && raw.length >= 10) {
    return raw.slice(0, 10);
  }

  const time = eventTime(event);

  if (!time) return 'unknown';

  return new Date(time).toISOString().slice(0, 10);
}

function addTopWaster(map, file, tokens) {
  if (!file) return;

  map.set(file, (map.get(file) || 0) + positive(tokens));
}

function addTopCompressedCommand(map, command, savedTokens, profile) {
  if (!command) return;

  const key = command;
  const existing = map.get(key) || {
    command,
    profile,
    savedTokens: 0,
    runs: 0
  };

  existing.savedTokens += positive(savedTokens);
  existing.runs += 1;

  map.set(key, existing);
}

function addTopContextSaving(map, file, savedTokens, method) {
  if (!file) return;

  const existing = map.get(file) || {
    file,
    method,
    savedTokens: 0,
    reads: 0
  };

  existing.savedTokens += positive(savedTokens);
  existing.reads += 1;

  map.set(file, existing);
}

function formatTopContextSavings(rows = []) {
  if (!rows.length) return '  No targeted context savings recorded yet.';

  return rows
    .slice(0, 8)
    .map(row => `  - ${row.file} · ${format(row.savedTokens)} saved · ${row.reads} read(s)`)
    .join('\n');
}

function formatTopCompressedCommands(rows = []) {
  if (!rows.length) return '  No compressed commands recorded yet.';

  return rows
    .slice(0, 8)
    .map(row => `  - ${row.command} · ${format(row.savedTokens)} saved · ${row.runs} run(s)`)
    .join('\n');
}

function positive(value) {
  const n = Number(value || 0);

  if (!Number.isFinite(n)) return 0;

  return Math.max(0, n);
}

function format(value) {
  return Math.round(Number(value || 0)).toLocaleString('en-US');
}

function sanitizeForJson(value) {
  if (value == null) return value;

  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.map(item => sanitizeForJson(item));
  }

  if (typeof value === 'object') {
    const out = {};

    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'function') continue;
      if (typeof item === 'symbol') continue;
      if (typeof item === 'undefined') continue;

      out[key] = sanitizeForJson(item);
    }

    return out;
  }

  return String(value);
}
