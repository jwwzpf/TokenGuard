import fs from 'node:fs';
import path from 'node:path';
import { ensureProjectFiles, getPaths, ensureDir } from './project.js';

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
  let gross = 0;
  let net = 0;
  let fallbackCost = 0;
  let repeatedBlocks = 0;
  let hardBlocks = 0;
  let softWarnings = 0;

  for (const event of events) {
    if (event.type === 'read_guard_block' || event.type === 'read_guard_warn') {
      const tokens = Number(event.estimatedTokens || event.tokens || 0);
      gross += tokens;
      const key = `${event.file || ''}:${event.reason || ''}`;
      const seen = blocksSeen.get(key) || 0;
      if (seen > 0) {
        repeatedBlocks += 1;
        net += Math.round(tokens * Number(event.repeatDiscount ?? 0.12));
      } else {
        net += tokens;
      }
      blocksSeen.set(key, seen + 1);
      if (event.type === 'read_guard_block') hardBlocks += 1;
      if (event.type === 'read_guard_warn') softWarnings += 1;
    }
    if (event.type === 'fallback_tool_use') {
      const cost = Number(event.estimatedCost || 450);
      fallbackCost += cost;
      net -= cost;
    }
    if (event.type === 'handoff_suggested') {
      net += Number(event.estimatedTokens || 0);
      gross += Number(event.estimatedTokens || 0);
    }
  }

  net = Math.max(0, Math.round(net));
  return {
    events,
    grossTokensSaved: Math.round(gross),
    netTokensSaved: net,
    fallbackCost: Math.round(fallbackCost),
    repeatedBlocks,
    hardBlocks,
    softWarnings,
    eventCount: events.length
  };
}
