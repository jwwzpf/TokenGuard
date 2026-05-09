import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { install, uninstall, setMode, allowOnce } from '../lib/installer.js';
import { loadConfig, getPaths } from '../lib/project.js';
import { runHook } from '../lib/hook-handler.js';
import { runDoctor } from '../lib/doctor.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-guard-smoke-'));

try {
  fs.writeFileSync(path.join(tmp, 'small.js'), 'console.log("small");\n');

  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });

  fs.writeFileSync(
    path.join(tmp, 'src', 'large-source.js'),
    `
export function buildCreaseEnergy(input) {
  const base = input.base || 0;
  const modifier = input.modifier || 1;
  return base * modifier;
}
`.repeat(500)
  );

  fs.mkdirSync(path.join(tmp, 'TokenGuard', 'summaries'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'TokenGuard', 'summaries', 'summary.md'), '# summary\n');

  fs.mkdirSync(path.join(tmp, '.token-guard', 'summaries'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.token-guard', 'summaries', 'legacy.md'), '# legacy summary\n');

  fs.writeFileSync(path.join(tmp, 'token_guard.py'), 'print("legacy")\n');

  const installed = install(tmp, {
    mode: undefined,
    claude: true,
    codex: true
  });

  assert.equal(installed.config.mode, 'observe');

  const config = loadConfig(tmp);
  assert.equal(config.thresholds.narrowReadMaxLines, 200);
  assert.ok(config.patterns.alwaysAllow.includes('.token-guard/summaries/'));

  const doctor = runDoctor(tmp);
  assert.equal(doctor.failed, 0);

  const observeFullRead = runHook('PreToolUse', {
    cwd: tmp,
    toolName: 'Read',
    tool_input: {
      file_path: 'src/large-source.js'
    }
  });

  assert.deepEqual(
    observeFullRead,
    {},
    'observe mode must never return PreToolUse output for Read'
  );

  const narrowRead = runHook('PreToolUse', {
    cwd: tmp,
    toolName: 'Read',
    tool_input: {
      file_path: 'src/large-source.js',
      offset: 8,
      limit: 10
    }
  });

  assert.deepEqual(
    narrowRead,
    {},
    'narrow Read windows must always pass'
  );

  setMode(tmp, 'auto');

  const autoNarrowRead = runHook('PreToolUse', {
    cwd: tmp,
    toolName: 'Read',
    tool_input: {
      file_path: 'src/large-source.js',
      offset: 8,
      limit: 10
    }
  });

  assert.deepEqual(
    autoNarrowRead,
    {},
    'auto mode must not block narrow Read windows'
  );

  const summaryRead = runHook('PreToolUse', {
    cwd: tmp,
    toolName: 'Read',
    tool_input: {
      file_path: '.token-guard/summaries/legacy.md'
    }
  });

  assert.deepEqual(
    summaryRead,
    {},
    'legacy .token-guard summaries must be allowlisted'
  );

  setMode(tmp, 'active');

  allowOnce(tmp, './src/large-source.js');

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
    'force-read should allow one full read despite path variant'
  );

  allowOnce(tmp, 'src/large-source.js');

  const forcedReadAbsolute = runHook('PreToolUse', {
    cwd: tmp,
    toolName: 'Read',
    tool_input: {
      file_path: path.join(tmp, 'src', 'large-source.js')
    }
  });

  assert.equal(
    forcedReadAbsolute.hookSpecificOutput.permissionDecision,
    'allow',
    'force-read should allow absolute path variant'
  );

  const uninstallResult = uninstall(tmp);

  assert.ok(uninstallResult.removed.length > 0);
  assert.equal(fs.existsSync(path.join(tmp, 'TokenGuard')), false);
  assert.equal(fs.existsSync(path.join(tmp, '.token-guard')), false);
  assert.equal(fs.existsSync(path.join(tmp, 'token_guard.py')), false);
  assert.equal(fs.existsSync(path.join(tmp, 'CLAUDE.local.md')), false);

  if (fs.existsSync(path.join(tmp, 'AGENTS.md'))) {
    assert.equal(fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8').includes('TOKEN_GUARD_START'), false);
  }

  console.log('Token Guard friction/uninstall smoke test passed.');
  console.log(tmp);
} finally {
  // Keep temp folder for manual inspection when needed.
}
