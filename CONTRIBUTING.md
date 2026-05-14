# Contributing to Token Guard

Thanks for your interest in contributing.

Token Guard is early. The most valuable contributions right now are:

- bug reports with reproduction steps
- failing test cases
- documentation improvements
- new tool-output compression profiles
- improvements to targeted context reading
- better Claude Code / Codex workflow support
- safer savings accounting

## Development setup

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

## Pull request process

1. Fork the repository.
2. Create a feature branch.
3. Make a focused change.
4. Run `npm test`.
5. Open a pull request.

For major changes, please open an issue first.

## Design principles

- Save tokens automatically.
- Do not degrade agent coding quality.
- Prefer precise context over hard blocking.
- Keep Token Guard local-first.
- No daemon.
- No cloud backend.
- No code upload.
- Every intervention must justify its own token cost.

## Contribution license

Unless explicitly stated otherwise, any contribution intentionally submitted for inclusion in Token Guard is submitted under the Apache License 2.0.