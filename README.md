<div align="center">

# Token Guard

**Cut wasted tokens from your AI coding loop.**

A local-first smart-savings layer for Claude Code and Codex.

Token Guard helps AI coding agents spend tokens on signal, not noise: precise code context, compressed tool output, cleaner handoffs, smarter session pressure, model/subagent routing hints, and shareable savings reports.

[![npm](https://img.shields.io/npm/v/%40codingdaddy%2Ftoken-guard?label=npm)](https://www.npmjs.com/package/@codingdaddy/token-guard)
![License](https://img.shields.io/badge/License-Apache%202.0-blue)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![local-first](https://img.shields.io/badge/local--first-yes-brightgreen)
![no daemon](https://img.shields.io/badge/no%20daemon-yes-brightgreen)
![no code upload](https://img.shields.io/badge/no%20code%20upload-yes-brightgreen)

</div>

---

## Why Token Guard exists

AI coding agents are powerful, but they waste tokens in predictable ways:

- reading a 9,000-line file when 200 lines would do
- pasting noisy build logs into the conversation
- re-running the same grep or status command
- carrying stale session context into the next task
- exploring the whole repo because the prompt is too broad
- burning expensive model context on cheap lookup work
- letting long sessions silently grow until reasoning quality drops

Token Guard is a local-first savings layer that helps agents avoid that waste without uploading your code, running a daemon, or replacing your existing workflow.

It does not try to become a new coding agent.  
It helps your existing agent use context more intelligently.

---

## Quick start

Install globally:

```bash
npm install -g @codingdaddy/token-guard
```

Inside any project root:

```bash
cd ~/code/my-project
token-guard install
token-guard doctor
```

After a few coding sessions:

```bash
token-guard report
token-guard open-report
```

Clean uninstall:

```bash
token-guard uninstall
```

Token Guard creates a visible `TokenGuard/` folder in your project so you can inspect what it is doing.

Nothing is hidden in `~/.token-guard`.  
Nothing is uploaded.

---

## What Token Guard saves

Token Guard looks for waste across the whole AI coding loop.

| Waste source | What Token Guard does |
|---|---|
| Huge source files | Uses `tg ctx` and targeted reads instead of full-file dumps |
| Noisy terminal output | Compresses Maven, Git, test, build, and generic shell output |
| Long user prompts | Writes a compressed working brief for follow-up turns |
| Stale long sessions | Maintains handoff files so `/clear` does not mean starting from zero |
| Broad vague tasks | Nudges the agent to ask for a precise entry point before expensive repo exploration |
| Repeated commands | Caches safe idempotent command output |
| Web/search loops | Tracks and budgets WebFetch/WebSearch usage |
| Model/subagent waste | Emits routing hints when lookup work can be delegated safely |
| Session pressure | Warns before long sessions become expensive or low-quality |

The goal is simple:

> Spend tokens on the code, errors, commands, and decisions that actually matter.

---

## Trust model

| Property | Status |
|---|---|
| Local-first | ✅ |
| Code upload | ❌ never |
| Background daemon | ❌ none |
| Cloud backend | ❌ none |
| Telemetry | ❌ none |
| API keys | ❌ not required |
| Visible project folder | ✅ `TokenGuard/` |
| Clean uninstall | ✅ `token-guard uninstall` |
| `.gitignore` self-managed | ✅ automatic |

Token Guard uses project-local files and Claude/Codex integration points. It does not run a background service and does not send your code or prompts anywhere.

Everything Token Guard does is inspectable in your project.

---

## How it works

Token Guard sits between the agent and the expensive parts of the coding loop:

```text
You ──► Agent ──► [ Token Guard ] ──► Filesystem / Shell / Session
                         │
                         ├─ Precise context instead of full dumps
                         ├─ Bash output compression
                         ├─ Long-input digest
                         ├─ Session handoff
                         ├─ Session pressure monitoring
                         ├─ Web/search budget tracking
                         └─ Model/subagent routing hints
```

It supports two main channels:

| Agent | Mechanism | What it does |
|---|---|---|
| Claude Code | Hooks in `.claude/settings.local.json` | Auto-fires on session start, user prompt, tool use, compact, stop, and session end |
| Codex Desktop | `AGENTS.md` rules + `tg` CLI | Lets Codex call Token Guard tools during the coding loop |

Run:

```bash
token-guard status
```

to see what is wired up in the current project.

---

## Smart Savings policy

There are no user-facing modes.

Token Guard runs one automatic policy:

- compress filler, greetings, repeated narration, and noisy tool output
- keep root-cause analysis, tradeoffs, warnings, code, commands, identifiers, paths, and error strings intact
- prefer narrow reads to full-file dumps
- only intervene when projected savings are likely to beat its own overhead
- keep the agent productive instead of blocking work unnecessarily

Token Guard should feel quiet most of the time.

When it speaks, it should save more tokens than it costs.

---

## Core tool: `tg ctx`

`tg ctx` is the workhorse for precise code reading.

Instead of feeding a whole file to the agent, it returns only the slice the agent needs.

```bash
tg ctx src/auth/session.ts
tg ctx src/auth/session.ts --focus verifyToken
tg ctx src/auth/session.ts --around "JWT decode"
tg ctx src/auth/session.ts --lines 120:180
tg ctx src/auth/session.ts --diff
```

Example output:

```text
Token Guard targeted read
File: src/auth/session.ts
Kind: around
Lines: 140:178
Original estimate: 14,330 tokens
Returned estimate: 889 tokens
Estimated saved: 13,441 tokens

...
```

This is especially useful for:

- large UI files
- localization/copy files
- service classes
- test files
- generated-looking code
- config-heavy files
- files the agent only needs to inspect locally

The savings are recorded in:

```text
TokenGuard/ledger/events.jsonl
```

and included in the savings report.

---

## Smart tool-output compression

Build and test commands can produce thousands of lines of output.

Token Guard trims noisy output while preserving diagnostic signal.

It keeps:

- build success/failure lines
- test summaries
- failed tests
- compile errors
- assertion failures
- exception type and message
- relevant stack frames
- Git diff hunk headers and changed lines

It aggressively removes:

- Maven download/progress noise
- repeated plugin banners
- huge framework stack traces
- repeated build module banners
- Testcontainer image pull logs
- noisy generic shell output

Example:

```text
Token Guard compressed maven output and preserved diagnostic signals.
Estimated saved: ~20,400 tokens.
```

Supported profiles include Maven, Git, and generic shell output. More profiles can be added over time.

---

## Long-input digest

When the user sends a very long prompt, Token Guard writes a compressed working brief:

```text
TokenGuard/sessions/input-digest.md
```

The agent can use this brief in later turns instead of repeatedly re-processing the entire original prompt.

This is useful for:

- long implementation plans
- pasted specs
- research notes
- multi-step bug reports
- task handoff messages
- large Claude/Codex instructions

Token Guard keeps important requirements, decisions, identifiers, file paths, commands, constraints, and open questions.

---

## Precision Input Assistant

Broad prompts can trigger expensive repo exploration.

For example:

```text
Help me check what is wrong with this project.
```

An agent may start reading many files and running broad searches.

Token Guard can nudge the agent to ask one focused question first:

```text
This task is broad. Broad repo exploration can cost many tokens. To reduce the user’s token cost, ask for one starting point first: an error log, related file name, page/screen name, module name, or test command.
```

This does not force the user through a long questionnaire.

It only helps avoid expensive blind exploration when the request is too vague.

---

## Session handoff

Long sessions get expensive and harder to reason about.

Token Guard maintains a compressed handoff file:

```text
TokenGuard/sessions/handoff.md
```

The goal:

> Start fresh without starting from zero.

Before a `/clear`, compact, stop, or session end, Token Guard can preserve the current state:

- current goal
- files touched
- files read
- commands run
- failure signals
- next smallest task
- do-not-repeat notes

This helps the next session resume with less context.

---

## Session Reset Assistant

Claude Code may suggest:

```text
/clear to save 140K tokens
```

Token Guard helps make that safe by checking that the handoff is ready.

When the session is large or a reset is likely, Token Guard can prepare:

```text
TokenGuard/sessions/reset-ready.md
```

and give the agent a short reminder that it can continue from the handoff after clearing context.

---

## Codex session monitoring

Codex does not have the same native hook model as Claude Code, so Token Guard exposes a small CLI loop.

At the start of a fresh Codex session:

```bash
tg session-check --reset
```

Each turn:

```bash
tg session-check
# do work
tg turn-tick --output-tokens 420 --tool "tg-ctx,Read" --note "trace verifyToken"
```

Before clearing context:

```bash
tg handoff write --goal "<current goal>" --note "<what's next>"
```

Useful commands:

```bash
tg handoff show
tg session-check --json
```

Default pressure thresholds are tunable in `TokenGuard/config.json`.

| Level | Cumulative tokens | Turns |
|---|---:|---:|
| WARN | 80,000 | 40 |
| SWITCH | 120,000 | 80 |

When pressure rises, Token Guard nudges the agent toward narrow reads, handoff writing, or a fresh session.

---

## Model routing hints

Token Guard can classify long user prompts and emit routing hints when the signal is clear.

Default principle:

> Quality first. Keep the current model unless there is a strong reason to route differently.

| Classification | Hint |
|---|---|
| `heavy` | Architecture, ADR, security, refactor, irreversible work. Stay on parent model. |
| `heavy_with_lookup` | Keep main reasoning on parent model; delegate lookup work to Explore subagents. |
| `light_lookup` | Pure find/grep/where-is/list work. Delegate to cheaper lookup path. |
| `light_mechanical` | Rename, format, lint, scaffold. Use cheaper model if available. |
| `fan_out` | Multi-criteria exploration. Spawn one parallel subagent per criterion. |
| `ambiguous` | Stay silent. No hint emitted. |

After subagent work, Token Guard can track estimated equivalent savings and remind the parent agent to verify subagent claims before depending on them.

---

## Web/search budget

WebFetch and WebSearch can become a hidden token sink.

Token Guard tracks web/search usage and can warn when a session is turning into a research loop.

This is useful when the agent starts:

- searching repeatedly for the same topic
- reading many pages without deciding
- using web research when local files are enough
- expanding scope beyond the current coding task

The goal is not to block research.

The goal is to keep research proportional to the task.

---

## Savings report

Generate a local HTML report and share-card SVG:

```bash
token-guard report
token-guard open-report
```

The report focuses on one thing first:

> How many tokens did Token Guard save?

It avoids noisy per-category zero values in the main view.

It can also show:

- tokens saved today
- tokens saved this week
- cost estimates
- trend badges
- sparklines
- 7-day trend chart
- net efficiency ring
- social-share card
- equivalent savings strip, such as coffees, novels, pizzas, or movie tickets

Generated files:

```text
TokenGuard/reports/weekly-savings.html
TokenGuard/reports/share-card.svg
```

CLI output:

```bash
$ token-guard report
Generated Savings Report:
- TokenGuard/reports/weekly-savings.html
- TokenGuard/reports/share-card.svg
Token Guard saved today:     33,200 tokens
Token Guard saved this week: 232,400 tokens
```

Override pricing if you use different model rates:

```bash
TG_PRICE_PER_M=2 token-guard report
```

---

## Command reference

### Lifecycle

```bash
token-guard install [--no-claude] [--no-codex]
token-guard upgrade
token-guard uninstall [--keep-data]
token-guard enable
token-guard disable
token-guard status
token-guard doctor
token-guard version
```

### Agent-facing context tools

```bash
tg ctx <file> [--focus NAME] [--around TEXT] [--lines A:B] [--diff] [--max-tokens N]
tg read <file> [--symbol NAME] [--section NAME] [--around TEXT] [--lines A:B] [--diff]
tg find <symbol-or-query> [--rebuild]
tg index
tg summarize <file>
tg edit <file> --old TEXT --new TEXT [--all]
tg estimate
tg allow <file> --once
```

### Codex session monitoring

```bash
tg session-check [--reset] [--json]
tg turn-tick --output-tokens N --tool "x,y" [--prompt "<text>"] [--note "<goal>"]
tg handoff write --goal "<goal>" [--note "<next>"] [--force]
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

After install, edit:

```text
TokenGuard/config.json
```

Example:

```json
{
  "enabled": true,
  "policy": {
    "strategy": "smart",
    "guardOnlyHighConfidenceWaste": true
  },
  "thresholds": {
    "softTokens": 25000,
    "hardTokens": 60000,
    "precisionReadMaxTokens": 6000,
    "narrowReadMaxLines": 200,
    "bashOutputMaxLines": 140,
    "hugeFileBytes": 500000,
    "logBytes": 120000
  },
  "longInput": {
    "enabled": true,
    "minChars": 4000,
    "maxDigestChars": 6000
  },
  "webBudget": {
    "enabled": true,
    "maxPerSession": 6
  },
  "precisionInput": {
    "enabled": true
  },
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

## Project layout after install

```text
your-project/
├── TokenGuard/
│   ├── config.json
│   ├── ledger/
│   │   └── events.jsonl
│   ├── sessions/
│   │   ├── handoff.md
│   │   ├── input-digest.md
│   │   └── codex-turns.jsonl
│   ├── memory/
│   ├── summaries/
│   ├── index/
│   │   └── symbols.json
│   ├── cache/
│   └── reports/
│       ├── weekly-savings.html
│       └── share-card.svg
├── .claude/
│   └── settings.local.json
├── AGENTS.md
└── CLAUDE.local.md
```

Token Guard also updates `.gitignore` so local Token Guard state does not accidentally enter your repository.

---

## FAQ

### Does Token Guard work with both Claude Code and Codex?

Yes.

Claude Code gets hook-based integration.

Codex gets the same engine through `AGENTS.md` rules and the `tg` CLI.

---

### Does Token Guard upload my code?

No.

Token Guard is local-first. It does not upload code, prompts, logs, reports, or telemetry.

---

### Does Token Guard run in the background?

No.

There is no daemon.

Token Guard only runs when:

- a Claude Code hook triggers it
- Codex calls a `tg` command
- you run a Token Guard CLI command manually

Then it exits.

---

### Will it break my agent?

It is designed not to.

Token Guard prefers better context paths over hard blocking. It only intervenes on high-confidence waste and keeps escape hatches such as:

```bash
tg allow <file> --once
```

and prompt-level force-read markers.

You can disable it at any time:

```bash
token-guard disable
```

or uninstall cleanly:

```bash
token-guard uninstall
```

---

### How are token counts estimated?

Token Guard uses a conservative approximation based on text length.

Exact tokenization is model-dependent. The report should be treated as an estimate, not a billing statement.

---

### Can I change model pricing?

Yes.

```bash
TG_PRICE_PER_M=2 token-guard report
```

---

### Why not just rely on the model's own context management?

Built-in model context management helps, but AI coding agents still waste tokens through files, shell output, repeated commands, broad exploration, and long sessions.

Token Guard works at the workflow layer.

It helps the agent choose better context before the tokens are spent.

---

## Development

Clone the repository:

```bash
git clone https://github.com/jwwzpf/TokenGuard.git
cd TokenGuard
npm install
npm test
```

Test the CLI locally:

```bash
npm install -g .
token-guard version
```

Create a temporary project:

```bash
mkdir /tmp/tg-test
cd /tmp/tg-test
token-guard install
token-guard doctor
token-guard report
token-guard uninstall
```

---

## Contributing

Issues and PRs are welcome.

The most valuable contributions right now are:

- bug reports with reproduction steps
- failing test cases
- documentation improvements
- new tool-output compression profiles
- improvements to targeted context reading
- better Codex / Claude workflow support
- safer savings accounting

For major changes, please open an issue first.

General flow:

1. Fork the repository.
2. Create a feature branch.
3. Make a focused change.
4. Run `npm test`.
5. Open a pull request.

Design principles:

- Save tokens automatically.
- Do not degrade coding quality.
- Prefer precise context over hard blocking.
- Keep everything local-first.
- No daemon.
- No cloud backend.
- No code upload.
- Every intervention must justify its own token cost.

Unless explicitly stated otherwise, contributions submitted to Token Guard are licensed under Apache-2.0.

See `CONTRIBUTING.md` for details.

---

## Security

Please do not open a public issue for security vulnerabilities.

Report security issues using the process described in `SECURITY.md`.

Token Guard is designed to avoid collecting secrets or uploading project data, but it still touches local project files and agent workflow metadata, so security reports are taken seriously.

---

## Attribution

Token Guard is licensed under Apache-2.0. You are free to use, modify, and redistribute it.

If you build a derivative work or redistribute a modified version, please preserve the original license and attribution notice:

> Based on Token Guard by Coding Daddy — `@codingdaddy/token-guard`

See `NOTICE` for attribution details.

---

## License

Apache-2.0 — see `LICENSE`.

---

<div align="center">

**Token Guard** · local-first smart savings for AI coding loops

Built by Coding Daddy

</div>
