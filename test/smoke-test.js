import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { install, setMode, allowOnce } from '../lib/installer.js';
import { loadConfig } from '../lib/project.js';
import { runHook } from '../lib/hook-handler.js';
import { appendEvent } from '../lib/ledger.js';
import { generateReport } from '../lib/report.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-guard-smoke-'));

try {
  fs.writeFileSync(path.join(tmp, 'small.js'), 'console.log("small");\n');

  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'large-source.js'), 'a'.repeat(120000));

  fs.mkdirSync(path.join(tmp, 'build'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'build', 'bundle.js'), 'b'.repeat(300000));

  fs.mkdirSync(path.join(tmp, 'logs'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'logs', 'test.log'),
    Array.from({ length: 600 }, (_, i) =>
      i === 300 ? 'ERROR expected 1 received 2' : `line ${i}`
    ).join('\n')
  );

  const installed = install(tmp, {
    mode: undefined,
    claude: true,
    codex: true
  });

  assert.equal(installed.config.mode, 'observe');
  assert.ok(fs.existsSync(path.join(tmp, 'TokenGuard', 'config.json')));
  assert.ok(fs.existsSync(path.join(tmp, '.claude', 'settings.local.json')));
  assert.ok(fs.existsSync(path.join(tmp, 'AGENTS.md')));

  const config = loadConfig(tmp);

  assert.equal(config.thresholds.softTokens, 25000);
  assert.equal(config.mode, 'observe');

  const selfRead = runHook('PreToolUse', {
    cwd: tmp,
    toolName: 'Read',
    tool_input: {
      file_path: 'TokenGuard/sessions/handoff.md'
    }
  });

  assert.deepEqual(selfRead, {});

  const observeRead = runHook('PreToolUse', {
    cwd: tmp,
    toolName: 'Read',
    tool_input: {
      file_path: 'src/large-source.js'
    }
  });

  assert.ok(
    observeRead.hookSpecificOutput.additionalContext.includes('observe mode'),
    'observe mode should provide context'
  );

  assert.equal(
    observeRead.hookSpecificOutput.permissionDecision,
    undefined,
    'observe mode must not return permissionDecision=allow because that bypasses normal Claude permissions'
  );

  setMode(tmp, 'active');

  const activeLargeSource = runHook('PreToolUse', {
    cwd: tmp,
    toolName: 'Read',
    tool_input: {
      file_path: 'src/large-source.js'
    }
  });

  assert.equal(
    activeLargeSource.hookSpecificOutput.permissionDecision,
    'ask',
    'active mode should ask, not hard-deny 25K-60K business source files'
  );

  const activeGenerated = runHook('PreToolUse', {
    cwd: tmp,
    toolName: 'Read',
    tool_input: {
      file_path: 'build/bundle.js'
    }
  });

  assert.equal(
    activeGenerated.hookSpecificOutput.permissionDecision,
    'deny',
    'active mode should deny huge generated/build files'
  );

  allowOnce(tmp, 'src/large-source.js');

  const forcedRead = runHook('PreToolUse', {
    cwd: tmp,
    toolName: 'Read',
    tool_input: {
      file_path: 'src/large-source.js'
    }
  });

  assert.equal(
    forcedRead.hookSpecificOutput.permissionDecision,
    'allow',
    'force-read should allow one full read'
  );

  const reminder1 = runHook('UserPromptSubmit', {
    cwd: tmp,
    prompt: 'continue'
  });

  const reminder2 = runHook('UserPromptSubmit', {
    cwd: tmp,
    prompt: 'continue again'
  });

  assert.ok(reminder1.hookSpecificOutput.additionalContext);
  assert.deepEqual(reminder2, {}, 'unchanged reminder should be deduped');

  const lines = Array.from({ length: 700 }, (_, i) =>
    i === 350 ? 'ERROR expected alpha received beta' : `line ${i}`
  ).join('\n');

  const bashTrim = runHook('PostToolUse', {
    cwd: tmp,
    toolName: 'Bash',
    tool_input: {
      command: 'npm test'
    },
    tool_response: {
      stdout: lines,
      stderr: ''
    }
  });

  assert.ok(
    bashTrim.additionalContext.includes('trimmed noisy Bash output'),
    'bash output should be trimmed'
  );

  assert.ok(
    bashTrim.updatedToolOutput.stdout.includes('Token Guard: trimmed'),
    'PostToolUse should provide top-level updatedToolOutput'
  );

  appendEvent(tmp, {
    type: 'read_guard_block',
    file: 'build/bundle.js',
    estimatedTokens: 75000,
    reason: 'generated file',
    repeatDiscount: 0.12
  });

  appendEvent(tmp, {
    type: 'read_guard_block',
    file: 'build/bundle.js',
    estimatedTokens: 75000,
    reason: 'generated file',
    repeatDiscount: 0.12
  });

  appendEvent(tmp, {
    type: 'fallback_tool_use',
    command: 'sed -n 1,100p build/bundle.js',
    estimatedCost: 450
  });

  const report = generateReport(tmp);

  assert.ok(fs.existsSync(report.html));
  assert.ok(fs.existsSync(report.svg));
  assert.ok(report.model.grossAvoidedTokens > 0);
  assert.ok(report.model.netSavingsTokens > 0);
  assert.ok(report.model.repeatedBlocks >= 1);
  assert.ok(report.model.fallbackToolCalls >= 1);

  console.log('Token Guard smoke test passed.');
  console.log(tmp);
} finally {
  // Keep temp folder for manual inspection when needed.
}
