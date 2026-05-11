import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, ensureProjectFiles, getPaths } from './project.js';

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

      const ts = event.timestamp ? new Date(event.timestamp).getTime() : 0;

      if (since && ts < since) return false;
      if (until && ts > until) return false;

      return true;
    });
}

export function readLedgerEvents(projectRoot = process.cwd(), options = {}) {
  return readEvents(projectRoot, options);
}

export function getEvents(projectRoot = process.cwd(), options = {}) {
  return readEvents(projectRoot, options);
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

export function summarizeEvents(projectRoot = process.cwd(), options = {}) {
  const events = readEvents(projectRoot, options);

  const byType = {};

  for (const event of events) {
    byType[event.type || 'unknown'] = (byType[event.type || 'unknown'] || 0) + 1;
  }

  return {
    total: events.length,
    byType
  };
}

function normalizeEvent(event = {}) {
  const safe = sanitizeForJson(event);

  return {
    timestamp: new Date().toISOString(),
    ...safe,
    type: safe.type || 'event'
  };
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
