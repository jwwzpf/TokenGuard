import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { ensureProjectFiles, getPaths } from './project.js';
import { summarizeSavings } from './ledger.js';

export function generateReport(projectRoot = process.cwd()) {
  const paths = ensureProjectFiles(projectRoot);
  const model = summarizeSavings(projectRoot);
  const html = renderHtml(model);
  const svg = renderShareSvg(model);
  fs.writeFileSync(paths.reportHtml, html);
  fs.writeFileSync(paths.reportSvg, svg);
  return { html: paths.reportHtml, svg: paths.reportSvg, model };
}

export function openReport(projectRoot = process.cwd()) {
  const paths = getPaths(projectRoot);
  if (!fs.existsSync(paths.reportHtml)) generateReport(projectRoot);
  openPath(paths.reportHtml);
}
export function openFolder(projectRoot = process.cwd()) { const paths = ensureProjectFiles(projectRoot); openPath(paths.base); }

function renderHtml(m) {
  const saved = Math.max(m.netSavingsTokens, m.grossAvoidedTokens);
  const headline = saved > 0 ? `${format(saved)} tokens protected` : 'Token Guard is watching your AI context';
  const subtitle = saved > 0 ? 'Less wasted context. More real coding.' : 'Run a few coding sessions, then generate this report again.';
  const trend = renderTrendSvg(m.daily);
  const ring = renderRingSvg(m);
  const bars = renderBarsSvg(m);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Token Guard Savings Report</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#050814;--panel:rgba(15,23,42,.72);--line:rgba(148,163,184,.24);--text:#f8fafc;--muted:#94a3b8;--green:#22c55e;--blue:#38bdf8;--violet:#a78bfa;--amber:#f59e0b;--rose:#fb7185}*{box-sizing:border-box}body{margin:0;padding:34px;background:radial-gradient(circle at 12% 0%,rgba(56,189,248,.22),transparent 28%),radial-gradient(circle at 85% 18%,rgba(167,139,250,.18),transparent 26%),radial-gradient(circle at 55% 95%,rgba(34,197,94,.15),transparent 34%),var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1120px;margin:0 auto}.hero{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:34px;padding:42px;background:linear-gradient(135deg,rgba(15,23,42,.94),rgba(2,6,23,.72));box-shadow:0 30px 110px rgba(0,0,0,.45)}.kicker{color:var(--blue);font-size:13px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}.title{margin:12px 0 4px;font-size:clamp(46px,8vw,92px);line-height:.9;letter-spacing:-.07em;font-weight:950}.subtitle{font-size:22px;color:#cbd5e1;margin:18px 0 0}.grid{display:grid;grid-template-columns:1.05fr .95fr;gap:18px;margin-top:22px}.card{border:1px solid var(--line);border-radius:28px;background:var(--panel);padding:24px;backdrop-filter:blur(14px)}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:20px}.metric{border:1px solid var(--line);border-radius:22px;background:rgba(15,23,42,.6);padding:18px}.label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:800}.value{font-size:30px;font-weight:900;margin-top:7px;letter-spacing:-.04em}.green{color:var(--green)}.blue{color:var(--blue)}.violet{color:var(--violet)}h2{font-size:22px;letter-spacing:-.03em;margin:0 0 14px}.footer{text-align:center;color:var(--muted);font-size:14px;margin-top:24px}.insight{font-size:18px;line-height:1.55;color:#dbeafe}.pill{display:inline-flex;margin-top:16px;padding:10px 14px;border-radius:999px;background:rgba(56,189,248,.12);border:1px solid rgba(56,189,248,.3);color:#bae6fd;font-weight:700}@media(max-width:850px){body{padding:18px}.grid{grid-template-columns:1fr}.metrics{grid-template-columns:1fr}.hero{padding:26px}.title{font-size:54px}}
</style>
</head>
<body><main>
<section class="hero">
<div class="kicker">Token Guard Weekly Report</div>
<div class="title">${escapeHtml(headline)}</div>
<p class="subtitle">${escapeHtml(subtitle)}</p>
<div class="metrics">
<div class="metric"><div class="label">Net savings</div><div class="value green">${format(m.netSavingsTokens)}</div></div>
<div class="metric"><div class="label">Gross protected</div><div class="value blue">${format(m.grossAvoidedTokens)}</div></div>
<div class="metric"><div class="label">Sessions protected</div><div class="value violet">${format(m.sessionStarts)}</div></div>
</div>
</section>
<div class="grid">
<section class="card"><h2>7-day savings pulse</h2>${trend}</section>
<section class="card"><h2>Savings mix</h2>${ring}</section>
</div>
<div class="grid">
<section class="card"><h2>Top token traps</h2>${bars}</section>
<section class="card"><h2>What Token Guard did</h2><p class="insight">Trimmed noisy terminal output, compressed handoff state, digested long inputs, avoided repeated command output, and guided agents toward targeted context.</p><div class="pill">Local-first · no daemon · no code upload</div></section>
</div>
<div class="footer">Generated by Token Guard · by Coding Daddy</div>
</main></body></html>`;
}

function renderTrendSvg(daily = []) {
  const data = daily.length ? daily : Array.from({ length: 7 }, (_, i) => ({ day: `D${i+1}`, net: 0 }));
  const vals = data.map(d => Number(d.net || 0));
  const max = Math.max(1, ...vals);
  const points = vals.map((v, i) => `${40 + i * (520 / Math.max(1, vals.length - 1))},${210 - (v / max) * 150}`).join(' ');
  const area = `40,220 ${points} ${40 + (vals.length - 1) * (520 / Math.max(1, vals.length - 1))},220`;
  return `<svg viewBox="0 0 600 260" width="100%" height="260" role="img"><defs><linearGradient id="tgA" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#22c55e" stop-opacity=".45"/><stop offset="1" stop-color="#22c55e" stop-opacity="0"/></linearGradient></defs><path d="M40 220H560" stroke="#334155"/><polygon points="${area}" fill="url(#tgA)"/><polyline points="${points}" fill="none" stroke="#22c55e" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>${vals.map((v,i)=>`<circle cx="${40 + i * (520 / Math.max(1, vals.length - 1))}" cy="${210 - (v / max) * 150}" r="6" fill="#38bdf8"/>`).join('')}<text x="40" y="245" fill="#94a3b8" font-size="13">last 7 days</text><text x="455" y="245" fill="#94a3b8" font-size="13">tokens saved</text></svg>`;
}

