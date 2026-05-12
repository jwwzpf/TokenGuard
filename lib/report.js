import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { ensureProjectFiles, getPaths } from './project.js';
import { summarizeSavings } from './ledger.js';

export function generateReport(projectRoot = process.cwd()) {
  const paths = ensureProjectFiles(projectRoot);
  const model = summarizeSavings(projectRoot);
  const display = computeDisplaySavings(model);

  model.displaySavedTokens = display.savedTokens;
  model.displayMode = display.mode;

  const html = renderHtml(model, display);
  const svg = renderShareSvg(model, display);

  fs.writeFileSync(paths.reportHtml, html);
  fs.writeFileSync(paths.reportSvg, svg);

  return {
    html: paths.reportHtml,
    svg: paths.reportSvg,
    model
  };
}

export function openReport(projectRoot = process.cwd()) {
  const paths = getPaths(projectRoot);

  if (!fs.existsSync(paths.reportHtml)) {
    generateReport(projectRoot);
  }

  openPath(paths.reportHtml);
}

export function openFolder(projectRoot = process.cwd()) {
  const paths = ensureProjectFiles(projectRoot);
  openPath(paths.base);
}

function computeDisplaySavings(model = {}) {
  const overhead = positive(model.tokenGuardOverheadTokens);
  const gross = positive(model.grossAvoidedTokens);

  const positiveSources =
    positive(model.contextReadSavedTokens) +
    positive(model.bashOutputSavedTokens) +
    positive(model.longInputDigestGrossSavedTokens || model.longInputDigestSavedTokens) +
    positive(model.commandCacheSavedTokens) +
    positive(model.diffReadSavedTokens) +
    positive(model.handoffCompressedSavedTokens) +
    positive(model.reminderDedupSavedTokens) +
    positive(model.savingsSources?.readGuards);

  const net = positive(model.netSavingsTokens);
  const totalAfterOverhead = Math.max(0, positiveSources - overhead);
  const grossAfterOverhead = Math.max(0, gross - overhead);

  const savedTokens = Math.max(net, totalAfterOverhead, grossAfterOverhead);

  if (savedTokens > 0) {
    return {
      mode: 'saved',
      savedTokens,
      headline: `${formatCompact(savedTokens)} tokens saved`,
      subtitle: 'Estimated total savings after Token Guard overhead.'
    };
  }

  const potential = positive(model.potentialWasteFlaggedTokens);

  if (potential > 0) {
    return {
      mode: 'potential',
      savedTokens: 0,
      headline: `${formatCompact(potential)} tokens protected`,
      subtitle: 'Token Guard found avoidable context. It only intervenes when savings are likely to beat its own overhead.'
    };
  }

  return {
    mode: 'empty',
    savedTokens: 0,
    headline: 'Tracking started',
    subtitle: 'Run a few coding sessions, then generate this report again.'
  };
}

