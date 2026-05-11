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
  const saved = Math.max(0, Number(m.netSavingsTokens || 0));
  const potential = Math.max(0, Number(m.potentialWasteFlaggedTokens || 0));
  const overhead = Math.max(0, Number(m.tokenGuardOverheadTokens || 0));
  const gross = Math.max(0, Number(m.grossAvoidedTokens || 0));
  const headline = saved > 0 ? `${format(saved)} tokens saved` : potential > 0 ? `${format(potential)} tokens flagged` : 'Token Guard is ready';
  const subtitle = saved > 0 ? 'Net savings after Token Guard overhead.' : potential > 0 ? 'Potential avoidable context detected. Smart Savings only intervenes on high-confidence waste.' : 'Run a few coding sessions, then generate this report again.';
  const trend = renderTrendSvg(m.daily || []);
  const ring = renderRingSvg({ saved, gross, overhead });
  const sources = renderSourceBars(m);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Token Guard Savings Report</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--bg:#050814;--panel:rgba(15,23,42,.72);--line:rgba(148,163,184,.22);--text:#f8fafc;--muted:#94a3b8;--green:#22c55e;--blue:#38bdf8;--violet:#a78bfa;--amber:#f59e0b;--rose:#fb7185}*{box-sizing:border-box}body{margin:0;padding:34px;background:radial-gradient(circle at 12% 0%,rgba(56,189,248,.22),transparent 28%),radial-gradient(circle at 85% 18%,rgba(167,139,250,.18),transparent 26%),radial-gradient(circle at 55% 95%,rgba(34,197,94,.15),transparent 34%),var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1120px;margin:0 auto}.hero{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:34px;padding:42px;background:linear-gradient(135deg,rgba(15,23,42,.94),rgba(2,6,23,.72));box-shadow:0 30px 110px rgba(0,0,0,.45)}.kicker{color:var(--blue);font-size:13px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}.title{margin:12px 0 4px;font-size:clamp(46px,8vw,92px);line-height:.9;letter-spacing:-.07em;font-weight:950}.subtitle{font-size:22px;color:#cbd5e1;margin:18px 0 0}.grid{display:grid;grid-template-columns:1.05fr .95fr;gap:18px;margin-top:22px}.card{border:1px solid var(--line);border-radius:28px;background:var(--panel);padding:24px;backdrop-filter:blur(14px)}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:20px}.metric{border:1px solid var(--line);border-radius:22px;background:rgba(15,23,42,.6);padding:18px}.label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:800}.value{font-size:30px;font-weight:900;margin-top:7px;letter-spacing:-.04em}.green{color:var(--green)}.blue{color:var(--blue)}.violet{color:var(--violet)}.amber{color:var(--amber)}h2{font-size:22px;letter-spacing:-.03em;margin:0 0 14px}.footer{text-align:center;color:var(--muted);font-size:14px;margin-top:24px}.insight{font-size:18px;line-height:1.55;color:#dbeafe}.pill{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:999px;padding:8px 12px;color:#cbd5e1;background:rgba(15,23,42,.55);font-size:13px;margin-top:22px}@media(max-width:850px){.grid,.metrics{grid-template-columns:1fr}.title{font-size:54px}}