function renderRingSvg(m) {
  const parts = [
    { label: 'Bash trim', value: m.bashOutputSavedTokens, color: '#22c55e' },
    { label: 'Input digest', value: m.longInputDigestSavedTokens, color: '#38bdf8' },
    { label: 'Cache', value: m.commandCacheSavedTokens, color: '#a78bfa' },
    { label: 'Context', value: Math.max(0, m.grossAvoidedTokens - m.bashOutputSavedTokens - m.longInputDigestSavedTokens - m.commandCacheSavedTokens), color: '#f59e0b' }
  ].filter(p => p.value > 0);
  const total = Math.max(1, parts.reduce((a,b)=>a+b.value,0));
  let offset = 0;
  const r = 72;
  const c = 2 * Math.PI * r;
  const circles = parts.map(p => { const dash = (p.value / total) * c; const el = `<circle cx="120" cy="120" r="${r}" stroke="${p.color}" stroke-width="24" fill="none" stroke-dasharray="${dash} ${c - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 120 120)"/>`; offset += dash; return el; }).join('');
  const legend = parts.map((p,i)=>`<g transform="translate(250 ${70+i*34})"><rect width="14" height="14" rx="4" fill="${p.color}"/><text x="24" y="12" fill="#cbd5e1" font-size="15">${p.label}: ${format(p.value)}</text></g>`).join('');
  return `<svg viewBox="0 0 520 260" width="100%" height="260"><circle cx="120" cy="120" r="72" stroke="#1e293b" stroke-width="24" fill="none"/>${circles}<text x="120" y="116" text-anchor="middle" fill="#f8fafc" font-size="28" font-weight="900">${format(total)}</text><text x="120" y="142" text-anchor="middle" fill="#94a3b8" font-size="12">protected</text>${legend || '<text x="250" y="120" fill="#94a3b8">No savings data yet</text>'}</svg>`;
}

