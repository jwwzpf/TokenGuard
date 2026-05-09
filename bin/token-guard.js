#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { install, uninstall, setEnabled, setMode, allowOnce } from '../lib/installer.js';
import { ensureProjectFiles, getPaths, loadConfig } from '../lib/project.js';
import { handleHook } from '../lib/hook-handler.js';
import { generateReport, openReport, openFolder } from '../lib/report.js';
import { scanProject } from '../lib/token-utils.js';
import { runDoctor, formatDoctor } from '../lib/doctor.js';
import {
  buildSymbolIndex,
  findSymbols,
  smartRead,
  summarizeFile,
  formatSmartReadResult,
  formatFindResults
} from '../lib/precision.js';
import {
  buildContextForFile,
  formatContextResult
} from '../lib/context-router.js';

const [, , cmd, ...args] = process.argv;

async function main() {
  const projectRoot = process.cwd();

  try {
    switch (cmd) {
      case 'install':
        return cmdInstall(projectRoot, args);
      case 'uninstall':
        return cmdUninstall(projectRoot, args);
      case 'enable':
        return cmdEnable(projectRoot);
      case 'disable':
        return cmdDisable(projectRoot);
      case 'mode':
        return cmdMode(projectRoot, args[0]);
      case 'status':
        return cmdStatus(projectRoot);
      case 'doctor':
        return cmdDoctor(projectRoot);
      case 'estimate':
        return cmdEstimate(projectRoot);
      case 'ctx':
      case 'context':
        return cmdContext(projectRoot, args);
      case 'index':
        return cmdIndex(projectRoot);
      case 'find':
        return cmdFind(projectRoot, args);
      case 'read':
        return cmdRead(projectRoot, args);
      case 'summarize':
        return cmdSummarize(projectRoot, args);
      case 'report':
        return cmdReport(projectRoot);
      case 'open-report':
        return cmdOpenReport(projectRoot);
      case 'open-folder':
        return cmdOpenFolder(projectRoot);
      case 'allow':
        return cmdAllow(projectRoot, args);
      case 'hook':
        return handleHook(args[0]);
      case 'help':
      case undefined:
      case '-h':
      case '--help':
        return printHelp();
      default:
        console.error(`Unknown command: ${cmd}\n`);
        printHelp();
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Token Guard error: ${err.message}`);
    process.exitCode = 1;
  }
}

function cmdInstall(projectRoot, args) {
  const observe = args.includes('--observe');
  const auto = args.includes('--auto');
  const active = args.includes('--active');
  const noClaude = args.includes('--no-claude');
  const noCodex = args.includes('--no-codex');

  const mode = auto ? 'auto' : active ? 'active' : observe ? 'observe' : undefined;
  const { paths, config } = install(projectRoot, {
    mode,
    claude: !noClaude,
    codex: !noCodex
  });

  console.log(`Token Guard installed in ${projectRoot}`);
  console.log(`Mode: ${config.mode}`);
  console.log(`Local folder: ${path.relative(projectRoot, paths.base)}/`);

  if (!noClaude) {
    console.log(`Claude Code hooks: enabled in ${path.relative(projectRoot, paths.claudeSettingsLocal)}`);
  }

  if (!noCodex) {
    console.log(`Codex desktop instructions: enabled in ${path.relative(projectRoot, paths.agents)}`);
  }

  console.log(`Reports: ${path.relative(projectRoot, paths.reports)}/`);
  console.log('Default mode is observe. Token Guard will not block reads unless you switch to auto/active/strict.');
  console.log('Run `token-guard doctor` to verify the installation.');
  console.log('Run `token-guard report` anytime to generate your Savings Report.');
}

function cmdUninstall(projectRoot, args) {
  const keepData = args.includes('--keep-data');
  const { removed } = uninstall(projectRoot, { keepData });

  console.log(keepData
    ? 'Token Guard hooks/instructions disabled. Local data kept.'
    : 'Token Guard fully uninstalled from this project.');

  if (removed?.length) {
    console.log('');
    console.log('Removed/cleaned:');

    for (const item of removed) {
      console.log(`- ${item}`);
    }
  } else {
    console.log('No Token Guard files or hooks were found.');
  }

  if (!keepData) {
    console.log('');
    console.log('Project cleanup complete. You can reinstall with:');
    console.log('  token-guard install --observe');
  }
}

function cmdEnable(projectRoot) {
  const config = setEnabled(projectRoot, true);
  console.log(`Token Guard enabled. Mode: ${config.mode}`);
}

function cmdDisable(projectRoot) {
  setEnabled(projectRoot, false);
  console.log('Token Guard disabled. Hooks may still fire, but they will exit without doing work.');
}

function cmdMode(projectRoot, mode) {
  if (!mode) {
    const config = loadConfig(projectRoot);
    console.log(`Current mode: ${config.mode}`);
    return;
  }

  const config = setMode(projectRoot, mode);
  console.log(`Token Guard mode set to ${config.mode}.`);
}

function cmdAllow(projectRoot, args) {
  const file = args.filter(arg => !arg.startsWith('--')).at(-1) || '*';
  const config = allowOnce(projectRoot, file);

  console.log(`Token Guard will allow one full read for: ${file}`);
  console.log(`Remaining one-time force-read entries: ${(config.forceRead?.once || []).join(', ') || '(none)'}`);
}

function cmdStatus(projectRoot) {
  ensureProjectFiles(projectRoot);

  const paths = getPaths(projectRoot);
  const config = loadConfig(projectRoot);

  console.log('Token Guard status');
  console.log('');
  console.log(`Project: ${projectRoot}`);
  console.log(`Enabled: ${config.enabled}`);
  console.log(`Mode: ${config.mode}`);
  console.log(`Soft threshold: ${config.thresholds.softTokens.toLocaleString('en-US')} tokens`);
  console.log(`Hard threshold: ${config.thresholds.hardTokens.toLocaleString('en-US')} tokens`);
  console.log(`Narrow Read max: ${config.thresholds.narrowReadMaxLines.toLocaleString('en-US')} lines`);
  console.log(`Precision read max: ${config.thresholds.precisionReadMaxTokens.toLocaleString('en-US')} tokens`);
  console.log(`Local folder: ${path.relative(projectRoot, paths.base)}/`);
  console.log(`Claude settings: ${fs.existsSync(paths.claudeSettingsLocal) ? 'present' : 'not found'}`);
  console.log(`AGENTS.md: ${fs.existsSync(paths.agents) ? 'present' : 'not found'}`);
  console.log(`Symbol index: ${fs.existsSync(paths.symbolsJson) ? 'present' : 'not found'}`);
  console.log('Background daemon: not running. Token Guard only runs when hooks/instructions trigger it.');
}

function cmdDoctor(projectRoot) {
  const result = runDoctor(projectRoot);

  console.log(formatDoctor(result));

  if (!result.ok) {
    process.exitCode = 1;
  }
}

function cmdEstimate(projectRoot) {
  ensureProjectFiles(projectRoot);

  const config = loadConfig(projectRoot);
  const scan = scanProject(projectRoot, config);

  console.log(`Estimated project context: ${scan.totalTokens.toLocaleString('en-US')} tokens across ${scan.scannedFiles} files.`);
  console.log('Top token-heavy files:');

  for (const row of scan.files.slice(0, 12)) {
    console.log(`- ${row.tokens.toLocaleString('en-US')} tokens · ${row.path}`);
  }
}

function cmdContext(projectRoot, args) {
  ensureProjectFiles(projectRoot);

  const file = args.find(arg => !arg.startsWith('--') && !arg.includes(':'));

  if (!file) {
    console.error('Usage: token-guard ctx <file> [--focus NAME] [--lines A:B] [--max-tokens N]');
    process.exitCode = 1;
    return;
  }

  const options = parseOptions(args);
  const config = loadConfig(projectRoot);

  const result = buildContextForFile(projectRoot, file, {
    ...options,
    config,
    maxTokens: options.maxTokens || config.thresholds?.precisionReadMaxTokens
  });

  console.log(formatContextResult(result, {
    includeLanguagePolicy: false
  }));
}

function cmdIndex(projectRoot) {
  ensureProjectFiles(projectRoot);

  const config = loadConfig(projectRoot);
  const index = buildSymbolIndex(projectRoot, config);
  const paths = getPaths(projectRoot);

  console.log('Token Guard symbol index generated.');
  console.log(`Files indexed: ${index.files.length.toLocaleString('en-US')}`);
  console.log(`Symbols found: ${index.symbols.length.toLocaleString('en-US')}`);
  console.log(`Index: ${path.relative(projectRoot, paths.symbolsJson)}`);
}

function cmdFind(projectRoot, args) {
  ensureProjectFiles(projectRoot);

  const query = args.find(arg => !arg.startsWith('--'));

  if (!query) {
    console.error('Usage: token-guard find <symbol-or-query>');
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(projectRoot);
  const results = findSymbols(projectRoot, query, {
    config,
    rebuild: args.includes('--rebuild')
  });

  console.log(formatFindResults(results));
}

function cmdRead(projectRoot, args) {
  ensureProjectFiles(projectRoot);

  const file = args.find(arg => !arg.startsWith('--') && !arg.includes(':'));

  if (!file) {
    console.error('Usage: token-guard read <file> [--symbol NAME] [--section NAME] [--lines A:B] [--max-tokens N]');
    process.exitCode = 1;
    return;
  }

  const options = parseOptions(args);
  const config = loadConfig(projectRoot);

  const result = smartRead(projectRoot, file, {
    ...options,
    maxTokens: options.maxTokens || config.thresholds?.precisionReadMaxTokens,
    contextLines: options.contextLines || config.thresholds?.symbolContextLines
  });

  console.log(formatSmartReadResult(result));
}

function cmdSummarize(projectRoot, args) {
  ensureProjectFiles(projectRoot);

  const file = args.find(arg => !arg.startsWith('--'));

  if (!file) {
    console.error('Usage: token-guard summarize <file>');
    process.exitCode = 1;
    return;
  }

  const result = summarizeFile(projectRoot, file);

  console.log('Token Guard summary generated.');
  console.log(`File: ${result.file}`);
  console.log(`Tokens: ${result.tokens.toLocaleString('en-US')}`);
  console.log(`Symbols: ${result.symbols.toLocaleString('en-US')}`);
  console.log(`Sections: ${result.sections.toLocaleString('en-US')}`);
  console.log(`Summary: ${path.relative(projectRoot, result.summaryPath)}`);
}

function cmdReport(projectRoot) {
  const { html, svg, model } = generateReport(projectRoot);

  console.log('Generated Savings Report:');
  console.log(`- ${html}`);
  console.log(`- ${svg}`);
  console.log(`Gross avoided context: ${Math.round(model.grossAvoidedTokens).toLocaleString('en-US')} tokens`);
  console.log(`Estimated net savings: ${Math.round(model.netSavingsTokens).toLocaleString('en-US')} tokens`);
}

function cmdOpenReport(projectRoot) {
  openReport(projectRoot);
  console.log('Opening latest Savings Report...');
}

function cmdOpenFolder(projectRoot) {
  ensureProjectFiles(projectRoot);
  openFolder(projectRoot);
  console.log('Opening TokenGuard folder...');
}

function parseOptions(args) {
  const options = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--focus') {
      options.focus = args[i + 1];
      options.symbol = args[i + 1];
      options.section = args[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--focus=')) {
      const value = arg.slice('--focus='.length);
      options.focus = value;
      options.symbol = value;
      options.section = value;
      continue;
    }

    if (arg === '--symbol') {
      options.symbol = args[i + 1];
      options.focus = args[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--symbol=')) {
      const value = arg.slice('--symbol='.length);
      options.symbol = value;
      options.focus = value;
      continue;
    }

    if (arg === '--section') {
      options.section = args[i + 1];
      options.focus = args[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--section=')) {
      const value = arg.slice('--section='.length);
      options.section = value;
      options.focus = value;
      continue;
    }

    if (arg === '--lines') {
      options.lines = args[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--lines=')) {
      options.lines = arg.slice('--lines='.length);
      continue;
    }

    if (arg === '--max-tokens') {
      options.maxTokens = Number(args[i + 1]);
      i += 1;
      continue;
    }

    if (arg.startsWith('--max-tokens=')) {
      options.maxTokens = Number(arg.slice('--max-tokens='.length));
      continue;
    }

    if (arg === '--context-lines') {
      options.contextLines = Number(args[i + 1]);
      i += 1;
      continue;
    }

    if (arg.startsWith('--context-lines=')) {
      options.contextLines = Number(arg.slice('--context-lines='.length));
    }
  }

  return options;
}

function printHelp() {
  console.log(`Token Guard

Stop feeding your whole repo to AI.

Usage:
  token-guard install [--observe|--auto|--active] [--no-claude] [--no-codex]
  token-guard doctor
  token-guard status
  token-guard enable
  token-guard disable
  token-guard mode observe|auto|active|edit|strict

Main agent-facing context command:
  tg ctx <file>
  tg ctx <file> --focus <symbol-or-topic>
  tg ctx <file> --lines A:B

Advanced context tools:
  token-guard index
  token-guard find <symbol-or-query>
  token-guard read <file> [--symbol NAME] [--section NAME] [--lines A:B]
  token-guard summarize <file>

Reports:
  token-guard estimate
  token-guard report
  token-guard open-report
  token-guard open-folder

Escape hatch:
  token-guard allow <file> --once
  token-guard allow --once <file>
  or write @tg:force-read <file> in your next prompt.

Uninstall:
  token-guard uninstall
  token-guard uninstall --keep-data

Default mode is observe:
  Token Guard records waste, keeps handoff memory, and trims noisy Bash output.
  It does not block Read calls.

Trust model:
  Local-first. No daemon. No cloud backend. No code upload. No API calls.
`);
}

main();
