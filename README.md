<div align="center">

# Token Guard

**A local-first smart-savings layer for Claude Code and Codex.**

Stop feeding your whole repo to your AI. Cut the noise. Keep the signal.

[![npm version](https://img.shields.io/npm/v/token-guard.svg?style=flat-square)](https://www.npmjs.com/package/token-guard)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg?style=flat-square)](https://nodejs.org)
[![Local-first](https://img.shields.io/badge/local--first-✓-22c55e.svg?style=flat-square)](#trust--privacy)
[![No daemon](https://img.shields.io/badge/no_daemon-✓-22c55e.svg?style=flat-square)](#trust--privacy)
[![No upload](https://img.shields.io/badge/no_code_upload-✓-22c55e.svg?style=flat-square)](#trust--privacy)

</div>

---

## What Token Guard does

Token Guard sits between you and your AI coding agent and removes the most expensive class of waste in the loop: **unnecessary context tokens**.

It intercepts the agent before it dumps a 20k-token file when 600 tokens would do, before it pastes a 4MB log into the conversation, before it spawns a heavy Opus subagent for a 30-second `grep`, and before it carries a stale 60k-token transcript into the next session.

It is **local-first**, **opt-in per project**, and **never uploads code or prompts** anywhere.

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│   You ──► Agent ──► [ Token Guard ] ──► Filesystem / Shell       │
│                            │                                     │
│                            ├─ Narrow Read instead of full dump   │
│                            ├─ Bash output compression            │
│                            ├─ Long-input digest                  │
│                            ├─ Session handoff (compressed)       │
│                            ├─ Subagent delegation tracking       │
│                            └─ Session pressure monitoring        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Why this exists

Every full-file read, every noisy build log, every "let me re-grep the repo" round trip becomes part of the agent's working context — and you pay for every token, in money, latency, and quality. Long contexts also degrade reasoning.

Token Guard's bet is simple:

> Most of an AI coding agent's input tokens are not load-bearing. They are scaffolding the model would happily skip if you handed it the right 200 lines instead of the whole 9,000-line file.

So we hand it the right 200 lines.

---

## Quick start

```bash
# Install globally
npm install -g token-guard

# Inside any project root
cd ~/code/my-project
token-guard install

# Verify
token-guard doctor

# After a few coding sessions
token-guard report
token-guard open-report
```

Token Guard creates a visible `TokenGuard/` folder in your project so you always see what it is doing. Nothing is hidden in `~/.token-guard`. Nothing is uploaded.

Remove it cleanly at any time:

```bash
token-guard uninstall
```

---

## How it works

### Two channels, one core

Token Guard speaks to two agents with very different shapes.

| Channel        | Mechanism                                     | What it does                                                                                                  |
|----------------|-----------------------------------------------|---------------------------------------------------------------------------------------------------------------|
| **Claude Code** | Hooks (`.claude/settings.local.json`)         | Auto-fires on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`, `PreCompact`. |
| **Codex Desktop** | `AGENTS.md` rules + `tg` CLI                | Agent calls `tg session-check` / `tg turn-tick` / `tg handoff write` each turn. No daemon, pure local I/O.    |

`token-guard status` shows both channels side-by-side so you know exactly what is wired up.

### Smart Savings policy (single policy, automatic)

There are no user-facing modes. Token Guard runs one policy that:

- compresses filler, greetings, and tool-use narration; keeps root-cause analysis, tradeoffs, warnings, code, commands, identifiers, paths, and error strings intact;
- prefers narrow reads to full-file dumps;
- only intervenes when projected savings beat its own overhead.

---

## The toolkit

### `tg ctx` — narrow reads (the workhorse)

Returns just the slice of a file the agent actually needs. Logs the saved tokens to the local ledger.

```bash
tg ctx src/auth/session.ts                          # smart auto-slice
tg ctx src/auth/session.ts --focus verifyToken      # symbol or topic
tg ctx src/auth/session.ts --around "JWT decode"    # text region + N lines context
tg ctx src/auth/session.ts --lines 120:180          # explicit window
tg ctx src/auth/session.ts --diff                   # uncommitted diff only
```

Output ends with an explicit savings line so your agent can see the win:

```
Original estimate: 14,330 tokens
Returned estimate: 889 tokens
Estimated saved: 13,441 tokens (~94% smaller)
```

### Codex session monitoring loop

Codex has no native hooks. Token Guard exposes a tiny CLI so the agent can self-monitor.

```bash
tg session-check --reset    # once at start of a fresh Codex session

# every turn:
tg session-check            # OK / WARN / SWITCH (exit 2 = switch)
# ... do work, including `tg ctx` ...
tg turn-tick --output-tokens 420 --tool "tg-ctx,Read" --note "trace verifyToken"

# before /clear:
tg handoff write --goal "<current goal>" --note "<what's next>"
```

`tg ctx`, `tg read`, `tg find`, `tg edit`, and `tg summarize` all append an **inline pressure footer** when the session is approaching the budget, so the agent gets the warning even between `session-check` calls:

```
Token Guard session-pressure * WARN · ~85,051 tok cumulative · 17 turns.
Approaching context budget. Prefer narrow Read / `tg ctx`. Consider writing a handoff soon.
```

Default thresholds (tunable in `TokenGuard/config.json`):

| Level   | Cumulative tokens | Turns |
|---------|-------------------|-------|
| WARN    | 80,000            | 40    |
| SWITCH  | 120,000           | 80    |

### Model routing hints (Opus main axis + Explore subagents)

Token Guard classifies each long user prompt and emits a routing hint only when the signal is clear. **Default principle: quality > savings; default = keep current model.**

| Classification        | Hint                                                                                                                              |
|-----------------------|-----------------------------------------------------------------------------------------------------------------------------------|
| `heavy`               | Architecture / ADR / security / refactor / irreversible. **Stay on parent (e.g. Opus). Do not delegate.**                          |
| `heavy_with_lookup`   | Heavy task + parallelizable info gathering. **Keep main on parent; spawn parallel `Agent(subagent_type="Explore")` for lookups.** |
| `light_lookup`        | Pure `find`/`grep`/`where-is`/`list`. Delegate to `Explore` subagent.                                                              |
| `light_mechanical`    | Rename/format/lint/scaffold. Delegate to `haiku`/`sonnet`.                                                                        |
| `fan_out`             | Multi-AK / multi-criteria. Spawn one Agent per criterion in parallel.                                                              |
| `ambiguous`           | Silent. No hint emitted.                                                                                                          |

After a subagent returns, Token Guard echoes structured tracking:

```
Token Guard subagent delegation tracked:
- subagent_type=Explore · child=claude-sonnet-4-6 · parent=claude-opus-4-7
- estimated savings: ~9,000 claude-opus-4-7-equivalent tokens (factor 0.8)
- Good pattern: parent main-axis + Explore subagent for info gathering. Safe + cheap.
- Verify subagent claims (class names, file paths, line numbers) before depending on them.
```

### Compression layers

| Layer                  | What it does                                                                                                |
|------------------------|-------------------------------------------------------------------------------------------------------------|
| **Long-input digest**  | Re-distills user walls of text into a compressed working brief at `TokenGuard/sessions/input-digest.md`.    |
| **Bash output trim**   | Truncates noisy terminal output above a configurable line threshold; preserves head, tail, error lines.    |
| **Command cache**      | Reuses idempotent command output instead of re-running.                                                     |
| **Handoff**            | Compresses the last session into a state summary (`TokenGuard/sessions/handoff.md`) for the next session.  |
| **Web budget**         | Caps WebFetch/WebSearch per session to prevent runaway research loops.                                      |

---

## Reports

```bash
token-guard report           # write HTML + share-card SVG
token-guard open-report      # regenerate + open in browser
token-guard open-folder      # open the local TokenGuard/ folder
```

The HTML report shows **two numbers**: tokens saved today and tokens saved this week. No noisy per-category breakdown — just the totals.

It also renders:

- **USD saved** at both Sonnet and Opus blended rates;
- **Equivalents strip** — ☕ coffees · 📖 novels · 🍕 pizzas · 🎬 movie tickets;
- **Week-over-week velocity** badge (▲ / ▼ / ◆);
- **Sparklines** on every metric tile;
- **7-day trend** chart + **net efficiency** ring;
- A `share-card.svg` sized 1200×630 for social posts.

CLI prints the same totals:

```
$ token-guard report
Generated Savings Report:
- TokenGuard/reports/weekly-savings.html
- TokenGuard/reports/share-card.svg
Token Guard saved today:     33,200 tokens
Token Guard saved this week: 232,400 tokens
```

Override pricing if you use different model rates:

```bash
TG_PRICE_PER_M=2 token-guard report   # custom $/M for Sonnet column
```

---

## Command reference

### Lifecycle

```bash
token-guard install [--no-claude] [--no-codex]
token-guard upgrade                          # refresh hooks/rules after npm update
token-guard uninstall [--keep-data]
token-guard enable | disable
token-guard status
token-guard doctor
token-guard version
```

### Agent-facing tools (work in any project)

```bash
tg ctx <file>                                 [--focus|--around|--lines|--diff] [--max-tokens N]
tg read <file>                                [--symbol|--section|--around|--lines|--diff]
tg find <symbol-or-query>                     [--rebuild]
tg index                                      # rebuild symbol index
tg summarize <file>
tg edit <file> --old TEXT --new TEXT          [--all]
tg estimate                                   # project-wide token estimate
tg allow <file> --once                        # one-time force-read whitelist
```

### Codex session monitoring

```bash
tg session-check                              [--reset] [--json]
tg turn-tick --output-tokens N --tool "x,y"   [--prompt "<text>"] [--note "<goal>"]
tg handoff write --goal "<goal>"              [--note "<next>"] [--force]
tg handoff show
```

### Reports

```bash
token-guard report
token-guard open-report
token-guard open-folder
token-guard stats
```

---

## Configuration

After install, edit `TokenGuard/config.json`. Defaults shown below.

```jsonc
{
  "enabled": true,
  "policy": { "strategy": "smart", "guardOnlyHighConfidenceWaste": true },
  "thresholds": {
    "softTokens": 25000,
    "hardTokens": 60000,
    "precisionReadMaxTokens": 6000,
    "narrowReadMaxLines": 200,
    "bashOutputMaxLines": 140,
    "hugeFileBytes": 500000,
    "logBytes": 120000
  },
  "longInput": { "enabled": true, "minChars": 4000, "maxDigestChars": 6000 },
  "webBudget": { "enabled": true, "maxPerSession": 6 },
  "modelRouter": {
    "enabled": true,
    "qualityFirst": true,
    "parentModel": "claude-opus-4-7",
    "minPromptCharsForHint": 600,
    "hintCooldownTurns": 6
  },
  "codex": {
    "sessionWarnTokens": 80000,
    "sessionSwitchTokens": 120000,
    "sessionWarnTurns": 40,
    "sessionSwitchTurns": 80
  }
}
```

---

## Trust & privacy

| Property                  | Status |
|---------------------------|--------|
| Local-first               | ✅     |
| Code upload               | ❌ never |
| Background daemon         | ❌ none  |
| Cloud backend             | ❌ none  |
| Telemetry                 | ❌ none  |
| API keys                  | ❌ not required |
| Visible project folder    | ✅ `TokenGuard/` |
| Clean uninstall           | ✅ `token-guard uninstall` |
| `.gitignore` self-managed | ✅ automatic |

Everything Token Guard does happens inside your project directory or in `.claude/settings.local.json`. There is no `~/.token-guard` global store, no socket, no daemon, no telemetry endpoint. You can delete `TokenGuard/` at any time and the tool degrades gracefully.

---

## Project layout (after install)

```
your-project/
├── TokenGuard/
│   ├── config.json
│   ├── ledger/events.jsonl
│   ├── sessions/
│   │   ├── handoff.md
│   │   ├── input-digest.md
│   │   └── codex-turns.jsonl
│   ├── memory/
│   ├── summaries/
│   ├── index/symbols.json
│   ├── cache/
│   └── reports/
│       ├── weekly-savings.html
│       └── share-card.svg
├── .claude/settings.local.json     # Claude Code hooks
├── AGENTS.md                       # Codex rules
└── CLAUDE.local.md                 # Claude rules
```

---

## FAQ

**Does it work with both Claude Code and Codex?**
Yes. Claude Code gets full hook-based integration. Codex gets the same engine plus a CLI loop (`tg session-check` / `tg turn-tick` / `tg handoff write`) that the agent calls itself per `AGENTS.md` rules.

**Will it break my agent?**
No. Token Guard hooks return additional context, not destructive rewrites. Disable any time with `token-guard disable` or remove with `token-guard uninstall`.

**Why no daemon?**
Daemons hide behavior, leak across projects, and need lifecycle management. Token Guard is pure CLI + filesystem; everything is inspectable.

**How are token counts estimated?**
A conservative `chars / 4` approximation. Exact tokenization is model-dependent, so the report estimates a lower bound on savings, not a marketing-friendly upper bound.

**Can I override the model pricing?**
Yes. Set `TG_PRICE_PER_M=<rate>` before running `token-guard report`.

**Where does the "subagent saved tokens" number come from?**
The `PostToolUse` hook on `Agent`/`Task` calls computes `parent_blend_price - child_blend_price`, multiplies by estimated subagent token cost, and records `savedEquivalentTokens` in the ledger.

---

## Roadmap

- Stats accuracy: surface per-tool savings in `tg stats` without polluting the headline report.
- Auto turn-tick from `tg ctx`/`tg read` so Codex does not need a separate end-of-turn call.
- Optional Slack/Discord webhook for SWITCH-level alerts.
- Symbol index incremental updates.

---

## Contributing

Issues and PRs welcome at [github.com/jwwzpf/TokenGuard](https://github.com/jwwzpf/TokenGuard).

Run the test suite:

```bash
npm test
```

---

## License

Apache 2.0 — see [LICENSE](LICENSE).

---

<div align="center">

**Token Guard · local-first smart savings for AI coding loops**

Built by Coding Daddy.

</div>