</style></head><body><main><section class="hero"><div class="kicker">Token Guard · Smart Savings</div><div class="title">${escapeHtml(headline)}</div><p class="subtitle">${escapeHtml(subtitle)}</p><div class="pill">Local-first · no daemon · no code upload</div><div class="metrics"><div class="metric"><div class="label">Net saved</div><div class="value green">${format(saved)}</div></div><div class="metric"><div class="label">Gross protected</div><div class="value blue">${format(gross)}</div></div><div class="metric"><div class="label">Potential waste</div><div class="value amber">${format(potential)}</div></div><div class="metric"><div class="label">TG overhead</div><div class="value violet">${format(overhead)}</div></div></div></section><div class="grid"><section class="card"><h2>7-day savings trend</h2>${trend}</section><section class="card"><h2>Net after overhead</h2>${ring}</section></div><div class="grid"><section class="card"><h2>Savings sources</h2>${sources}</section><section class="card"><h2>What helped most</h2><p class="insight">${escapeHtml(bestInsight(m))}</p></section></div><div class="footer">Generated by Token Guard · Smart token savings for AI coding agents</div></main></body></html>`;
}

function bestInsight(m) {
  const candidates = [
    ['Long input digests compressed repeated context.', m.longInputDigestSavedTokens || 0],
    ['Bash output trimming removed terminal noise.', m.bashOutputSavedTokens || 0],
    ['Command cache avoided repeated tool output.', m.commandCacheSavedTokens || 0],
    ['Read guards prevented high-confidence full-context dumps.', m.grossAvoidedTokens || 0]
  ].sort((a, b) => b[1] - a[1]);
  if ((candidates[0]?.[1] || 0) > 0) return `${candidates[0][0]} Estimated contribution: ${format(candidates[0][1])} tokens.`;
  if ((m.potentialWasteFlaggedTokens || 0) > 0) return `Token Guard found ${format(m.potentialWasteFlaggedTokens)} potential avoidable tokens. It intervenes only on high-confidence waste to protect coding quality.`;
  return 'No major token-saving event yet. Keep coding and regenerate the report after a longer session.';
}

function renderTrendSvg(rows) {
  const data = rows.length ? rows : [{day:'-',net:0},{day:'-',net:0},{day:'-',net:0}];
  const max = Math.max(1, ...data.map(d => Math.max(0, d.net || 0)));
  const w=620,h=240,p=32;
  const pts=data.map((d,i)=>{const x=p+(i*(w-p*2)/Math.max(1,data.length-1));const y=h-p-(Math.max(0,d.net||0)*(h-p*2)/max);return `${x},${y}`}).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="240"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#38BDF8" stop-opacity=".55"/><stop offset="100%" stop-color="#38BDF8" stop-opacity="0"/></linearGradient></defs><polyline points="${pts}" fill="none" stroke="#38BDF8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><polygon points="${p},${h-p} ${pts} ${w-p},${h-p}" fill="url(#g)"/><line x1="${p}" y1="${h-p}" x2="${w-p}" y2="${h-p}" stroke="#334155"/><text x="${p}" y="26" fill="#94A3B8" font-size="13">Net tokens saved after overhead</text></svg>`;
}

function renderRingSvg({saved,gross,overhead}) {
  const total = Math.max(1, saved + overhead);
  const pct = Math.max(0, Math.min(1, saved/total));
  const dash = Math.round(565*pct);
  return `<svg viewBox="0 0 260 260" width="100%" height="260"><circle cx="130" cy="130" r="90" fill="none" stroke="#1E293B" stroke-width="28"/><circle cx="130" cy="130" r="90" fill="none" stroke="#22C55E" stroke-width="28" stroke-linecap="round" stroke-dasharray="${dash} 565" transform="rotate(-90 130 130)"/><text x="130" y="122" text-anchor="middle" fill="#F8FAFC" font-size="40" font-weight="900">${format(saved)}</text><text x="130" y="154" text-anchor="middle" fill="#94A3B8" font-size="15">net saved</text><text x="130" y="188" text-anchor="middle" fill="#64748B" font-size="12">gross ${format(gross)} · overhead ${format(overhead)}</text></svg>`;
}

