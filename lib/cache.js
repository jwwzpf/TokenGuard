import fs from 'node:fs';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import { ensureProjectFiles, readJson, writeJson } from './project.js';
import { estimateTokens, summarizeCommandOutput } from './token-utils.js';

export function isCacheableCommand(command = '') {
  const c = String(command || '').trim();
  if (!c) return false;
  return /^(git\s+status|git\s+diff\s+--stat|git\s+diff\s+--name-only|git\s+log\s|rg\s+|grep\s+)/.test(c);
}

export function commandFingerprint(projectRoot, command) {
  const gitState = safeGitState(projectRoot);
  return hashText(JSON.stringify({ command: String(command || '').trim(), gitState }));
}

export function getCachedCommand(projectRoot, command, config = {}) {
  if (config.cache?.enabled === false || !isCacheableCommand(command)) return null;
  const paths = ensureProjectFiles(projectRoot);
  const cache = readJson(paths.commandCache, {});
  const key = commandFingerprint(projectRoot, command);
  const entry = cache[key];
  if (!entry) return null;
  const ttl = Number(config.cache?.ttlMs || 5 * 60 * 1000);
  if (Date.now() - Date.parse(entry.ts || 0) > ttl) return null;
  return { ...entry, key };
}

export function saveCommandCache(projectRoot, command, stdout = '', stderr = '', config = {}) {
  if (config.cache?.enabled === false || !isCacheableCommand(command)) return null;
  const paths = ensureProjectFiles(projectRoot);
  const cache = readJson(paths.commandCache, {});
  const key = commandFingerprint(projectRoot, command);
  const raw = [stdout, stderr].filter(Boolean).join('\n');
  const summary = summarizeCommandOutput(raw, {
    maxChars: config.cache?.maxOutputChars || 12000,
    maxLines: config.thresholds?.bashOutputMaxLines || 140
  });
  cache[key] = {
    ts: new Date().toISOString(),
    command: String(command || '').trim(),
    output: summary,
    outputTokens: estimateTokens(summary),
    originalTokens: estimateTokens(raw)
  };
  writeJson(paths.commandCache, cache);
  return cache[key];
}

function safeGitState(projectRoot) {
  try {
    const head = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const status = childProcess.execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { head, statusHash: hashText(status) };
  } catch {
    return { head: 'nogit', statusHash: 'unknown' };
  }
}

function hashText(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex');
}
