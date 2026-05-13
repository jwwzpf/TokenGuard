import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { ensureProjectFiles, getPaths } from './project.js';
import { summarizeSavings, weeklyEvents, eventDay } from './ledger.js';

const SONNET_PRICE_PER_M = 3;
const OPUS_PRICE_PER_M = 15;
const COFFEE_PRICE = 5;
const NOVEL_TOKENS = 100_000;
const PIZZA_PRICE = 15;
const MOVIE_PRICE = 14;
const TOKEN_GUARD_OVERHEAD_BUDGET_TOKENS = 5_000;

export function generateReport(projectRoot = process.cwd()) {
  const paths = ensureProjectFiles(projectRoot);
  const weekEvts = weeklyEvents(projectRoot);
  const todayDate = new Date().toISOString().slice(0, 10);
  const todayEvts = weekEvts.filter(event => eventDay(event) === todayDate);

  const week = summarizeSavings(projectRoot, { events: weekEvts });
  const today = summarizeSavings(projectRoot, { events: todayEvts });

  const weekDisplay = computeDisplaySavings(week);
  const todayDisplayRaw = computeDisplaySavings(today);

  // Hard guarantee: today saved cannot exceed week saved (today is subset of week).
  const todayDisplay = {
    ...todayDisplayRaw,
    savedTokens: Math.min(positive(todayDisplayRaw.savedTokens), positive(weekDisplay.savedTokens))
  };

  week.displaySavedTokens = weekDisplay.savedTokens;
  week.displayMode = weekDisplay.mode;
  today.displaySavedTokens = todayDisplay.savedTokens;
  today.displayMode = todayDisplay.mode;

  const money = computeMoney(weekDisplay.savedTokens, week.grossAvoidedTokens);
  week.money = money;
  week.todayDisplay = todayDisplay;

  const html = renderHtml(week, weekDisplay, money, todayDisplay);
  const svg = renderShareSvg(week, weekDisplay, money, todayDisplay);

  fs.writeFileSync(paths.reportHtml, html);
  fs.writeFileSync(paths.reportSvg, svg);

  return {
    html: paths.reportHtml,
    svg: paths.reportSvg,
    model: week,
    today,
    todayDisplay,
    weekDisplay
  };
}