function renderBarsSvg(m) {
  const rows = m.topWasters.length ? m.topWasters.slice(0,5) : [{file:'No token traps recorded yet', tokens: 0}];
  const max = Math.max(1, ...rows.map(r => r.tokens));
  return `<svg viewBox="0 0 620 260" width="100%" height="260">${rows.map((r,i)=>{ const w = 360*(r.tokens/max); return `<g transform="translate(20 ${34+i*42})"><text x="0" y="0" fill="#cbd5e1" font-size="13">${escapeSvg(shorten(r.file,52))}</text><rect x="0" y="10" width="${w}" height="16" rx="8" fill="url(#barGrad)"/><text x="${Math.max(8,w+10)}" y="23" fill="#94a3b8" font-size="13">${format(r.tokens)}</text></g>`;}).join('')}<defs><linearGradient id="barGrad" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#38bdf8"/><stop offset="1" stop-color="#22c55e"/></linearGradient></defs></svg>`;
}

function renderShareSvg(m) {
  const saved = Math.max(m.netSavingsTokens, m.grossAvoidedTokens);
  return `<svg width="1200" height="630" viewBox="0 0 1200 630" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="g1" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(180 40) rotate(40) scale(760 520)"><stop stop-color="#38BDF8" stop-opacity=".45"/><stop offset="1" stop-color="#020617" stop-opacity="0"/></radialGradient><radialGradient id="g2" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(950 160) rotate(120) scale(680 520)"><stop stop-color="#22C55E" stop-opacity=".38"/><stop offset="1" stop-color="#020617" stop-opacity="0"/></radialGradient></defs><rect width="1200" height="630" fill="#050814"/><rect width="1200" height="630" fill="url(#g1)"/><rect width="1200" height="630" fill="url(#g2)"/><text x="72" y="92" fill="#38BDF8" font-family="Inter,Arial" font-size="25" font-weight="800" letter-spacing="5">TOKEN GUARD</text><text x="72" y="205" fill="#F8FAFC" font-family="Inter,Arial" font-size="78" font-weight="900">${format(saved)}</text><text x="72" y="288" fill="#F8FAFC" font-family="Inter,Arial" font-size="72" font-weight="900">tokens protected</text><text x="72" y="365" fill="#CBD5E1" font-family="Inter,Arial" font-size="34">Stop feeding your whole repo to AI.</text><rect x="72" y="440" width="318" height="92" rx="26" fill="#0F172A" fill-opacity=".75" stroke="#334155"/><text x="98" y="480" fill="#94A3B8" font-family="Inter,Arial" font-size="19" font-weight="700">Bash noise trimmed</text><text x="98" y="516" fill="#22C55E" font-family="Inter,Arial" font-size="31" font-weight="900">${format(m.bashOutputSavedTokens)}</text><rect x="420" y="440" width="318" height="92" rx="26" fill="#0F172A" fill-opacity=".75" stroke="#334155"/><text x="446" y="480" fill="#94A3B8" font-family="Inter,Arial" font-size="19" font-weight="700">Handoffs</text><text x="446" y="516" fill="#38BDF8" font-family="Inter,Arial" font-size="31" font-weight="900">${format(m.handoffsGenerated)}</text><rect x="768" y="440" width="318" height="92" rx="26" fill="#0F172A" fill-opacity=".75" stroke="#334155"/><text x="794" y="480" fill="#94A3B8" font-family="Inter,Arial" font-size="19" font-weight="700">Local-first</text><text x="794" y="516" fill="#A78BFA" font-family="Inter,Arial" font-size="31" font-weight="900">No upload</text><text x="72" y="590" fill="#94A3B8" font-family="Inter,Arial" font-size="22">Generated by Token Guard · by Coding Daddy</text></svg>`;
}

function openPath(target) { try { if (os.platform()==='darwin') childProcess.execFileSync('open',[target]); else if (os.platform()==='win32') childProcess.execFileSync('cmd',['/c','start','',target]); else childProcess.execFileSync('xdg-open',[target]); } catch {} }
function format(n) { return Math.round(Number(n || 0)).toLocaleString('en-US'); }
function escapeHtml(value) { return String(value || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }
function escapeSvg(value) { return escapeHtml(value); }
function shorten(value, max) { const s = String(value || ''); return s.length <= max ? s : `${s.slice(0, max - 3)}...`; }