function renderSourceBars(m) {
  const rows = [
    ['Long input digest', m.longInputDigestSavedTokens || 0, '#A78BFA'],
    ['Bash trim', m.bashOutputSavedTokens || 0, '#22C55E'],
    ['Command cache', m.commandCacheSavedTokens || 0, '#38BDF8'],
    ['Diff/context savings', m.diffReadSavedTokens || 0, '#F59E0B']
  ];
  const max=Math.max(1,...rows.map(r=>r[1]));
  return `<div>${rows.map(([name,value,color])=>`<div style="margin:14px 0"><div style="display:flex;justify-content:space-between;color:#cbd5e1;font-size:14px"><span>${escapeHtml(name)}</span><b>${format(value)}</b></div><div style="height:12px;background:#1e293b;border-radius:999px;overflow:hidden;margin-top:7px"><div style="height:100%;width:${Math.max(3,value/max*100)}%;background:${color};border-radius:999px"></div></div></div>`).join('')}</div>`;
}

function renderShareSvg(m) {
  const saved = Math.max(0, Number(m.netSavingsTokens || 0));
  const potential = Math.max(0, Number(m.potentialWasteFlaggedTokens || 0));
  const title = saved > 0 ? `${format(saved)} tokens saved` : `${format(potential)} tokens flagged`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><defs><radialGradient id="a" cx="20%" cy="0%" r="80%"><stop offset="0" stop-color="#38BDF8" stop-opacity=".45"/><stop offset="1" stop-color="#050814"/></radialGradient><radialGradient id="b" cx="90%" cy="20%" r="70%"><stop offset="0" stop-color="#A78BFA" stop-opacity=".35"/><stop offset="1" stop-color="#050814" stop-opacity="0"/></radialGradient></defs><rect width="1200" height="630" fill="#050814"/><rect width="1200" height="630" fill="url(#a)"/><rect width="1200" height="630" fill="url(#b)"/><text x="72" y="105" fill="#38BDF8" font-family="Inter,Arial" font-size="25" font-weight="800" letter-spacing="4">TOKEN GUARD · SMART SAVINGS</text><text x="72" y="250" fill="#F8FAFC" font-family="Inter,Arial" font-size="88" font-weight="900">${escapeSvg(title)}</text><text x="72" y="335" fill="#CBD5E1" font-family="Inter,Arial" font-size="34">Stop wasting tokens across the AI coding loop.</text><rect x="72" y="430" width="318" height="92" rx="26" fill="#0F172A" fill-opacity=".75" stroke="#334155"/><text x="98" y="470" fill="#94A3B8" font-family="Inter,Arial" font-size="19" font-weight="700">Long inputs</text><text x="98" y="506" fill="#A78BFA" font-family="Inter,Arial" font-size="31" font-weight="900">${format(m.longInputDigests || 0)} digested</text><rect x="420" y="430" width="318" height="92" rx="26" fill="#0F172A" fill-opacity=".75" stroke="#334155"/><text x="446" y="470" fill="#94A3B8" font-family="Inter,Arial" font-size="19" font-weight="700">Bash noise</text><text x="446" y="506" fill="#22C55E" font-family="Inter,Arial" font-size="31" font-weight="900">${format(m.bashOutputSavedTokens || 0)}</text><rect x="768" y="430" width="318" height="92" rx="26" fill="#0F172A" fill-opacity=".75" stroke="#334155"/><text x="794" y="470" fill="#94A3B8" font-family="Inter,Arial" font-size="19" font-weight="700">Local-first</text><text x="794" y="506" fill="#38BDF8" font-family="Inter,Arial" font-size="31" font-weight="900">No upload</text><text x="72" y="590" fill="#94A3B8" font-family="Inter,Arial" font-size="22">Generated by Token Guard</text></svg>`;
}

function openPath(target) { try { if (os.platform()==='darwin') childProcess.execFileSync('open',[target]); else if (os.platform()==='win32') childProcess.execFileSync('cmd',['/c','start','',target]); else childProcess.execFileSync('xdg-open',[target]); } catch {} }
function format(n) { return Math.round(Number(n || 0)).toLocaleString('en-US'); }
function escapeHtml(value) { return String(value || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }
function escapeSvg(value) { return escapeHtml(value); }