export function openReport(projectRoot = process.cwd()) {
  generateReport(projectRoot);
  const paths = getPaths(projectRoot);
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

function computeMoney(savedTokens, grossTokens) {
  const override = Number(process.env.TG_PRICE_PER_M || 0);
  const sonnetRate = override > 0 ? override : SONNET_PRICE_PER_M;
  const opusRate = OPUS_PRICE_PER_M;
  const saved = positive(savedTokens);
  const gross = positive(grossTokens);
  const usdSonnet = (saved / 1_000_000) * sonnetRate;
  const usdOpus = (saved / 1_000_000) * opusRate;
  const usdGrossOpus = (gross / 1_000_000) * opusRate;
  const coffees = usdOpus / COFFEE_PRICE;
  const novels = saved / NOVEL_TOKENS;
  const pizzas = usdOpus / PIZZA_PRICE;
  const movies = usdOpus / MOVIE_PRICE;
  return { sonnetRate, opusRate, usdSonnet, usdOpus, usdGrossOpus, coffees, novels, pizzas, movies };
}

function computeVelocity(daily = []) {
  const last7 = (daily || []).slice(-7);
  const prev7 = (daily || []).slice(-14, -7);
  const sum = rows => rows.reduce((acc, row) => acc + Math.max(0, Number(row.gross || row.net || 0)), 0);
  const cur = sum(last7);
  const prev = sum(prev7);

  if (cur <= 0 && prev <= 0) return { hasData: false, deltaPct: 0, direction: 'flat', current: 0, previous: 0 };
  if (prev <= 0) return { hasData: true, deltaPct: 100, direction: 'up', current: cur, previous: prev };

  const deltaPct = ((cur - prev) / prev) * 100;
  const direction = deltaPct > 5 ? 'up' : deltaPct < -5 ? 'down' : 'flat';

  return { hasData: true, deltaPct, direction, current: cur, previous: prev };
}

function computeEfficiency(model = {}) {
  const gross = positive(model.grossAvoidedTokens);
  const overhead = positive(model.tokenGuardOverheadTokens);
  const denominator = gross + overhead || TOKEN_GUARD_OVERHEAD_BUDGET_TOKENS;
  const efficiency = Math.max(0, Math.min(100, ((gross - overhead) / denominator) * 100));
  return { efficiency, gross, overhead };
}

function renderHtml(model, display, money, todayDisplay = { savedTokens: 0, mode: 'empty' }) {
  const saved = positive(display.savedTokens);
  const savedToday = positive(todayDisplay.savedTokens);
  const gross = positive(model.grossAvoidedTokens);
  const overhead = positive(model.tokenGuardOverheadTokens);
  const isSaved = display.mode === 'saved';
  const isFlagged = display.mode === 'potential';
  const trend = renderTrendSvg(model.daily || []);
  const ring = renderRingSvg({ saved, gross, overhead, usdOpus: money.usdOpus, mode: display.mode });
  const badges = renderBadges(model, display, money);
  const velocity = computeVelocity(model.daily || []);
  const efficiency = computeEfficiency(model);
  const sparkWeek = renderSparkSvg(model.daily || [], '#4ade80');
  const sparkToday = renderSparkSvg((model.daily || []).slice(-1), '#22c55e');
  const sparkUsd = renderSparkSvg((model.daily || []).map(d => ({ ...d, gross: (Math.max(0, Number(d.gross || d.net || 0)) / 1_000_000) * money.opusRate })), '#fbbf24');
  const equivalentsHtml = isSaved ? renderEquivalents(money) : '';
  const velocityChip = velocity.hasData ? renderVelocityChip(velocity) : '';

  const headlineMain = isSaved
    ? `$${formatMoney(money.usdOpus)}`
    : isFlagged
      ? `${formatCompact(positive(model.potentialWasteFlaggedTokens))}`
      : 'Tracking started';

  const headlineSub = isSaved
    ? `≈ $${formatMoney(money.usdSonnet)} – $${formatMoney(money.usdOpus)} reclaimed this week · while you slept, refactored, shipped`
    : isFlagged
      ? 'tokens protected · awaiting more sessions'
      : 'Run a few coding sessions, then regenerate.';

  const tokenLine = isSaved
    ? `${format(saved)} tokens saved this week · ${format(savedToday)} today · ${Math.round(efficiency.efficiency)}% net efficiency`
    : isFlagged
      ? `${format(positive(model.potentialWasteFlaggedTokens))} tokens flagged`
      : 'Local-first · no daemon · no code upload';

  const now = new Date();
  const dateStamp = now.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const genStamp = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const titleClass = isSaved ? '' : isFlagged ? ' flagged' : ' idle';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Token Guard · Savings Report</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<style>
:root{
  --bg:#04060f;
  --panel:rgba(15,23,42,.62);
  --line:rgba(148,163,184,.18);
  --line-strong:rgba(148,163,184,.32);
  --text:#f8fafc;
  --muted:#94a3b8;
  --dim:#64748b;
  --green:#22c55e;
  --green-hi:#4ade80;
  --blue:#38bdf8;
  --violet:#a78bfa;
  --amber:#f59e0b;
  --rose:#fb7185;
  --gold:#fbbf24;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  padding:44px 22px 60px;
  background:
    radial-gradient(circle at 8% -5%,rgba(56,189,248,.28),transparent 32%),
    radial-gradient(circle at 92% 12%,rgba(167,139,250,.24),transparent 30%),
    radial-gradient(circle at 50% 110%,rgba(34,197,94,.22),transparent 38%),
    radial-gradient(circle at 30% 60%,rgba(251,191,36,.10),transparent 40%),
    var(--bg);
  color:var(--text);
  font-family:'Inter','SF Pro Display',ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  font-feature-settings:"ss01","cv11","tnum";
  min-height:100vh;
  overflow-x:hidden;
}
body::before{
  content:"";
  position:fixed;inset:-40%;
  background:
    radial-gradient(circle at 20% 30%,rgba(56,189,248,.10),transparent 25%),
    radial-gradient(circle at 70% 70%,rgba(167,139,250,.10),transparent 25%);
  filter:blur(60px);
  animation:drift 18s ease-in-out infinite alternate;
  pointer-events:none;
  z-index:0;
}
@keyframes drift{0%{transform:translate3d(-2%,-1%,0) rotate(0deg)}100%{transform:translate3d(2%,1%,0) rotate(4deg)}}
main{max-width:1180px;margin:0 auto;position:relative;z-index:1}
.brandbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;color:var(--muted);font-size:13px;letter-spacing:.06em}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;color:#cbd5e1}
.brand .dot{width:10px;height:10px;border-radius:50%;background:linear-gradient(135deg,#38bdf8,#a78bfa);box-shadow:0 0 18px rgba(167,139,250,.6)}
.hero{
  position:relative;overflow:hidden;
  border:1px solid var(--line-strong);
  border-radius:36px;
  padding:56px 56px 48px;
  background:linear-gradient(140deg,rgba(15,23,42,.94),rgba(2,6,23,.72));
  box-shadow:0 40px 140px rgba(2,6,23,.65),inset 0 1px 0 rgba(255,255,255,.06);
}
.hero::before{
  content:"";position:absolute;inset:0;
  background:
    radial-gradient(circle at 12% 18%,rgba(56,189,248,.32),transparent 32%),
    radial-gradient(circle at 88% 8%,rgba(167,139,250,.30),transparent 30%),
    radial-gradient(circle at 60% 110%,rgba(34,197,94,.26),transparent 36%);
  pointer-events:none;
  animation:sheen 12s ease-in-out infinite alternate;
}
@keyframes sheen{0%{opacity:.85;transform:scale(1)}100%{opacity:1;transform:scale(1.04)}}
.hero::after{
  content:"";position:absolute;inset:0;
  background:
    radial-gradient(2px 2px at 20% 30%,rgba(255,255,255,.35),transparent 60%),
    radial-gradient(2px 2px at 70% 22%,rgba(255,255,255,.25),transparent 60%),
    radial-gradient(1.5px 1.5px at 40% 80%,rgba(255,255,255,.30),transparent 60%),
    radial-gradient(1.5px 1.5px at 85% 65%,rgba(255,255,255,.25),transparent 60%),
    radial-gradient(2px 2px at 10% 70%,rgba(255,255,255,.20),transparent 60%);
  mix-blend-mode:screen;
  pointer-events:none;
}
.hero-inner{position:relative;z-index:2}
.kicker{
  display:inline-flex;align-items:center;gap:10px;
  color:var(--blue);font-size:12px;font-weight:900;letter-spacing:.22em;text-transform:uppercase;
  padding:8px 14px;border-radius:999px;background:rgba(56,189,248,.10);border:1px solid rgba(56,189,248,.30);
}
.kicker .live{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 12px #22c55e;animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.85)}}
.title{
  margin:22px 0 6px;
  font-size:clamp(72px,12vw,148px);
  line-height:.88;letter-spacing:-.08em;font-weight:950;
  background:linear-gradient(120deg,#a7f3d0 0%,#86efac 18%,#4ade80 38%,#22c55e 60%,#34d399 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  text-shadow:0 0 80px rgba(34,197,94,.25);
  animation:rise .9s cubic-bezier(.2,.7,.2,1) both;
}
.title.flagged{
  background:linear-gradient(120deg,#fcd34d,#f59e0b 50%,#fb7185 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  text-shadow:0 0 60px rgba(251,191,36,.25);
}
.title.idle{
  background:linear-gradient(120deg,#cbd5e1,#94a3b8);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  text-shadow:none;
}
@keyframes rise{0%{opacity:0;transform:translateY(20px)}100%{opacity:1;transform:translateY(0)}}
.head-sub{font-size:24px;color:#e2e8f0;margin:14px 0 0;letter-spacing:-.01em;font-weight:600}
.tokenline{font-size:16px;color:var(--muted);margin:10px 0 0;letter-spacing:.01em}
.coffee{font-size:17px;color:#dbeafe;margin:22px 0 0;max-width:780px;line-height:1.55}
.pills{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}
.pill{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line-strong);border-radius:999px;padding:9px 14px;color:#e2e8f0;background:rgba(15,23,42,.55);font-size:13px;backdrop-filter:blur(8px)}
.pill .ic{width:14px;height:14px;border-radius:50%;background:linear-gradient(135deg,#38bdf8,#a78bfa)}

.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:34px;position:relative;z-index:2}
.metric{
  position:relative;overflow:hidden;
  border:1px solid var(--line-strong);border-radius:24px;
  background:linear-gradient(160deg,rgba(15,23,42,.92),rgba(2,6,23,.6));
  padding:22px;
  transition:transform .25s ease,border-color .25s ease;
}
.metric::after{content:"";position:absolute;top:-30%;right:-30%;width:120px;height:120px;border-radius:50%;background:radial-gradient(circle,rgba(56,189,248,.25),transparent 70%);pointer-events:none}
.metric:hover{transform:translateY(-3px);border-color:rgba(167,139,250,.45)}
.metric .label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.14em;font-weight:800}
.metric .value{font-size:38px;font-weight:900;margin-top:8px;letter-spacing:-.04em;line-height:1;font-variant-numeric:tabular-nums}
.metric .sub{font-size:12px;color:var(--dim);margin-top:6px}
.metric .spark{margin-top:10px;height:32px;opacity:.85}

.equiv{display:flex;flex-wrap:wrap;gap:10px;margin-top:26px;position:relative;z-index:2}
.equiv-chip{
  display:inline-flex;align-items:center;gap:10px;
  border:1px solid rgba(251,191,36,.35);
  background:linear-gradient(135deg,rgba(251,191,36,.14),rgba(167,139,250,.10));
  padding:10px 16px;border-radius:16px;
  font-size:14px;color:#fef3c7;font-weight:700;
  backdrop-filter:blur(10px);
  box-shadow:0 8px 24px rgba(251,191,36,.08);
  transition:transform .25s ease,border-color .25s ease;
}
.equiv-chip:hover{transform:translateY(-2px);border-color:rgba(251,191,36,.6)}
.equiv-emoji{font-size:18px}
.equiv-val{font-size:18px;font-weight:900;color:#fde68a;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.equiv-label{color:#cbd5e1;font-weight:600;font-size:13px}

.velocity{
  display:inline-flex;align-items:center;gap:8px;
  padding:7px 13px;border-radius:999px;
  font-size:12px;font-weight:900;letter-spacing:.06em;text-transform:uppercase;
  border:1px solid var(--line-strong);
  background:rgba(15,23,42,.6);
  backdrop-filter:blur(8px);
  margin-top:18px;
}
.velocity.up{color:#86efac;border-color:rgba(34,197,94,.4);background:rgba(34,197,94,.10);box-shadow:0 0 18px rgba(34,197,94,.18)}
.velocity.down{color:#fca5a5;border-color:rgba(251,113,133,.4);background:rgba(251,113,133,.08)}
.velocity.flat{color:#cbd5e1;border-color:var(--line-strong)}
.green{color:var(--green-hi)}
.blue{color:var(--blue)}
.violet{color:var(--violet)}
.amber{color:var(--amber)}
.gold{color:var(--gold)}

.badges{display:flex;flex-wrap:wrap;gap:10px;margin-top:30px;position:relative;z-index:2}
.badge{
  display:inline-flex;align-items:center;gap:10px;
  padding:10px 14px;border-radius:14px;
  background:linear-gradient(135deg,rgba(34,197,94,.16),rgba(56,189,248,.10));
  border:1px solid rgba(34,197,94,.32);
  color:#ecfccb;font-size:13px;font-weight:700;
  backdrop-filter:blur(8px);
}
.badge .emoji{font-size:16px}
.badge.gold{background:linear-gradient(135deg,rgba(251,191,36,.18),rgba(251,113,133,.10));border-color:rgba(251,191,36,.40);color:#fef3c7}
.badge.violet{background:linear-gradient(135deg,rgba(167,139,250,.18),rgba(56,189,248,.10));border-color:rgba(167,139,250,.40);color:#ede9fe}

.grid{display:grid;grid-template-columns:1.1fr .9fr;gap:18px;margin-top:22px}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:22px}
.card{
  position:relative;overflow:hidden;
  border:1px solid var(--line-strong);border-radius:26px;
  background:linear-gradient(180deg,rgba(15,23,42,.78),rgba(2,6,23,.55));
  padding:26px;backdrop-filter:blur(14px);
  box-shadow:0 20px 60px rgba(2,6,23,.35);
}
.card h2{font-size:18px;letter-spacing:-.01em;margin:0 0 18px;display:flex;align-items:center;gap:10px;color:#e2e8f0;font-weight:800}
.card h2 .dot{width:8px;height:8px;border-radius:50%;background:linear-gradient(135deg,#38bdf8,#a78bfa)}
.insight{font-size:17px;line-height:1.6;color:#e2e8f0}

.proof{display:flex;flex-direction:column;gap:10px}
.proof-item{display:flex;justify-content:space-between;align-items:center;gap:18px;padding:14px 16px;border:1px solid rgba(148,163,184,.16);border-radius:16px;background:rgba(15,23,42,.55)}
.proof-item span{color:#cbd5e1;font-size:14px}
.proof-item b{color:var(--green-hi);font-variant-numeric:tabular-nums;font-size:16px}
.proof-item b.minus{color:var(--rose)}

.table{display:flex;flex-direction:column;gap:8px}
.row{display:grid;grid-template-columns:1fr auto;gap:14px;padding:11px 14px;border-radius:14px;background:rgba(15,23,42,.55);border:1px solid var(--line);align-items:center}
.row strong{color:#fde68a;font-variant-numeric:tabular-nums;white-space:nowrap}
.mono{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.small{color:var(--muted);font-size:12px;margin-top:4px}

.footer{margin-top:32px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;color:var(--muted);font-size:13px}
.footer .legal{max-width:760px;line-height:1.55}
.cta{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:10px 16px;border:1px solid var(--line-strong);background:linear-gradient(135deg,#22c55e,#38bdf8);color:#04060f;font-weight:800;font-size:13px;text-decoration:none}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(148,163,184,.12);padding:1px 6px;border-radius:6px;color:#e2e8f0}

@media(max-width:920px){
  .hero{padding:36px 28px}
  .metrics{grid-template-columns:repeat(2,1fr)}
  .grid,.grid-2{grid-template-columns:1fr}
  .title{font-size:64px}
}
</style>
</head>
<body>
<main>
  <div class="brandbar">
    <div class="brand"><span class="dot"></span>TOKEN GUARD</div>
    <div>${escapeHtml(dateStamp)} · last 7 days · generated ${escapeHtml(genStamp)}</div>
  </div>

  <section class="hero">
    <div class="hero-inner">
      <div class="kicker"><span class="live"></span>Smart Savings · Weekly Report</div>
      <div class="title${titleClass}">${escapeHtml(headlineMain)}</div>
      <p class="head-sub">${escapeHtml(headlineSub)}</p>
      <p class="tokenline">${escapeHtml(tokenLine)}</p>
      ${velocityChip}
      ${equivalentsHtml}
      <div class="pills">
        <div class="pill"><span class="ic"></span>Local-first · zero upload</div>
        <div class="pill"><span class="ic"></span>${format(model.eventCount || 0)} events</div>
        <div class="pill"><span class="ic"></span>${format(model.sessionStarts || 0)} sessions</div>
        <div class="pill"><span class="ic"></span>@ $${money.sonnetRate}/M Sonnet · $${money.opusRate}/M Opus</div>
      </div>
      <div class="metrics">
        <div class="metric"><div class="label">Today saved</div><div class="value green">${formatCompact(savedToday)}</div><div class="sub">tokens · ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div><div class="spark">${sparkToday}</div></div>
        <div class="metric"><div class="label">This week saved</div><div class="value blue">${formatCompact(saved)}</div><div class="sub">tokens · last 7 days</div><div class="spark">${sparkWeek}</div></div>
        <div class="metric"><div class="label">USD saved · Opus</div><div class="value gold">$${formatMoney(money.usdOpus)}</div><div class="sub">@ $${money.opusRate}/M input</div><div class="spark">${sparkUsd}</div></div>
        <div class="metric"><div class="label">USD saved · Sonnet</div><div class="value violet">$${formatMoney(money.usdSonnet)}</div><div class="sub">@ $${money.sonnetRate}/M input</div><div class="spark">${sparkUsd}</div></div>
      </div>
      ${badges}
    </div>
  </section>

  <div class="grid">
    <section class="card">
      <h2><span class="dot"></span>7-day savings trend</h2>
      ${trend}
    </section>
    <section class="card">
      <h2><span class="dot"></span>Net efficiency</h2>
      ${ring}
    </section>
  </div>

  <section class="card">
    <h2><span class="dot"></span>Why this matters</h2>
    <p class="insight">${escapeHtml(bestInsight(model, display, savedToday))}</p>
  </section>

  <div class="footer">
    <div class="legal">Pricing assumption: Anthropic input rate $${money.sonnetRate}/M (Sonnet) and $${money.opusRate}/M (Opus). Override with <code>TG_PRICE_PER_M</code>. Estimates only — actual savings vary by model mix &amp; prompt caching. Hooks target Claude Code; Codex coverage limited.</div>
    <div><span class="cta">Generated by Token Guard</span></div>
  </div>
</main>
</body>
</html>`;
}

function renderSparkSvg(rows = [], color = '#4ade80') {
  const data = (rows.length ? rows : [{ gross: 0 }, { gross: 0 }]).map(r => Math.max(0, Number(r.gross || r.net || 0)));
  if (data.length < 2) data.push(data[0] || 0);
  const max = Math.max(1, ...data);
  const w = 120, h = 32;
  const xs = data.map((_, i) => (i * w) / (data.length - 1));
  const ys = data.map(v => h - 4 - (v * (h - 8)) / max);
  const pts = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const fillPts = `${xs[0].toFixed(1)},${h} ${pts} ${xs[xs.length - 1].toFixed(1)},${h}`;
  const gid = `sg${Math.floor(Math.random() * 1e9)}`;

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="32" preserveAspectRatio="none"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".55"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><polygon points="${fillPts}" fill="url(#${gid})"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function renderEquivalents(money = {}) {
  const items = [
    ['☕', formatEquivalent(money.coffees), 'coffees'],
    ['📖', formatEquivalent(money.novels), 'novels'],
    ['🍕', formatEquivalent(money.pizzas), 'pizzas'],
    ['🎬', formatEquivalent(money.movies), 'movie tickets']
  ].filter(([, value]) => value !== '0');

  if (!items.length) return '';

  return `<div class="equiv">${items.map(([emoji, value, label]) => `<div class="equiv-chip"><span class="equiv-emoji">${emoji}</span><span class="equiv-val">${escapeHtml(value)}</span><span class="equiv-label">${escapeHtml(label)}</span></div>`).join('')}</div>`;
}

function renderVelocityChip(velocity) {
  const arrow = velocity.direction === 'up' ? '▲' : velocity.direction === 'down' ? '▼' : '◆';
  const cls = velocity.direction === 'up' ? 'up' : velocity.direction === 'down' ? 'down' : 'flat';
  const pct = velocity.deltaPct;
  const txt = velocity.previous <= 0
    ? 'new wave · first 7 days tracked'
    : `${arrow} ${Math.abs(pct).toFixed(0)}% vs prior week`;

  return `<div class="velocity ${cls}">${escapeHtml(txt)}</div>`;
}

function formatEquivalent(value) {
  const n = positive(value);
  if (n <= 0) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return Math.round(n).toString();
  if (n >= 10) return n.toFixed(0);
  if (n >= 1) return n.toFixed(1);
  return n.toFixed(2);
}

function renderBadges(model, display, money) {
  const saved = positive(display.savedTokens);
  const usdHi = money.usdOpus;
  const list = [];
  if (saved >= 1_000_000) list.push(['gold', '🏆', 'Million-token club']);
  else if (saved >= 250_000) list.push(['gold', '🔥', 'Quarter-million reclaimed']);
  else if (saved >= 50_000) list.push(['', '✨', '50k tokens reclaimed']);
  if (usdHi >= 20) list.push(['gold', '💰', `>$${formatMoney(usdHi)} saved`]);
  else if (usdHi >= 5) list.push(['', '💵', `$${formatMoney(usdHi)} saved`]);
  if (positive(model.sessionStarts) >= 5) list.push(['', '🛡️', `${format(model.sessionStarts)} guarded sessions`]);
  if (!list.length) list.push(['', '🌱', 'First steps — keep coding']);
  return `<div class="badges">${list.map(([cls, emoji, text]) => `<div class="badge ${cls}"><span class="emoji">${emoji}</span>${escapeHtml(text)}</div>`).join('')}</div>`;
}

function bestInsight(model, display, savedToday = 0) {
  if (display.mode === 'empty') {
    return 'Token Guard is installed and ready. Once you run a few coding sessions, total daily and weekly savings will appear here.';
  }

  const saved = positive(display.savedTokens);

  if (saved <= 0 && savedToday <= 0) {
    return 'Token Guard is tracking. It stays quiet by default and only intervenes on high-confidence waste.';
  }

  return `Token Guard saved ~${format(savedToday)} tokens today and ~${format(saved)} tokens this week across context reads, command outputs, long-input digests, session handoffs and subagent delegations. Local-first, quiet by default.`;
}

function renderTrendSvg(rows) {
  const data = rows.length ? rows : [{ day: '-', net: 0 }, { day: '-', net: 0 }, { day: '-', net: 0 }];
  const values = data.map(d => Math.max(0, d.gross || d.net || 0));
  const max = Math.max(1, ...values);
  const w = 640, h = 260, p = 36;
  const xs = data.map((_, i) => p + (i * (w - p * 2) / Math.max(1, data.length - 1)));
  const ys = values.map(v => h - p - (v * (h - p * 2) / max));
  const pts = xs.map((x, i) => `${x},${ys[i]}`).join(' ');
  const grid = [0.25, 0.5, 0.75].map(t => {
    const y = h - p - (h - p * 2) * t;
    return `<line x1="${p}" y1="${y}" x2="${w - p}" y2="${y}" stroke="rgba(148,163,184,.12)" stroke-dasharray="3 6"/>`;
  }).join('');
  const dots = xs.map((x, i) => `<circle cx="${x}" cy="${ys[i]}" r="5" fill="#04060f" stroke="#22c55e" stroke-width="3"/>`).join('');
  const labels = data.map((d, i) => {
    const lab = String(d.day || '').slice(5);
    return `<text x="${xs[i]}" y="${h - 10}" text-anchor="middle" fill="#64748b" font-size="11" font-family="Inter,sans-serif">${escapeSvg(lab)}</text>`;
  }).join('');
  const peakIdx = values.reduce((best, v, i) => v > values[best] ? i : best, 0);
  const peakBadge = values[peakIdx] > 0
    ? `<g transform="translate(${xs[peakIdx]},${ys[peakIdx] - 18})"><rect x="-42" y="-22" width="84" height="22" rx="11" fill="rgba(34,197,94,.18)" stroke="rgba(34,197,94,.5)"/><text x="0" y="-7" text-anchor="middle" fill="#4ade80" font-size="11" font-weight="800" font-family="Inter,sans-serif">peak ${formatCompact(values[peakIdx])}</text></g>`
    : '';
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="260" preserveAspectRatio="xMidYMid meet">
    <defs>
      <linearGradient id="trendArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#22c55e" stop-opacity=".55"/>
        <stop offset="100%" stop-color="#22c55e" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="trendLine" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#38bdf8"/>
        <stop offset="60%" stop-color="#22c55e"/>
        <stop offset="100%" stop-color="#a7f3d0"/>
      </linearGradient>
    </defs>
    ${grid}
    <polygon points="${p},${h - p} ${pts} ${w - p},${h - p}" fill="url(#trendArea)"/>
    <polyline points="${pts}" fill="none" stroke="url(#trendLine)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
    ${peakBadge}
    ${labels}
    <text x="${p}" y="26" fill="#94a3b8" font-size="12" font-family="Inter,sans-serif">Total savings per day</text>
  </svg>`;
}

function renderRingSvg({ saved, gross, overhead, usdOpus, mode }) {
  const total = Math.max(1, saved + overhead);
  const pct = Math.max(0, Math.min(1, saved / total));
  const r = 92;
  const circ = 2 * Math.PI * r;
  const dash = Math.round(circ * pct);
  const centerVal = mode === 'saved' ? `$${formatMoney(usdOpus)}` : '—';
  const centerSub = mode === 'saved' ? 'saved @ Opus rate' : 'awaiting data';
  return `<svg viewBox="0 0 280 280" width="100%" height="260" preserveAspectRatio="xMidYMid meet">
    <defs>
      <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#22c55e"/>
        <stop offset="100%" stop-color="#38bdf8"/>
      </linearGradient>
      <filter id="glow"><feGaussianBlur stdDeviation="4"/></filter>
    </defs>
    <circle cx="140" cy="140" r="${r}" fill="none" stroke="rgba(30,41,59,.85)" stroke-width="22"/>
    <circle cx="140" cy="140" r="${r}" fill="none" stroke="url(#ring)" stroke-width="22" stroke-linecap="round" stroke-dasharray="${dash} ${circ}" transform="rotate(-90 140 140)" filter="url(#glow)" opacity=".55"/>
    <circle cx="140" cy="140" r="${r}" fill="none" stroke="url(#ring)" stroke-width="18" stroke-linecap="round" stroke-dasharray="${dash} ${circ}" transform="rotate(-90 140 140)"/>
    <text x="140" y="128" text-anchor="middle" fill="#f8fafc" font-size="40" font-weight="900" font-family="Inter,sans-serif" letter-spacing="-2">${escapeSvg(centerVal)}</text>
    <text x="140" y="154" text-anchor="middle" fill="#94a3b8" font-size="13" font-family="Inter,sans-serif">${escapeSvg(centerSub)}</text>
    <text x="140" y="190" text-anchor="middle" fill="#64748b" font-size="11.5" font-family="Inter,sans-serif">${formatCompact(saved)} net · ${formatCompact(gross)} gross</text>
  </svg>`;
}

function renderShareSvg(model, display, money, todayDisplay = { savedTokens: 0 }) {
  const saved = positive(display.savedTokens);
  const savedToday = positive(todayDisplay.savedTokens);
  const isSaved = display.mode === 'saved';
  const isFlagged = display.mode === 'potential';
  const titleUsd = isSaved
    ? `$${formatMoney(money.usdOpus)}`
    : isFlagged
      ? formatCompact(positive(model.potentialWasteFlaggedTokens))
      : 'Ready';
  const subtitle = isSaved
    ? `reclaimed this week with Token Guard`
    : isFlagged
      ? 'tokens flagged · awaiting more sessions'
      : 'Token Guard is watching';
  const titleGrad = isSaved ? 'url(#hl)' : 'url(#hlAmber)';

  const equivItems = isSaved
    ? [
        ['☕', formatEquivalent(money.coffees), 'COFFEES'],
        ['📖', formatEquivalent(money.novels), 'NOVELS'],
        ['🍕', formatEquivalent(money.pizzas), 'PIZZAS'],
        ['🎬', formatEquivalent(money.movies), 'MOVIE TIX']
      ].filter(([, v]) => v !== '0')
    : [];

  const chipsSvg = equivItems.length
    ? renderShareChips(equivItems)
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <defs>
      <radialGradient id="bg1" cx="15%" cy="0%" r="80%"><stop offset="0" stop-color="#38BDF8" stop-opacity=".55"/><stop offset="1" stop-color="#04060F" stop-opacity="0"/></radialGradient>
      <radialGradient id="bg2" cx="92%" cy="20%" r="70%"><stop offset="0" stop-color="#A78BFA" stop-opacity=".45"/><stop offset="1" stop-color="#04060F" stop-opacity="0"/></radialGradient>
      <radialGradient id="bg3" cx="50%" cy="110%" r="80%"><stop offset="0" stop-color="#22C55E" stop-opacity=".42"/><stop offset="1" stop-color="#04060F" stop-opacity="0"/></radialGradient>
      <radialGradient id="bg4" cx="80%" cy="80%" r="60%"><stop offset="0" stop-color="#FBBF24" stop-opacity=".18"/><stop offset="1" stop-color="#04060F" stop-opacity="0"/></radialGradient>
      <linearGradient id="hl" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#A7F3D0"/>
        <stop offset="35%" stop-color="#4ADE80"/>
        <stop offset="70%" stop-color="#22C55E"/>
        <stop offset="100%" stop-color="#34D399"/>
      </linearGradient>
      <linearGradient id="hlAmber" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#FCD34D"/>
        <stop offset="100%" stop-color="#FB7185"/>
      </linearGradient>
      <linearGradient id="chipGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#FBBF24" stop-opacity=".22"/>
        <stop offset="100%" stop-color="#A78BFA" stop-opacity=".18"/>
      </linearGradient>
      <filter id="softGlow"><feGaussianBlur stdDeviation="18"/></filter>
      <filter id="hardGlow"><feGaussianBlur stdDeviation="6"/></filter>
    </defs>

    <rect width="1200" height="630" fill="#04060F"/>
    <rect width="1200" height="630" fill="url(#bg1)"/>
    <rect width="1200" height="630" fill="url(#bg2)"/>
    <rect width="1200" height="630" fill="url(#bg3)"/>
    <rect width="1200" height="630" fill="url(#bg4)"/>

    <g opacity=".75">
      <circle cx="180" cy="120" r="2.5" fill="#fff"/>
      <circle cx="950" cy="80" r="2" fill="#fff"/>
      <circle cx="1080" cy="220" r="1.8" fill="#fff"/>
      <circle cx="240" cy="520" r="2.2" fill="#fff"/>
      <circle cx="1050" cy="540" r="2.4" fill="#fff"/>
      <circle cx="640" cy="60" r="1.6" fill="#fff"/>
      <circle cx="380" cy="300" r="1.4" fill="#fff" opacity=".6"/>
      <circle cx="860" cy="380" r="1.6" fill="#fff" opacity=".6"/>
    </g>

    <g transform="translate(72,76)">
      <circle cx="6" cy="6" r="6" fill="#22C55E">
        <animate attributeName="opacity" values="1;.4;1" dur="2s" repeatCount="indefinite"/>
      </circle>
      <text x="22" y="11" fill="#CBD5E1" font-family="Inter,Arial" font-size="18" font-weight="800" letter-spacing="4">TOKEN GUARD · SMART SAVINGS</text>
    </g>

    <g filter="url(#softGlow)" opacity=".55">
      <text x="72" y="296" font-family="Inter,Arial" font-size="200" font-weight="900" fill="${titleGrad}" letter-spacing="-10">${escapeSvg(titleUsd)}</text>
    </g>
    <text x="72" y="296" font-family="Inter,Arial" font-size="200" font-weight="900" fill="${titleGrad}" letter-spacing="-10">${escapeSvg(titleUsd)}</text>

    <text x="72" y="350" fill="#F8FAFC" font-family="Inter,Arial" font-size="30" font-weight="700">${escapeSvg(subtitle)}</text>

    <g transform="translate(72,394)">
      <rect width="500" height="118" rx="24" fill="#0F172A" fill-opacity=".75" stroke="rgba(34,197,94,.35)"/>
      <text x="24" y="38" fill="#94A3B8" font-family="Inter,Arial" font-size="13" font-weight="800" letter-spacing="3">THIS WEEK</text>
      <text x="24" y="92" fill="#4ADE80" font-family="Inter,Arial" font-size="58" font-weight="900" letter-spacing="-2">${escapeSvg(formatCompact(saved))}</text>
      <text x="220" y="92" fill="#CBD5E1" font-family="Inter,Arial" font-size="22">tokens reclaimed</text>
    </g>
    <g transform="translate(596,394)">
      <rect width="532" height="118" rx="24" fill="#0F172A" fill-opacity=".75" stroke="rgba(56,189,248,.35)"/>
      <text x="24" y="38" fill="#94A3B8" font-family="Inter,Arial" font-size="13" font-weight="800" letter-spacing="3">TODAY</text>
      <text x="24" y="92" fill="#38BDF8" font-family="Inter,Arial" font-size="58" font-weight="900" letter-spacing="-2">${escapeSvg(formatCompact(savedToday))}</text>
      <text x="220" y="92" fill="#CBD5E1" font-family="Inter,Arial" font-size="22">tokens reclaimed</text>
    </g>

    ${chipsSvg}

    <text x="72" y="600" fill="#64748B" font-family="Inter,Arial" font-size="16">Local-first · zero upload · github.com/jwwzpf/TokenGuard</text>
  </svg>`;
}

function renderShareChips(items) {
  const startY = 538;
  const chipW = 252;
  const chipH = 62;
  const gap = 16;
  const startX = 72;

  return items.slice(0, 4).map(([emoji, value, label], i) => {
    const x = startX + i * (chipW + gap);
    return `<g transform="translate(${x},${startY})"><rect width="${chipW}" height="${chipH}" rx="18" fill="url(#chipGrad)" stroke="rgba(251,191,36,.35)"/><text x="22" y="40" font-family="Inter,Arial" font-size="28">${escapeSvg(emoji)}</text><text x="66" y="34" fill="#FDE68A" font-family="Inter,Arial" font-size="22" font-weight="900" letter-spacing="-.5">${escapeSvg(value)}</text><text x="66" y="52" fill="#CBD5E1" font-family="Inter,Arial" font-size="11" font-weight="700" letter-spacing="2.5">${escapeSvg(label)}</text></g>`;
  }).join('');
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
  const n = positive(value);

  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;

  return format(n);
}

function formatMoney(value) {
  const n = positive(value);

  if (n >= 1000) return n.toFixed(0);
  if (n >= 100) return n.toFixed(1);

  return n.toFixed(2);
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

