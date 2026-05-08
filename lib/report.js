import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureProjectFiles, getPaths } from './project.js';
import { summarizeSavings } from './ledger.js';

export function generateReport(projectRoot = process.cwd()) {
  const paths = ensureProjectFiles(projectRoot);
  const model = summarizeSavings(projectRoot);

  const html = renderHtml(model);
  const svg = renderSvg(model);

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

function renderHtml(model) {
  const topWasters = model.topWasters.length
    ? model.topWasters
        .map(
          row =>
            `<tr><td>${escapeHtml(row.file)}</td><td>${format(row.tokens)}</td></tr>`
        )
        .join('\n')
    : '<tr><td colspan="2">No token wasters recorded yet.</td></tr>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Token Guard Weekly Savings Report</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root {
      color-scheme: dark;
      --bg: #09090b;
      --card: #111827;
      --muted: #94a3b8;
      --text: #f8fafc;
      --green: #22c55e;
      --blue: #38bdf8;
      --amber: #f59e0b;
      --red: #fb7185;
      --border: rgba(148, 163, 184, 0.22);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 40px;
      background:
        radial-gradient(circle at top left, rgba(56, 189, 248, 0.16), transparent 30%),
        radial-gradient(circle at bottom right, rgba(34, 197, 94, 0.12), transparent 35%),
        var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    main {
      max-width: 1080px;
      margin: 0 auto;
    }

    .hero {
      border: 1px solid var(--border);
      border-radius: 28px;
      padding: 36px;
      background: linear-gradient(135deg, rgba(17, 24, 39, 0.96), rgba(15, 23, 42, 0.82));
      box-shadow: 0 24px 90px rgba(0, 0, 0, 0.35);
    }

    .eyebrow {
      color: var(--blue);
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-size: 13px;
    }

    h1 {
      margin: 10px 0 8px;
      font-size: clamp(36px, 7vw, 76px);
      line-height: 0.95;
      letter-spacing: -0.06em;
    }

    .subtitle {
      color: var(--muted);
      font-size: 20px;
      max-width: 760px;
      line-height: 1.5;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 16px;
      margin-top: 28px;
    }

    .card {
      border: 1px solid var(--border);
      border-radius: 22px;
      padding: 22px;
      background: rgba(15, 23, 42, 0.72);
    }

    .label {
      color: var(--muted);
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .value {
      margin-top: 8px;
      font-size: 34px;
      font-weight: 800;
      letter-spacing: -0.04em;
    }

    .green {
      color: var(--green);
    }

    .blue {
      color: var(--blue);
    }

    .amber {
      color: var(--amber);
    }

    .section {
      margin-top: 28px;
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 26px;
      background: rgba(15, 23, 42, 0.62);
    }

    h2 {
      margin: 0 0 16px;
      font-size: 24px;
      letter-spacing: -0.03em;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      overflow: hidden;
    }

    td, th {
      text-align: left;
      border-bottom: 1px solid var(--border);
      padding: 12px 0;
      color: #e2e8f0;
    }

    th {
      color: var(--muted);
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .note {
      margin-top: 18px;
      color: var(--muted);
      line-height: 1.55;
    }

    footer {
      margin-top: 32px;
      color: var(--muted);
      font-size: 14px;
      text-align: center;
    }

    @media (max-width: 780px) {
      body {
        padding: 20px;
      }

      .grid {
        grid-template-columns: 1fr;
      }

      .hero {
        padding: 24px;
      }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div class="eyebrow">Token Guard Weekly Savings Report</div>
      <h1>Stop feeding your whole repo to AI.</h1>
      <p class="subtitle">
        A local-first context budget report for Claude Code and Codex.
        This report separates gross avoided context from estimated net savings, with repeated-block discounts and fallback penalties applied.
      </p>

      <div class="grid">
        <div class="card">
          <div class="label">Gross avoided context</div>
          <div class="value green">${format(model.grossAvoidedTokens)}</div>
        </div>
        <div class="card">
          <div class="label">Estimated net savings</div>
          <div class="value blue">${format(model.netSavingsTokens)}</div>
        </div>
        <div class="card">
          <div class="label">Potential waste flagged</div>
          <div class="value amber">${format(model.potentialWasteFlaggedTokens)}</div>
        </div>
      </div>
    </section>

    <section class="section">
      <h2>Trust adjustments</h2>
      <div class="grid">
        <div class="card">
          <div class="label">Repeated blocks discounted</div>
          <div class="value">${format(model.repeatedBlocks)}</div>
        </div>
        <div class="card">
          <div class="label">Fallback tool calls detected</div>
          <div class="value">${format(model.fallbackToolCalls)}</div>
        </div>
        <div class="card">
          <div class="label">Fallback penalty</div>
          <div class="value">${format(model.fallbackPenaltyTokens)}</div>
        </div>
      </div>
      <p class="note">
        Repeated blocks are discounted because prompt/cache effects make repeated savings less valuable than the first block.
        Fallback sed/grep/rg calls are penalized because a blocked read can cause extra tool usage.
      </p>
    </section>

    <section class="section">
      <h2>Flow improvements</h2>
      <div class="grid">
        <div class="card">
          <div class="label">Bash outputs trimmed</div>
          <div class="value">${format(model.bashOutputTrimmed)}</div>
        </div>
        <div class="card">
          <div class="label">Bash trim savings</div>
          <div class="value green">${format(model.bashOutputSavedTokens)}</div>
        </div>
        <div class="card">
          <div class="label">Reminder dedup savings</div>
          <div class="value green">${format(model.reminderDedupSavedTokens)}</div>
        </div>
      </div>
    </section>

    <section class="section">
      <h2>Control and escape hatches</h2>
      <div class="grid">
        <div class="card">
          <div class="label">Hard blocks</div>
          <div class="value">${format(model.hardBlocks)}</div>
        </div>
        <div class="card">
          <div class="label">Observe warnings</div>
          <div class="value">${format(model.softWarnings)}</div>
        </div>
        <div class="card">
          <div class="label">Force reads used</div>
          <div class="value">${format(model.forceReadUses)}</div>
        </div>
      </div>
    </section>

    <section class="section">
      <h2>Top token wasters</h2>
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Tokens</th>
          </tr>
        </thead>
        <tbody>
          ${topWasters}
        </tbody>
      </table>
    </section>

    <footer>
      Generated by Token Guard · by Coding Daddy
    </footer>
  </main>
</body>
</html>`;
}

function renderSvg(model) {
  return `<svg width="1200" height="630" viewBox="0 0 1200 630" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
      <stop stop-color="#020617"/>
      <stop offset="0.55" stop-color="#111827"/>
      <stop offset="1" stop-color="#052e16"/>
    </linearGradient>
    <radialGradient id="glow1" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(180 80) rotate(40) scale(520)">
      <stop stop-color="#38bdf8" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#38bdf8" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(1060 600) rotate(40) scale(520)">
      <stop stop-color="#22c55e" stop-opacity="0.38"/>
      <stop offset="1" stop-color="#22c55e" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="1200" height="630" rx="0" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow1)"/>
  <rect width="1200" height="630" fill="url(#glow2)"/>

  <text x="72" y="88" fill="#38BDF8" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="700" letter-spacing="4">
    TOKEN GUARD WEEKLY REPORT
  </text>

  <text x="72" y="178" fill="#F8FAFC" font-family="Inter, Arial, sans-serif" font-size="72" font-weight="900">
    Stop feeding your
  </text>
  <text x="72" y="258" fill="#F8FAFC" font-family="Inter, Arial, sans-serif" font-size="72" font-weight="900">
    whole repo to AI.
  </text>

  <rect x="72" y="330" width="320" height="150" rx="28" fill="#0F172A" fill-opacity="0.78" stroke="#334155"/>
  <text x="100" y="380" fill="#94A3B8" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="700">
    Gross avoided
  </text>
  <text x="100" y="442" fill="#22C55E" font-family="Inter, Arial, sans-serif" font-size="56" font-weight="900">
    ${format(model.grossAvoidedTokens)}
  </text>

  <rect x="440" y="330" width="320" height="150" rx="28" fill="#0F172A" fill-opacity="0.78" stroke="#334155"/>
  <text x="468" y="380" fill="#94A3B8" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="700">
    Net savings
  </text>
  <text x="468" y="442" fill="#38BDF8" font-family="Inter, Arial, sans-serif" font-size="56" font-weight="900">
    ${format(model.netSavingsTokens)}
  </text>

  <rect x="808" y="330" width="320" height="150" rx="28" fill="#0F172A" fill-opacity="0.78" stroke="#334155"/>
  <text x="836" y="380" fill="#94A3B8" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="700">
    Fallback calls
  </text>
  <text x="836" y="442" fill="#F59E0B" font-family="Inter, Arial, sans-serif" font-size="56" font-weight="900">
    ${format(model.fallbackToolCalls)}
  </text>

  <text x="72" y="550" fill="#CBD5E1" font-family="Inter, Arial, sans-serif" font-size="24">
    Repeated blocks discounted: ${format(model.repeatedBlocks)} · Bash outputs trimmed: ${format(model.bashOutputTrimmed)} · Reminder deduped: ${format(model.reminderDeduped)}
  </text>

  <text x="72" y="596" fill="#94A3B8" font-family="Inter, Arial, sans-serif" font-size="20">
    Generated by Token Guard · by Coding Daddy
  </text>
</svg>`;
}

function openPath(target) {
  const platform = os.platform();

  try {
    if (platform === 'darwin') {
      childProcess.execFileSync('open', [target]);
    } else if (platform === 'win32') {
      childProcess.execFileSync('cmd', ['/c', 'start', '', target]);
    } else {
      childProcess.execFileSync('xdg-open', [target]);
    }
  } catch {
    // Opening is best effort. The CLI still prints the path.
  }
}

function format(n) {
  return Math.round(Number(n || 0)).toLocaleString('en-US');
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
