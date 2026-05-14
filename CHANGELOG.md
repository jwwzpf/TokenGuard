# Changelog

All notable changes to Token Guard will be documented in this file.

## [0.4.5] - 2026-05-14

### Added
- Total Savings Report focused on total tokens saved.
- Precision Input Assistant for broad prompts that may cause expensive repo exploration.
- Context savings accounting for targeted reads.
- Smart tool output compression profiles for noisy command output.
- Session Reset Assistant for safer `/clear` workflows.
- Codex session monitoring loop.
- Model and subagent routing hints.
- Web/search budget tracking.
- `token-guard version`, `token-guard stats`, and `token-guard upgrade`.

### Changed
- npm package name changed to `@jwwzpf/token-guard`.
- README installation flow updated for scoped npm package.
- Reports now emphasize total savings instead of noisy per-category zero values.

### Fixed
- Avoid false trim events when compressed output would be larger than original output.
- Improved savings accounting after Token Guard overhead.
- Improved report messaging when few savings events exist.