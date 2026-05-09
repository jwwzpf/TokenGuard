import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { install, uninstall, setMode, allowOnce } from '../lib/installer.js';
import { loadConfig, getPaths } from '../lib/project.js';
import { runHook } from '../lib/hook-handler.js';
import { runDoctor } from '../lib/doctor.js';
import { buildSymbolIndex, findSymbols, smartRead, summarizeFile } from '../lib/precision.js';
import { buildContextForFile, formatContextResult } from '../lib/context-router.js';
import { applyEdit } from '../lib/edit-flow.js';
import { generateReport } from '../lib/report.js';
import { appendEvent } from '../lib/ledger.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-guard-smoke-'));

try {
  fs.writeFileSync(path.join(tmp, 'small.js'), 'console.log("small");\n');
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'large-source.js'), `
export function buildCreaseEnergy(input) {
  const base = input.base || 0;
  const modifier = input.modifier || 1;
  const common = 'common.purchaseFailed';
  return base * modifier;
}

export function unrelatedFunction() {
  return "ignore me";
}

export class PalmAnalyzer {
  analyze() {
    return buildCreaseEnergy({ base: 10, modifier: 2 });
  }
}
`.repeat(500));

  fs.writeFileSync(path.join(tmp, 'README.md'), `# Demo\n\n## Installation\n\nRun install.\n\n## Usage\n\nRun usage.\n`);
  fs.mkdirSync(path.join(tmp, 'build'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'build', 'bundle.js'), 'b'.repeat(300000));
  fs.mkdirSync(path.join(tmp, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'logs', 'test.log'), Array.from({ length: 700 }, (_, i) => i % 7 === 0 ? 'WARNING repeated issue in same format 123' : i === 350 ? 'ERROR expected alpha received beta' : `line ${i}`).join('\n'));
  fs.mkdirSync(path.join(tmp, '.token-guard', 'summaries'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.token-guard', 'summaries', 'legacy.md'), '# legacy\n');
  fs.writeFileSync(path.join(tmp, 'token_guard.py'), 'print("legacy")\n');

  const transcriptPath = path.join(tmp, 'fake-transcript.jsonl');
  const heredoc = "python3 <<'PY'\n" + 'print("hello")\n'.repeat(500) + 'PY';
  fs.writeFileSync(transcriptPath, [
    { type: 'user', message: { role: 'user', content: 'Fix Token Guard handoff generation and run tests.' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'lib/hook-handler.js' } }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'lib/hook-handler.js', old_string: 'old', new_string: 'new' } }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: heredoc } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ERROR expected true received false\n' + 'grep output\n'.repeat(300) }] } }
  ].map(row => JSON.stringify(row)).join('\n'));

  const installed = install(tmp, { claude: true, codex: true });
  assert.equal(installed.config.mode, 'observe');
  assert.ok(fs.existsSync(path.join(tmp, 'TokenGuard', 'config.json')));
  assert.ok(fs.existsSync(path.join(tmp, '.claude', 'settings.local.json')));
  assert.ok(fs.existsSync(path.join(tmp, 'AGENTS.md')));

  const doctor = runDoctor(tmp);
  assert.equal(doctor.failed, 0);

  const config = loadConfig(tmp);
  assert.equal(config.thresholds.narrowReadMaxLines, 200);
  assert.ok(config.signal.enabled);
  assert.ok(config.longInput.enabled);
  assert.ok(config.patterns.alwaysAllow.includes('.token-guard/summaries/'));

  const observeFullRead = runHook('PreToolUse', { cwd: tmp, toolName: 'Read', tool_input: { file_path: 'src/large-source.js' } });
  assert.deepEqual(observeFullRead, {}, 'observe mode must not alter Read');

  const narrowRead = runHook('PreToolUse', { cwd: tmp, toolName: 'Read', tool_input: { file_path: 'src/large-source.js', offset: 8, limit: 10 } });
  assert.deepEqual(narrowRead, {}, 'narrow Read windows must pass');

  const summaryRead = runHook('PreToolUse', { cwd: tmp, toolName: 'Read', tool_input: { file_path: '.token-guard/summaries/legacy.md' } });
  assert.deepEqual(summaryRead, {}, 'legacy summaries must be allowlisted');

  setMode(tmp, 'auto');
  const autoNarrowRead = runHook('PreToolUse', { cwd: tmp, toolName: 'Read', tool_input: { file_path: 'src/large-source.js', offset: 8, limit: 10 } });
  assert.deepEqual(autoNarrowRead, {}, 'auto mode must not block narrow Read');

  setMode(tmp, 'active');
  allowOnce(tmp, './src/large-source.js');
  const forcedRead = runHook('PreToolUse', { cwd: tmp, toolName: 'Read', tool_input: { file_path: 'src/large-source.js' } });
  assert.equal(forcedRead.hookSpecificOutput.permissionDecision, 'allow');

  const index = buildSymbolIndex(tmp, config);
  assert.ok(index.symbols.length > 0);
  const found = findSymbols(tmp, 'buildCreaseEnergy', { config });
  assert.ok(found.length > 0);
  const symbolRead = smartRead(tmp, 'src/large-source.js', { symbol: 'buildCreaseEnergy', maxTokens: 1200 });
  assert.equal(symbolRead.kind, 'symbol');
  assert.ok(symbolRead.text.includes('buildCreaseEnergy'));
  const aroundRead = smartRead(tmp, 'src/large-source.js', { around: 'common.purchaseFailed', context: 3, maxTokens: 1200 });
  assert.equal(aroundRead.kind, 'around');
  assert.ok(aroundRead.text.includes('common.purchaseFailed'));
  const sectionRead = smartRead(tmp, 'README.md', { section: 'Installation', maxTokens: 1200 });
  assert.equal(sectionRead.kind, 'section');
  const ctxRead = buildContextForFile(tmp, 'src/large-source.js', { focus: 'buildCreaseEnergy', maxTokens: 1200 });
  assert.ok(formatContextResult(ctxRead).includes('Token Guard autopilot context'));
  const fileSummary = summarizeFile(tmp, 'src/large-source.js');
  assert.ok(fs.existsSync(fileSummary.summaryPath));

  fs.writeFileSync(path.join(tmp, 'src', 'edit-me.txt'), 'hello old world\n');
  const edit = applyEdit(tmp, 'src/edit-me.txt', { oldString: 'old', newString: 'new' });
  assert.equal(edit.occurrences, 1);
  assert.ok(fs.readFileSync(path.join(tmp, 'src', 'edit-me.txt'), 'utf8').includes('new'));

  const longPrompt = '必须 保证 用户体验。'.repeat(1000) + '\nfile: src/large-source.js\ncommand: npm test\n';
  const digestHook = runHook('UserPromptSubmit', { cwd: tmp, prompt: longPrompt });
  assert.ok(digestHook.hookSpecificOutput.additionalContext.includes('Long Input Digest'));
  const paths = getPaths(tmp);
  assert.ok(fs.existsSync(paths.inputDigest));
  assert.ok(fs.readFileSync(paths.inputDigest, 'utf8').includes('Hard Requirements'));

  const bashTrim = runHook('PostToolUse', { cwd: tmp, toolName: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: fs.readFileSync(path.join(tmp, 'logs', 'test.log'), 'utf8'), stderr: '' } });
  assert.ok(bashTrim.updatedToolOutput.stdout.includes('Token Guard: trimmed'));

  const stopResult = runHook('Stop', { cwd: tmp, hook_event_name: 'Stop', transcript_path: transcriptPath, stop_hook_active: false });
  assert.deepEqual(stopResult, {});
  const handoff = fs.readFileSync(paths.handoff, 'utf8');
  assert.ok(handoff.length < 16000, 'handoff should be compressed');
  assert.ok(handoff.includes('heredoc/script body omitted'));

  appendEvent(tmp, { type: 'read_guard_block', file: 'build/bundle.js', estimatedTokens: 75000, reason: 'generated file', repeatDiscount: 0.12 });
  appendEvent(tmp, { type: 'read_guard_block', file: 'build/bundle.js', estimatedTokens: 75000, reason: 'generated file', repeatDiscount: 0.12 });
  appendEvent(tmp, { type: 'fallback_tool_use', command: 'sed -n 1,100p build/bundle.js', estimatedCost: 450 });
  appendEvent(tmp, { type: 'command_cache_hit', command: 'git status', savedTokens: 900 });
  const report = generateReport(tmp);
  assert.ok(fs.existsSync(report.html));
  assert.ok(fs.existsSync(report.svg));
  assert.ok(fs.readFileSync(report.html, 'utf8').includes('tokens protected'));

  const uninstallResult = uninstall(tmp);
  assert.ok(uninstallResult.removed.length > 0);
  assert.equal(fs.existsSync(path.join(tmp, 'TokenGuard')), false);
  assert.equal(fs.existsSync(path.join(tmp, '.token-guard')), false);
  assert.equal(fs.existsSync(path.join(tmp, 'token_guard.py')), false);

  console.log('Token Guard v0.3.6 final bundle smoke test passed.');
  console.log(tmp);
} finally {
  // Keep temp folder for manual inspection.
}
