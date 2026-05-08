#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { install, uninstall, setEnabled, setMode, allowOnce } from '../lib/installer.js';
import { ensureProjectFiles, getPaths, loadConfig } from '../lib/project.js';
import { handleHook } from '../lib/hook-handler.js';
import { generateReport, openReport, openFolder } from '../lib/report.js';
import { scanProject } from '../lib/token-utils.js';

const [, , cmd, ...args] = process.argv;

async function main() {
  const projectRoot = process.cwd();

  try {
    switch (cmd) {
      case 'install':
        return cmdInstall(projectRoot, args);
      case 'uninstall':
        return cmdUninstall(projectRoot);
      case 'enable':
        return cmdEnable(projectRoot);
      case 'disable':
        return cmdDisable(projectRoot);
      case 'mode':
        return cmdMode(projectRoot, args[0]);
      case 'status':
        return cmdStatus(projectRoot);
      case 'estimate':
        return cmdEstimate(projectRoot);
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
  const active = args.includes('--active');
  const noClaude = args.includes('--no-claude');
  const noCodex = args.includes('--no-codex');

  const mode = active ? 'active' : observe ? 'observe' : undefined;
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
  console.log('Default mode is observe. Token Guard will not block reads unless you switch to active/strict.');
  console.log('Run `token-guard report` anytime to generate your Savings Report.');
}

function cmdUninstall(projectRoot) {
  const { paths } = uninstall(projectRoot);

  console.log('Token Guard hooks/instructions disabled.');
  console.log(`Local data kept at ${path.relative(projectRoot, paths.base)}/`);
  console.log('Delete that folder manually if you want to remove reports, memory, and the savings ledger.');
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
  const file = args.find(arg => !arg.startsWith('--')) || '*';
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
  console.log(`Local folder: ${path.relative(projectRoot, paths.base)}/`);
  console.log(`Claude settings: ${fs.existsSync(paths.claudeSettingsLocal) ? 'present' : 'not found'}`);
  console.log(`AGENTS.md: ${fs.existsSync(paths.agents) ? 'present' : 'not found'}`);
  console.log('Background daemon: not running. Token Guard only runs when hooks/instructions trigger it.');
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

function printHelp() {
  console.log(`Token Guard

Stop feeding your whole repo to AI.

Usage:
  token-guard install [--observe|--active] [--no-claude] [--no-codex]
  token-guard status
  token-guard enable
  token-guard disable
  token-guard mode observe|active|edit|strict
  token-guard allow <file> --once
  token-guard estimate
  token-guard report
  token-guard open-report
  token-guard open-folder
  token-guard uninstall

Default mode is observe:
  Token Guard records waste and adds guidance, but does not block reads.

Active mode:
  Token Guard may ask/block obvious huge/generated/log file reads.

Escape hatch:
  token-guard allow path/to/file --once
  or write @tg:force-read path/to/file in your next prompt.
`);
}

main();
