# Token Guard

**Stop feeding your whole repo to AI.**

Token Guard is a local-first helper for Claude Code and Codex desktop. It reduces wasted AI coding context by keeping a lightweight project memory, warning about huge/generated/log files, maintaining a fresh-session handoff, and generating a shareable Savings Report.

Built by Coding Daddy as a free developer utility.

## Why

AI coding tools are powerful, but long sessions and broad repo reads burn tokens fast. Token Guard is designed for one workflow:

1. Install once in a project.
2. Keep using Claude Code or Codex desktop normally.
3. Token Guard quietly records waste, maintains handoff context, and guards obvious token traps.
4. Run `token-guard report` when you want a visual Savings Report.

## Current MVP scope

- Claude Code: automatic hooks via `.claude/settings.local.json`.
- Codex desktop: project instructions via `AGENTS.md`.
- Visible local folder: `TokenGuard/`, not a hidden dot-folder.
- No daemon by default. Token Guard only runs when Claude hooks call it or when you run a command.
- No cloud backend, no code upload, no API calls.

## Install locally while developing

```bash
npm install -g .
```

Then inside any project:

```bash
token-guard install --observe
```

Use Claude Code or Codex desktop as usual.

Generate a report:

```bash
token-guard report
token-guard open-report
```

## Modes

### Observe mode

Default. Records waste and gives guidance, but does not block tool calls.

```bash
token-guard mode observe
```

### Active mode

Claude Code hooks may deny obvious high-cost full-file reads, such as generated, dependency, build, coverage, lock, and long log files.

```bash
token-guard mode active
```

## Commands

```bash
token-guard install [--observe|--active] [--no-claude] [--no-codex]
token-guard status
token-guard enable
token-guard disable
token-guard mode observe|active
token-guard estimate
token-guard report
token-guard open-report
token-guard open-folder
token-guard uninstall
```

## Files created in your project

```text
TokenGuard/
  config.json
  reports/
  memory/
  sessions/
  summaries/
  ledger/
.claude/settings.local.json
CLAUDE.local.md
AGENTS.md
```

`TokenGuard/`, `CLAUDE.local.md`, and `.claude/settings.local.json` are added to `.gitignore` by default.

## Claude Code integration

Token Guard installs command hooks for session start, prompts, pre-tool calls, post-tool calls, stop, compaction, and session end. In observe mode, it mainly logs and injects context. In active mode, it can block obvious large file reads.

## Codex desktop integration

The first MVP supports Codex desktop through `AGENTS.md` instructions. Full automatic tool-call guarding for Codex will come later through MCP.

## Roadmap

- MCP server for Codex CLI / IDE / desktop where supported.
- Better repo map and symbol summaries.
- PNG export for the share card.
- Weekly digest command.
- Safe memory diet: keep `TokenGuard/memory/core.md` short and move old notes to archive.
