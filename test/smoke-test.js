import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { install, upgrade, uninstall, allowOnce } from '../lib/installer.js';
import { loadConfig, getPaths } from '../lib/project.js';
import { runHook } from '../lib/hook-handler.js';
import { runDoctor } from '../lib/doctor.js';
import { buildInputDigest } from '../lib/input-digest.js';
import { updateHandoffFromTranscript } from '../lib/handoff.js';
import { generateReport } from '../lib/report.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-guard-v040-'));

try {
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'large-source.js'), 'export function alpha(){return 1;}\n'.repeat(5000));
  fs.mkdirSync(path.join(tmp, 'build'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'build', 'bundle.js'), 'x'.repeat(350000));

  const installed = install(tmp, { claude: true, codex: true });
  assert.equal(installed.config.policy.strategy, 'smart');
  assert.equal(installed.config.mode, 'smart');

  const doctor = runDoctor(tmp);
  assert.equal(doctor.failed, 0);

  const upgraded = upgrade(tmp, { claude: true, codex: true });
  assert.equal(upgraded.upgraded, true);
  assert.equal(upgraded.preservedData, true);
  assert.equal(fs.existsSync(path.join(tmp, 'TokenGuard', 'config.json')), true);
  assert.ok(fs.readFileSync(path.join(tmp, 'CLAUDE.local.md'), 'utf8').includes('TOKEN_GUARD_START'));
  assert.ok(fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8').includes('TOKEN_GUARD_START'));

  const config = loadConfig(tmp);
  assert.equal(config.thresholds.narrowReadMaxLines, 200);
  assert.ok(config.patterns.alwaysAllow.includes('TokenGuard/summaries/'));
  assert.equal(config.patterns.alwaysAllow.some(x => x.startsWith('.token-guard/')), false);

  const narrowRead = runHook('PreToolUse', {
    cwd: tmp,
    toolName: 'Read',
    tool_input: { file_path: 'src/large-source.js', offset: 8, limit: 10 }
  });
  assert.deepEqual(narrowRead, {}, 'narrow reads must pass');

  const normalLargeSource = runHook('PreToolUse', {
    cwd: tmp,
    toolName: 'Read',
    tool_input: { file_path: 'src/large-source.js' }
  });
  assert.deepEqual(normalLargeSource, {}, 'ordinary source files should not be blocked just because they are large');

  const generatedRead = runHook('PreToolUse', {
    cwd: tmp,
    toolName: 'Read',
    tool_input: { file_path: 'build/bundle.js' }
  });
  assert.equal(generatedRead.hookSpecificOutput.permissionDecision, 'deny', 'generated/build full dumps should be replaced');

  allowOnce(tmp, './src/large-source.js');
  const forcedRead = runHook('PreToolUse', {
    cwd: tmp,
    toolName: 'Read',
    tool_input: { file_path: 'src/large-source.js' }
  });
  assert.equal(forcedRead.hookSpecificOutput.permissionDecision, 'allow');

  const longPrompt = `${'请你评估这个计划。是不是应该删除 observe mode？如何保证用户体验？多少 token 可以节省？\n'.repeat(120)}
必须：用户只需要 token-guard install。不要上传代码。保留 Balanced Signal Mode。`;
  const digest = buildInputDigest(longPrompt);
  assert.ok(digest.content.includes('Open Questions'));
  assert.ok(digest.openQuestions.length >= 3, 'Chinese open questions should be detected');

  const digestHook = runHook('UserPromptSubmit', { cwd: tmp, prompt: longPrompt });
  assert.ok(digestHook.hookSpecificOutput.additionalContext.includes('input-digest.md'));
  assert.ok(fs.readFileSync(path.join(tmp, 'TokenGuard', 'sessions', 'input-digest.md'), 'utf8').includes('Hard Requirements'));

  const digestRepeat = runHook('UserPromptSubmit', { cwd: tmp, prompt: longPrompt });
  assert.deepEqual(digestRepeat, {}, 'identical long prompt should skip digest rewrite and notice');

  const noDigestHook = runHook('UserPromptSubmit', { cwd: tmp, prompt: 'short message' });
  assert.deepEqual(noDigestHook, {}, 'short prompts should not trigger repeated static rule injection');

  runHook('SessionStart', { cwd: tmp });
  let webResult = {};
  for (let i = 0; i < 7; i += 1) {
    webResult = runHook('PreToolUse', { cwd: tmp, toolName: 'WebSearch', tool_input: { query: `q${i}` } });
  }
  assert.equal(webResult.hookSpecificOutput?.permissionDecision, 'deny', 'web budget should block once exceeded');

  const longRoutingPrompt = `${'我要重构这个 service，但同时也要做一些小事，比如 rename 几个变量，写几行注释，然后跑测试。'.repeat(20)}`;
  const routingNotice = runHook('UserPromptSubmit', { cwd: tmp, prompt: longRoutingPrompt });
  assert.ok(routingNotice.hookSpecificOutput?.additionalContext?.includes('model routing'), 'model routing hint should be injected for long prompts');

  const subagentPost = runHook('PostToolUse', {
    cwd: tmp,
    toolName: 'Agent',
    tool_input: { subagent_type: 'general-purpose', model: 'haiku', prompt: 'find all usages of foo' },
    tool_response: { content: 'found 3 usages: file1.js, file2.js, file3.js' }
  });
  assert.ok(subagentPost.hookSpecificOutput?.additionalContext?.includes('opus-equivalent'), 'subagent post hook should report opus-equivalent savings');

  const subagentOpus = runHook('PostToolUse', {
    cwd: tmp,
    toolName: 'Agent',
    tool_input: { subagent_type: 'general-purpose', model: 'opus', prompt: 'reason hard' },
    tool_response: { content: 'long reasoning result' }
  });
  assert.deepEqual(subagentOpus, {}, 'subagent running on opus should record zero savings');

  const transcriptPath = path.join(tmp, 'transcript.jsonl');
  const records = [
    { message: { role: 'user', content: 'review codebase for conversion and launch readiness' } },
    { message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/large-source.js', offset: 1, limit: 120 } }] } },
    { message: { role: 'user', content: [{ type: 'tool_result', content: '1: const configLoader = require(\'./configLoader\');\n2: throw new Error(\'normal source code\');' }] } },
    { message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { message: { role: 'user', content: [{ type: 'tool_result', content: 'Error: expected true received false\nexit code 1' }] } }
  ];
  fs.writeFileSync(transcriptPath, records.map(x => JSON.stringify(x)).join('\n'));
  const h = updateHandoffFromTranscript(tmp, { transcript_path: transcriptPath }, { source: 'test' });
  assert.equal(h.updated, true);
  const handoff = fs.readFileSync(path.join(tmp, 'TokenGuard', 'sessions', 'handoff.md'), 'utf8');
  assert.ok(handoff.includes('review codebase for conversion and launch readiness'));
  assert.equal(handoff.includes('const configLoader'), false, 'grep/file dump should not become goal');
  assert.equal(handoff.includes('normal source code'), false, 'source-code throw should not be failure signal');
  assert.ok(handoff.includes('expected true received false'));

  const bashTrim = runHook('PostToolUse', {
    cwd: tmp,
    toolName: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { stdout: Array.from({ length: 700 }, (_, i) => i === 350 ? 'Error: expected alpha received beta' : `line ${i}`).join('\n'), stderr: '' }
  });
  assert.ok(bashTrim.updatedToolOutput.stdout.includes('Token Guard: trimmed'));

  const report = generateReport(tmp);
  assert.ok(fs.existsSync(report.html));
  assert.ok(fs.existsSync(report.svg));
  assert.ok('tokenGuardOverheadTokens' in report.model);

  const uninstallResult = uninstall(tmp);
  assert.ok(uninstallResult.removed.length > 0);
  assert.equal(fs.existsSync(path.join(tmp, 'TokenGuard')), false);
  console.log('Token Guard v0.4.1 smoke test passed.');
  console.log(tmp);
} finally {
  // Keep temp folder for inspection.
}
