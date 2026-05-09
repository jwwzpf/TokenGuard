import fs from 'node:fs';
import { ensureProjectFiles } from './project.js';

export function appendEvent(projectRoot, event) {
  const paths = ensureProjectFiles(projectRoot);
  const normalized = { ts: new Date().toISOString(), ...event };
  fs.appendFileSync(paths.ledgerEvents, `${JSON.stringify(normalized)}\n`);
  return normalized;
}

export function readEvents(projectRoot) {
  const paths = ensureProjectFiles(projectRoot);
  if (!fs.existsSync(paths.ledgerEvents)) return [];
  return fs.readFileSync(paths.ledgerEvents, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

export function weeklyEvents(projectRoot, now = new Date()) {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return readEvents(projectRoot).filter(event => {
    const ts = new Date(event.ts || 0);
    return ts >= since && ts <= now;
  });
}

export function summarizeSavings(projectRoot) {
  const events = weeklyEvents(projectRoot);
  const blocksSeen = new Map();
  const topWasters = new Map();
  const daily = new Map();

  const model = {
    events,
    grossAvoidedTokens: 0,
    netSavingsTokens: 0,
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
    reminderDeduped: 0,
    reminderDedupSavedTokens: 0,
    forceReadRequests: 0,
    forceReadUses: 0,
    sessionStarts: 0,
    sessionEnds: 0,
    precompactSummaries: 0,
    handoffsGenerated: 0,
    handoffsSkipped: 0,
    longInputDigests: 0,
    longInputDigestSavedTokens: 0,
    commandCacheHits: 0,
    commandCacheSavedTokens: 0,
    diffReadSavedTokens: 0,
    editOperations: 0,
    eventCount: events.length,
    topWasters: [],
    daily: []
  };

  for (const event of events) {
    const day = (event.ts || '').slice(0, 10) || 'unknown';
    const d = daily.get(day) || { day, gross: 0, net: 0, bash: 0, cache: 0, digest: 0 };

    if (event.type === 'read_guard_block') {
      const tokens = Number(event.estimatedTokens || event.tokens || 0);
      const key = `${event.file || ''}:${event.reason || ''}`;
      model.grossAvoidedTokens += tokens;
      d.gross += tokens;
      const seen = blocksSeen.get(key) || 0;
      const saved = seen > 0 ? Math.round(tokens * Number(event.repeatDiscount ?? 0.12)) : tokens;
      if (seen > 0) model.repeatedBlocks += 1;
      model.netSavingsTokens += saved;
      d.net += saved;
      blocksSeen.set(key, seen + 1);
      model.hardBlocks += 1;
      addTopWaster(topWasters, event.file, tokens);
    }

    if (event.type === 'read_guard_warn') {
      const tokens = Number(event.estimatedTokens || event.tokens || 0);
      model.potentialWasteFlaggedTokens += tokens;
      model.softWarnings += 1;
      addTopWaster(topWasters, event.file, tokens);
    }

    if (event.type === 'fallback_tool_use') {
      const cost = Number(event.estimatedCost || 450);
      model.fallbackToolCalls += 1;
      model.fallbackPenaltyTokens += cost;
      model.netSavingsTokens -= cost;
      d.net -= cost;
    }

    if (event.type === 'bash_output_trimmed') {
      const original = Number(event.originalTokens || 0);
      const trimmed = Number(event.trimmedTokens || 0);
      const saved = Math.max(0, original - trimmed);
      model.bashOutputTrimmed += 1;
      model.bashOutputOriginalTokens += original;
      model.bashOutputTrimmedTokens += trimmed;
      model.bashOutputSavedTokens += saved;
      model.grossAvoidedTokens += saved;
      model.netSavingsTokens += saved;
      d.gross += saved;
      d.net += saved;
      d.bash += saved;
    }

    if (event.type === 'reminder_deduped') {
      const saved = Number(event.estimatedTokens || 180);
      model.reminderDeduped += 1;
      model.reminderDedupSavedTokens += saved;
      model.grossAvoidedTokens += saved;
      model.netSavingsTokens += saved;
      d.gross += saved;
      d.net += saved;
    }

    if (event.type === 'long_input_digest_written') {
      const saved = Math.max(0, Number(event.originalTokens || 0) - Number(event.digestTokens || 0));
      model.longInputDigests += 1;
      model.longInputDigestSavedTokens += saved;
      // Digest savings are potential future savings; count lightly in net to stay credible.
      const adjusted = Math.round(saved * 0.25);
      model.grossAvoidedTokens += saved;
      model.netSavingsTokens += adjusted;
      d.gross += saved;
      d.net += adjusted;
      d.digest += adjusted;
    }

    if (event.type === 'command_cache_hit') {
      const saved = Number(event.savedTokens || 0);
      model.commandCacheHits += 1;
      model.commandCacheSavedTokens += saved;
      model.grossAvoidedTokens += saved;
      model.netSavingsTokens += saved;
      d.gross += saved;
      d.net += saved;
      d.cache += saved;
    }

    if (event.type === 'diff_read_saved') {
      const saved = Number(event.savedTokens || 0);
      model.diffReadSavedTokens += saved;
      model.grossAvoidedTokens += saved;
      model.netSavingsTokens += saved;
      d.gross += saved;
      d.net += saved;
    }

    if (event.type === 'force_read_requested') model.forceReadRequests += 1;
    if (event.type === 'force_read_used') model.forceReadUses += 1;
    if (event.type === 'session_start') model.sessionStarts += 1;
    if (event.type === 'session_end') model.sessionEnds += 1;
    if (event.type === 'precompact_summary') model.precompactSummaries += 1;
    if (event.type === 'handoff_generated') model.handoffsGenerated += 1;
    if (event.type === 'handoff_skipped') model.handoffsSkipped += 1;
    if (event.type === 'tg_edit_applied') model.editOperations += 1;

    daily.set(day, d);
  }

  model.netSavingsTokens = Math.max(0, Math.round(model.netSavingsTokens));
  model.grossAvoidedTokens = Math.round(model.grossAvoidedTokens);
  model.potentialWasteFlaggedTokens = Math.round(model.potentialWasteFlaggedTokens);
  model.topWasters = [...topWasters.entries()]
    .map(([file, tokens]) => ({ file, tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 10);
  model.daily = [...daily.values()].sort((a, b) => a.day.localeCompare(b.day));
  return model;
}

function addTopWaster(map, file, tokens) {
  if (!file) return;
  map.set(file, (map.get(file) || 0) + Number(tokens || 0));
}