function renderHtml(model, display) {
  const saved = positive(display.savedTokens);
  const proofPoints = buildProofPoints(model);
  const trend = renderTrendSvg(model.daily || []);
  const proofHtml = renderProofPoints(proofPoints);
  const topContext = renderTopContextSavings(model.topContextSavings || []);
  const topCommands = renderTopCompressedCommands(model.topCompressedCommands || []);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Token Guard Savings Report</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#050814;--panel:rgba(15,23,42,.74);--line:rgba(148,163,184,.22);--text:#f8fafc;--muted:#94a3b8;--green:#22c55e;--blue:#38bdf8;--violet:#a78bfa;--amber:#f59e0b}
*{box-sizing:border-box}
body{margin:0;padding:34px;background:radial-gradient(circle at 12% 0%,rgba(56,189,248,.22),transparent 28%),radial-gradient(circle at 85% 18%,rgba(167,139,250,.22),transparent 28%),radial-gradient(circle at 55% 95%,rgba(34,197,94,.14),transparent 34%),var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1120px;margin:0 auto}
.hero{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:34px;padding:46px;background:linear-gradient(135deg,rgba(15,23,42,.95),rgba(2,6,23,.74));box-shadow:0 30px 110px rgba(0,0,0,.45)}
.kicker{color:var(--blue);font-size:13px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}
.title{margin:14px 0 4px;font-size:clamp(52px,9vw,108px);line-height:.88;letter-spacing:-.075em;font-weight:950}
.subtitle{font-size:23px;color:#cbd5e1;margin:20px 0 0;max-width:780px}
.total{margin-top:28px;border:1px solid rgba(34,197,94,.28);border-radius:30px;padding:28px;background:linear-gradient(135deg,rgba(34,197,94,.18),rgba(56,189,248,.08));display:flex;align-items:end;justify-content:space-between;gap:24px}
.total-number{font-size:clamp(56px,9vw,116px);font-weight:950;letter-spacing:-.07em;color:var(--green);line-height:.9}
.total-label{color:#cbd5e1;font-size:18px;font-weight:700}
.pill{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:999px;padding:8px 12px;color:#cbd5e1;background:rgba(15,23,42,.55);font-size:13px;margin-top:24px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:22px}
.card{border:1px solid var(--line);border-radius:28px;background:var(--panel);padding:24px;backdrop-filter:blur(14px)}
h2{font-size:22px;letter-spacing:-.03em;margin:0 0 14px}
.footer{text-align:center;color:var(--muted);font-size:14px;margin-top:24px}
.insight{font-size:18px;line-height:1.55;color:#dbeafe}
.table{display:grid;gap:10px}
.row{display:grid;grid-template-columns:1fr auto;gap:16px;padding:12px 0;border-bottom:1px solid rgba(148,163,184,.14)}
.row:last-child{border-bottom:0}
.small{color:var(--muted);font-size:13px;margin-top:3px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace}
.proof{display:grid;gap:12px}
.proof-item{display:flex;justify-content:space-between;gap:18px;padding:14px;border:1px solid rgba(148,163,184,.16);border-radius:18px;background:rgba(15,23,42,.45)}
.proof-item b{color:var(--green)}
@media(max-width:850px){.grid{grid-template-columns:1fr}.title{font-size:54px}.total{display:block}.total-number{font-size:62px;margin-top:10px}}
</style>
</head>
<body>
<main>
<section class="hero">
  <div class="kicker">Token Guard · Weekly Savings</div>
  <div class="title">${escapeHtml(display.headline)}</div>
  <p class="subtitle">${escapeHtml(display.subtitle)}</p>
  <div class="pill">Local-first · no daemon · no code upload</div>
  <div class="total">
    <div>
      <div class="total-label">Total estimated savings</div>
      <div class="total-number">${saved > 0 ? format(saved) : '—'}</div>
    </div>
    <div class="total-label">${saved > 0 ? 'tokens saved this week' : 'waiting for first tracked savings event'}</div>
  </div>
</section>

<div class="grid">
  <section class="card"><h2>Savings trend</h2>${trend}</section>
  <section class="card"><h2>What happened</h2>${proofHtml}</section>
</div>

<div class="grid">
  <section class="card"><h2>Top context wins</h2>${topContext}</section>
  <section class="card"><h2>Top compressed commands</h2>${topCommands}</section>
</div>

<div class="card" style="margin-top:22px">
  <h2>Why this matters</h2>
  <p class="insight">${escapeHtml(bestInsight(model, display))}</p>
</div>

<div class="footer">Generated by Token Guard · Total savings after tool overhead · by Coding Daddy</div>
</main>
</body>
</html>`;
}

function buildProofPoints(model = {}) {
  const rows = [];

  const context = positive(model.contextReadSavedTokens);
  const bash = positive(model.bashOutputSavedTokens);
  const digest = positive(model.longInputDigestGrossSavedTokens || model.longInputDigestSavedTokens);
  const cache = positive(model.commandCacheSavedTokens);
  const diff = positive(model.diffReadSavedTokens);
  const handoff = positive(model.handoffCompressedSavedTokens);
  const readGuards = positive(model.savingsSources?.readGuards);
  const overhead = positive(model.tokenGuardOverheadTokens);

  if (context > 0) rows.push(['Targeted code reads avoided full-file dumps', context]);
  if (bash > 0) rows.push(['Noisy terminal output was compressed', bash]);
  if (digest > 0) rows.push(['Long user input was compressed for follow-up turns', digest]);
  if (cache > 0) rows.push(['Repeated command output was reused', cache]);
  if (diff > 0) rows.push(['Diff/context rereads were avoided', diff]);
  if (handoff > 0) rows.push(['Session handoff was compressed', handoff]);
  if (readGuards > 0) rows.push(['High-confidence full-context dumps were prevented', readGuards]);
  if (overhead > 0) rows.push(['Token Guard overhead already deducted', -overhead]);

  return rows;
}

function renderProofPoints(rows) {
  if (!rows.length) {
    return '<p class="small">No savings event has been recorded yet. Run a few coding sessions, use <span class="mono">tg ctx</span>, or run tests/builds with noisy output, then generate this report again.</p>';
  }

  return `<div class="proof">${rows.slice(0, 6).map(([label, value]) => `<div class="proof-item"><span>${escapeHtml(label)}</span><b>${value >= 0 ? '+' : '-'}${format(Math.abs(value))}</b></div>`).join('')}</div>`;
}

function bestInsight(model, display) {
  if (display.mode === 'empty') {
    return 'Token Guard is installed and ready. It will start showing savings after targeted context reads, compressed terminal output, long input digests, cache hits, or handoff compression events.';
  }

  const biggest = buildProofPoints(model)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])[0];

  if (biggest) {
    return `${biggest[0]}. Estimated contribution: ${format(biggest[1])} tokens.`;
  }

  return 'Token Guard is tracking savings across the AI coding loop while staying local-first and quiet by default.';
}

function renderTrendSvg(rows) {
  const data = rows.length ? rows : [{ day: '-', net: 0 }, { day: '-', net: 0 }, { day: '-', net: 0 }];
  const values = data.map(d => Math.max(0, d.gross || d.net || 0));
  const max = Math.max(1, ...values);
  const w = 620;
  const h = 240;
  const p = 32;

  const pts = data.map((d, i) => {
    const value = Math.max(0, d.gross || d.net || 0);
    const x = p + (i * (w - p * 2) / Math.max(1, data.length - 1));
    const y = h - p - (value * (h - p * 2) / max);

    return `${x},${y}`;
  }).join(' ');

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="240"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#22C55E" stop-opacity=".52"/><stop offset="100%" stop-color="#22C55E" stop-opacity="0"/></linearGradient></defs><polyline points="${pts}" fill="none" stroke="#22C55E" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><polygon points="${p},${h - p} ${pts} ${w - p},${h - p}" fill="url(#g)"/><line x1="${p}" y1="${h - p}" x2="${w - p}" y2="${h - p}" stroke="#334155"/><text x="${p}" y="26" fill="#94A3B8" font-size="13">Total savings trend</text></svg>`;
}

function renderTopContextSavings(rows = []) {
  if (!rows.length) {
    return '<p class="small">No targeted context savings recorded yet. Use <span class="mono">tg ctx</span> during coding sessions.</p>';
  }

  return `<div class="table">${rows.slice(0, 8).map(row => `<div class="row"><div><div class="mono">${escapeHtml(shorten(row.file, 56))}</div><div class="small">${escapeHtml(row.method || 'ctx')} · ${format(row.reads || 0)} read(s)</div></div><strong>${format(row.savedTokens)} saved</strong></div>`).join('')}</div>`;
}

function renderTopCompressedCommands(rows = []) {
  if (!rows.length) {
    return '<p class="small">No compressed command output recorded yet.</p>';
  }

  return `<div class="table">${rows.slice(0, 8).map(row => `<div class="row"><div><div class="mono">${escapeHtml(shorten(row.command, 56))}</div><div class="small">${escapeHtml(row.profile || 'tool')} · ${format(row.runs || 0)} run(s)</div></div><strong>${format(row.savedTokens)} saved</strong></div>`).join('')}</div>`;
}

function renderShareSvg(model, display) {
  const saved = positive(display.savedTokens);
  const title = saved > 0 ? `${formatCompact(saved)} tokens saved` : 'Tracking started';
  const subtitle = saved > 0
    ? 'with Token Guard this week'
    : 'Token Guard is ready to track savings';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><defs><radialGradient id="a" cx="20%" cy="0%" r="80%"><stop offset="0" stop-color="#38BDF8" stop-opacity=".45"/><stop offset="1" stop-color="#050814"/></radialGradient><radialGradient id="b" cx="90%" cy="20%" r="70%"><stop offset="0" stop-color="#A78BFA" stop-opacity=".35"/><stop offset="1" stop-color="#050814" stop-opacity="0"/></radialGradient></defs><rect width="1200" height="630" fill="#050814"/><rect width="1200" height="630" fill="url(#a)"/><rect width="1200" height="630" fill="url(#b)"/><text x="72" y="105" fill="#38BDF8" font-family="Inter,Arial" font-size="25" font-weight="800" letter-spacing="4">TOKEN GUARD · WEEKLY SAVINGS</text><text x="72" y="250" fill="#F8FAFC" font-family="Inter,Arial" font-size="88" font-weight="900">${escapeSvg(title)}</text><text x="72" y="335" fill="#CBD5E1" font-family="Inter,Arial" font-size="34">${escapeSvg(subtitle)}</text><rect x="72" y="430" width="1010" height="92" rx="26" fill="#0F172A" fill-opacity=".75" stroke="#334155"/><text x="104" y="486" fill="#22C55E" font-family="Inter,Arial" font-size="36" font-weight="900">${saved > 0 ? format(saved) : 'Ready'}</text><text x="104" y="520" fill="#94A3B8" font-family="Inter,Arial" font-size="20">${saved > 0 ? 'estimated total tokens saved after overhead' : 'run a coding session and generate this report again'}</text><text x="72" y="590" fill="#94A3B8" font-family="Inter,Arial" font-size="22">Local-first · no daemon · no code upload · Generated by Token Guard</text></svg>`;
}

function openPath(target) {
  try {
    if (os.platform() === 'darwin') {
      childProcess.execFileSync('open', [target]);
    } else if (os.platform() === 'win32') {
      childProcess.execFileSync('cmd', ['/c', 'start', '', target]);
    } else {
      childProcess.execFileSync('xdg-open', [target]);
    }
  } catch {
    // Best effort.
  }
}

function positive(value) {
  const n = Number(value || 0);

  if (!Number.isFinite(n)) return 0;

  return Math.max(0, n);
}

function format(value) {
  return Math.round(Number(value || 0)).toLocaleString('en-US');
}

function formatCompact(value) {
  const n = Number(value || 0);

  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;

  return format(n);
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeSvg(value) {
  return escapeHtml(value);
}

function shorten(value, max) {
  const s = String(value || '');

  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}
