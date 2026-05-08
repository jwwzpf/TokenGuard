import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { install, setMode, allowOnce } from '../lib/installer.js';
import { loadConfig, getPaths } from '../lib/project.js';
import { runHook } from '../lib/hook-handler.js';
import { appendEvent } from '../lib/ledger.js';
import { generateReport } from '../lib/report.js';
import { runDoctor } from '../lib/doctor.js';
import {
  buildSymbolIndex,
  findSymbols,
  smartRead,
  summarizeFile
} from '../lib/precision.js';
import {
  buildContextForFile,
  formatContextResult
} from '../lib/context-router.js';

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

export function unrelatedFunction() {
  return "ignore me";
}

export class PalmAnalyzer {
  analyze() {
    return buildCreaseEnergy({ base: 10, modifier: 2 });
  }
}
`.repeat(500)
  );

  fs.writeFileSync(
    path.join(tmp, 'README.md'),
    `# Demo

## Installation

Run install.

## Usage

Run usage.
`
  );

  fs.mkdirSync(path.join(tmp, 'build'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'build', 'bundle.js'), 'b'.repeat(300000));

  fs.mkdirSync(path.join(tmp, 'logs'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'logs', 'test.log'),
    Array.from({ length: 600 }, (_, i) =>
      i === 300 ? 'ERROR expected 1 received 2' : `line ${i}`
    ).join('\n')
  );

  const transcriptPath = path.join(tmp, 'fake-transcript.jsonl');

  fs.writeFileSync(
    transcriptPath,
    [
      {
        type: 'user',
        message: {
          role: 'user',
          content: 'Fix Token Guard handoff generation and run tests.'
        }
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Read',
              input: {
                file_path: 'lib/hook-handler.js'
              }
            }
          ]
        }
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Edit',
              input: {
                file_path: 'lib/hook-handler.js',
                old_string: 'old',
                new_string: 'new'
              }
            }
          ]
        }
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: {
                command: 'npm test'
              }
            }
          ]
        }
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              content: 'ERROR expected true received false'
            }
          ]
        }
      }
    ]
      .map(row => JSON.stringify(row))
      .join('\n')
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

  const doctor = runDoctor(tmp);

  assert.equal(doctor.ok, true, 'doctor should pass after install');
  assert.equal(doctor.failed, 0, 'doctor should have no failed checks');

  const config = loadConfig(tmp);

  assert.equal(config.thresholds.softTokens, 25000);
  assert.equal(config.thresholds.precisionReadMaxTokens, 6000);
  assert.equal(config.mode, 'observe');

  const index = buildSymbolIndex(tmp, config);

  assert.ok(index.symbols.length > 0, 'symbol index should detect symbols');

  const found = findSymbols(tmp, 'buildCreaseEnergy', {
    config
  });

  assert.ok(found.length > 0, 'find should locate buildCreaseEnergy');
  assert.ok(found[0].file.includes('large-source.js'));

  const symbolRead = smartRead(tmp, 'src/large-source.js', {
    symbol: 'buildCreaseEnergy',
    maxTokens: 1200
  });

  assert.equal(symbolRead.kind, 'symbol');
  assert.ok(symbolRead.text.includes('buildCreaseEnergy'));
  assert.ok(symbolRead.returnedTokens < symbolRead.originalTokens);

  const ctxRead = buildContextForFile(tmp, 'src/large-source.js', {
    focus: 'buildCreaseEnergy',
    maxTokens: 1200
  });

  assert.ok(ctxRead.text.includes('buildCreaseEnergy'));
  assert.ok(ctxRead.returnedTokens < ctxRead.originalTokens);

  const ctxFormatted = formatContextResult(ctxRead);

  assert.ok(ctxFormatted.includes('Language policy'));
  assert.ok(ctxFormatted.includes('tg ctx'));

  const lineRead = smartRead(tmp, 'src/large-source.js', {
    lines: '1:8',
    maxTokens: 1200
  });

  assert.equal(lineRead.kind, 'lines');
  assert.ok(lineRead.text.includes('buildCreaseEnergy'));

  const sectionRead = smartRead(tmp, 'README.md', {
    section: 'Installation',
    maxTokens: 1200
  });

  assert.equal(sectionRead.kind, 'section');
  assert.ok(sectionRead.text.includes('Run install'));

  const fileSummary = summarizeFile(tmp, 'src/large-source.js');

  assert.ok(fs.existsSync(fileSummary.summaryPath));
  assert.ok(fileSummary.symbols > 0);

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

  assert.ok(
    observeRead.hookSpecificOutput.additionalContext.includes('Language policy'),
    'agent-facing notices should include language policy'
  );

  assert.equal(
    observeRead.hookSpecificOutput.permissionDecision,
    undefined,
    'observe mode must not return permissionDecision=allow because that bypasses normal Claude permissions'
  );

  setMode(tmp, 'auto');

  const autoLargeSource = runHook('PreToolUse', {
    cwd: tmp,
    toolName: 'Read',
    tool_input: {
      file_path: 'src/large-source.js'
    }
  });

  assert.equal(
    autoLargeSource.hookSpecificOutput.permissionDecision,
    'deny',
    'auto mode should replace expensive full reads with autopilot context'
  );

  assert.ok(
    autoLargeSource.hookSpecificOutput.additionalContext.includes('Token Guard autopilot context'),
    'auto mode should inject lightweight context'
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

  const stopResult = runHook('Stop', {
    cwd: tmp,
    hook_event_name: 'Stop',
    transcript_path: transcriptPath,
    stop_hook_active: false
  });

  assert.deepEqual(stopResult, {});

  const paths = getPaths(tmp);
  const handoff = fs.readFileSync(paths.handoff, 'utf8');

  assert.ok(handoff.includes('Fix Token Guard handoff generation'));
  assert.ok(handoff.includes('lib/hook-handler.js'));
  assert.ok(handoff.includes('npm test'));
  assert.ok(handoff.includes('ERROR expected true received false'));

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
  assert.ok(report.model.handoffsGenerated >= 1);

  console.log('Token Guard smoke test passed.');
  console.log(tmp);
} finally {
  // Keep temp folder for manual inspection when needed.
}
