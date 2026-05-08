import fs from 'node:fs';
import { ensureProjectFiles } from './project.js';

export function appendEvent(projectRoot, event) {
  const paths = ensureProjectFiles(projectRoot);

  const normalized = {
    ts: new Date().toISOString(),
    ...event
  };

  fs.appendFileSync(paths.ledgerEvents, `${JSON.stringify(normalized)}\n`);

  return normalized;
}

export function readEvents(projectRoot) {
  const paths = ensureProjectFiles(projectRoot);

  if (!fs.existsSync(paths.ledgerEvents)) return [];

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

  let grossAvoidedTokens = 0;
  let netSavingsTokens = 0;
  let potentialWasteFlaggedTokens = 0;

  let repeatedBlocks = 0;
  let fallbackToolCalls = 0;
  let fallbackPenaltyTokens = 0;

  let hardBlocks = 0;
  let softWarnings = 0;

  let bashOutputTrimmed = 0;
  let bashOutputOriginalTokens = 0;
  let bashOutputTrimmedTokens = 0;
  let bashOutputSavedTokens = 0;

  let reminderDeduped = 0;
  let reminderDedupSavedTokens = 0;

  let forceReadRequests = 0;
  let forceReadUses = 0;

  let sessionStarts = 0;
  let sessionEnds = 0;
  let precompactSummaries = 0;

  for (const event of events) {
    if (event.type === 'read_guard_block') {
      const tokens = Number(event.estimatedTokens || event.tokens || 0);
      const key = `${event.file || ''}:${event.reason || ''}`;

      grossAvoidedTokens += tokens;

      const seen = blocksSeen.get(key) || 0;

      if (seen > 0) {
        repeatedBlocks += 1;
        netSavingsTokens += Math.round(tokens * Number(event.repeatDiscount ?? 0.12));
      } else {
        netSavingsTokens += tokens;
      }

      blocksSeen.set(key, seen + 1);

      hardBlocks += 1;
      addTopWaster(topWasters, event.file, tokens);
    }

    if (event.type === 'read_guard_warn') {
      const tokens = Number(event.estimatedTokens || event.tokens || 0);
      potentialWasteFlaggedTokens += tokens;
      softWarnings += 1;
      addTopWaster(topWasters, event.file, tokens);
    }

    if (event.type === 'fallback_tool_use') {
      const cost = Number(event.estimatedCost || 450);
      fallbackToolCalls += 1;
      fallbackPenaltyTokens += cost;
      netSavingsTokens -= cost;
    }

    if (event.type === 'bash_output_trimmed') {
      const original = Number(event.originalTokens || 0);
      const trimmed = Number(event.trimmedTokens || 0);
      const saved = Math.max(0, original - trimmed);

      bashOutputTrimmed += 1;
      bashOutputOriginalTokens += original;
      bashOutputTrimmedTokens += trimmed;
      bashOutputSavedTokens += saved;

      grossAvoidedTokens += saved;
      netSavingsTokens += saved;
    }

    if (event.type === 'reminder_deduped') {
      const saved = Number(event.estimatedTokens || 180);

      reminderDeduped += 1;
      reminderDedupSavedTokens += saved;

      grossAvoidedTokens += saved;
      netSavingsTokens += saved;
    }

    if (event.type === 'force_read_requested') {
      forceReadRequests += 1;
    }

    if (event.type === 'force_read_used') {
      forceReadUses += 1;
    }

    if (event.type === 'session_start') {
      sessionStarts += 1;
    }

    if (event.type === 'session_end') {
      sessionEnds += 1;
    }

    if (event.type === 'precompact_summary') {
      precompactSummaries += 1;
    }
  }

  netSavingsTokens = Math.max(0, Math.round(netSavingsTokens));

  return {
    events,

    grossAvoidedTokens: Math.round(grossAvoidedTokens),
    netSavingsTokens,
    potentialWasteFlaggedTokens: Math.round(potentialWasteFlaggedTokens),

    repeatedBlocks,
    fallbackToolCalls,
    fallbackPenaltyTokens: Math.round(fallbackPenaltyTokens),

    hardBlocks,
    softWarnings,

    bashOutputTrimmed,
    bashOutputOriginalTokens: Math.round(bashOutputOriginalTokens),
    bashOutputTrimmedTokens: Math.round(bashOutputTrimmedTokens),
    bashOutputSavedTokens: Math.round(bashOutputSavedTokens),

    reminderDeduped,
    reminderDedupSavedTokens: Math.round(reminderDedupSavedTokens),

    forceReadRequests,
    forceReadUses,

    sessionStarts,
    sessionEnds,
    precompactSummaries,

    eventCount: events.length,
    topWasters: [...topWasters.entries()]
      .map(([file, tokens]) => ({
        file,
        tokens
      }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 10)
  };
}

function addTopWaster(map, file, tokens) {
  if (!file) return;
  map.set(file, (map.get(file) || 0) + Number(tokens || 0));
}
