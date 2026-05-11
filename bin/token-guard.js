#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { install, uninstall, setEnabled, setMode, allowOnce } from '../lib/installer.js';
import { ensureProjectFiles, getPaths, loadConfig } from '../lib/project.js';
import { handleHook } from '../lib/hook-handler.js';
import { generateReport, openReport, openFolder } from '../lib/report.js';
import { scanProject } from '../lib/token-utils.js';
import { runDoctor, formatDoctor } from '../lib/doctor.js';
import { buildSymbolIndex, findSymbols, smartRead, summarizeFile, formatSmartReadResult, formatFindResults } from '../lib/precision.js';
import { buildContextForFile, formatContextResult } from '../lib/context-router.js';
import { applyEdit } from '../lib/edit-flow.js';

const [, , cmd, ...args] = process.argv;

async function main() {
  const projectRoot = process.cwd();
  try {
    switch (cmd) {
      case 'install': return cmdInstall(projectRoot, args);
      case 'uninstall': return cmdUninstall(projectRoot, args);
      case 'enable': return cmdEnable(projectRoot);
      case 'disable': return cmdDisable(projectRoot);
      // Hidden backward-compatible command. Smart Savings is the only product-facing policy.
      case 'mode': return cmdMode(projectRoot);
      case 'status': return cmdStatus(projectRoot);
      case 'doctor': return cmdDoctor(projectRoot);
      case 'estimate': return cmdEstimate(projectRoot);
      case 'ctx':
      case 'context': return cmdContext(projectRoot, args);
      case 'index': return cmdIndex(projectRoot);
      case 'find': return cmdFind(projectRoot, args);
      case 'read': return cmdRead(projectRoot, args);
      case 'summarize': return cmdSummarize(projectRoot, args);
      case 'edit': return cmdEdit(projectRoot, args);
      case 'report': return cmdReport(projectRoot);
      case 'open-report': return cmdOpenReport(projectRoot);
      case 'open-folder': return cmdOpenFolder(projectRoot);
      case 'allow': return cmdAllow(projectRoot, args);
      case 'hook': return handleHook(args[0]);
      case 'help':
      case undefined:
      case '-h':
      case '--help': return printHelp();
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
  const noClaude = args.includes('--no-claude');
  const noCodex = args.includes('--no-codex');
  const { paths } = install(projectRoot, { claude: !noClaude, codex: !noCodex });
  console.log(`Token Guard installed in ${projectRoot}`);
  console.log('Smart Savings: on');
  console.log(`Local folder: ${path.relative(projectRoot, paths.base)}/`);
  if (!noClaude) console.log(`Claude Code hooks: enabled in ${path.relative(projectRoot, paths.claudeSettingsLocal)}`);
  if (!noCodex) console.log(`Codex desktop instructions: enabled in ${path.relative(projectRoot, paths.agents)}`);
  console.log(`Reports: ${path.relative(projectRoot, paths.reports)}/`);
  console.log('Run `token-guard doctor` to verify the installation.');
  console.log('Run `token-guard report` anytime to generate your Savings Report.');
}

function cmdUninstall(projectRoot, args) {
  const keepData = args.includes('--keep-data');
  const { removed } = uninstall(projectRoot, { keepData });
  console.log(keepData ? 'Token Guard hooks/instructions disabled. Local data kept.' : 'Token Guard fully uninstalled from this project.');
  if (removed?.length) { console.log('\nRemoved/cleaned:'); for (const item of removed) console.log(`- ${item}`); } else console.log('No Token Guard files or hooks were found.');
  if (!keepData) { console.log('\nProject cleanup complete. You can reinstall with:'); console.log('  token-guard install'); }
}
function cmdEnable(projectRoot) { const config = setEnabled(projectRoot, true); console.log(`Token Guard enabled. Smart Savings: ${config.policy?.strategy || 'smart'}`); }
function cmdDisable(projectRoot) { setEnabled(projectRoot, false); console.log('Token Guard disabled. Hooks may still fire, but they will exit without doing work.'); }
function cmdMode(projectRoot) { const config = setMode(projectRoot); console.log(`Token Guard uses one policy now: ${config.policy?.strategy || 'smart'}. No user-facing modes are required.`); }
function cmdAllow(projectRoot, args) { const file = args.filter(arg => !arg.startsWith('--')).at(-1) || '*'; const config = allowOnce(projectRoot, file); console.log(`Token Guard will allow one full read for: ${file}`); console.log(`Remaining one-time force-read entries: ${(config.forceRead?.once || []).join(', ') || '(none)'}`); }

function cmdStatus(projectRoot) {
  ensureProjectFiles(projectRoot);
  const paths = getPaths(projectRoot);
  const config = loadConfig(projectRoot);
  console.log('Token Guard status\n');
  console.log(`Project: ${projectRoot}`);
  console.log(`Enabled: ${config.enabled}`);
  console.log(`Smart Savings: ${config.policy?.strategy || 'smart'}`);
  console.log(`Signal: ${config.signal?.enabled !== false ? config.signal?.level || 'balanced' : 'off'}`);
  console.log(`Long input digest: ${config.longInput?.enabled !== false ? 'enabled' : 'disabled'}`);
  console.log(`Narrow Read max: ${config.thresholds.narrowReadMaxLines.toLocaleString('en-US')} lines`);
  console.log(`Precision read max: ${config.thresholds.precisionReadMaxTokens.toLocaleString('en-US')} tokens`);
  console.log(`Local folder: ${path.relative(projectRoot, paths.base)}/`);
  console.log(`Claude settings: ${fs.existsSync(paths.claudeSettingsLocal) ? 'present' : 'not found'}`);
  console.log(`AGENTS.md: ${fs.existsSync(paths.agents) ? 'present' : 'not found'}`);
  console.log(`Symbol index: ${fs.existsSync(paths.symbolsJson) ? 'present' : 'not found'}`);
  console.log('Background daemon: not running. Token Guard only runs when hooks/instructions trigger it.');
}
function cmdDoctor(projectRoot) { const result = runDoctor(projectRoot); console.log(formatDoctor(result)); if (!result.ok) process.exitCode = 1; }
function cmdEstimate(projectRoot) { ensureProjectFiles(projectRoot); const config = loadConfig(projectRoot); const scan = scanProject(projectRoot, config); console.log(`Estimated project context: ${scan.totalTokens.toLocaleString('en-US')} tokens across ${scan.scannedFiles} files.`); console.log('Top token-heavy files:'); for (const row of scan.files.slice(0, 12)) console.log(`- ${row.tokens.toLocaleString('en-US')} tokens · ${row.path}`); }

function cmdContext(projectRoot, args) {
  ensureProjectFiles(projectRoot);
  const file = args.find(arg => !arg.startsWith('--') && !arg.includes(':'));
  if (!file) { console.error('Usage: token-guard ctx <file> [--focus NAME] [--around TEXT] [--lines A:B] [--diff] [--max-tokens N]'); process.exitCode = 1; return; }
  const options = parseOptions(args);
  const config = loadConfig(projectRoot);
  const result = buildContextForFile(projectRoot, file, { ...options, config, maxTokens: options.maxTokens || config.thresholds?.precisionReadMaxTokens });
  console.log(formatContextResult(result, { includeLanguagePolicy: false }));
}
function cmdIndex(projectRoot) { ensureProjectFiles(projectRoot); const config = loadConfig(projectRoot); const index = buildSymbolIndex(projectRoot, config); const paths = getPaths(projectRoot); console.log('Token Guard symbol index generated.'); console.log(`Files indexed: ${index.files.length.toLocaleString('en-US')}`); console.log(`Symbols found: ${index.symbols.length.toLocaleString('en-US')}`); console.log(`Index: ${path.relative(projectRoot, paths.symbolsJson)}`); }
function cmdFind(projectRoot, args) { ensureProjectFiles(projectRoot); const query = args.find(arg => !arg.startsWith('--')); if (!query) { console.error('Usage: token-guard find <symbol-or-query>'); process.exitCode = 1; return; } const config = loadConfig(projectRoot); const results = findSymbols(projectRoot, query, { config, rebuild: args.includes('--rebuild') }); console.log(formatFindResults(results)); }
function cmdRead(projectRoot, args) { ensureProjectFiles(projectRoot); const file = args.find(arg => !arg.startsWith('--') && !arg.includes(':')); if (!file) { console.error('Usage: token-guard read <file> [--symbol NAME] [--section NAME] [--around TEXT] [--lines A:B] [--diff]'); process.exitCode = 1; return; } const options = parseOptions(args); const config = loadConfig(projectRoot); const result = smartRead(projectRoot, file, { ...options, maxTokens: options.maxTokens || config.thresholds?.precisionReadMaxTokens, contextLines: options.contextLines || config.thresholds?.symbolContextLines }); console.log(formatSmartReadResult(result)); }
function cmdSummarize(projectRoot, args) { ensureProjectFiles(projectRoot); const file = args.find(arg => !arg.startsWith('--')); if (!file) { console.error('Usage: token-guard summarize <file>'); process.exitCode = 1; return; } const result = summarizeFile(projectRoot, file); console.log('Token Guard summary generated.'); console.log(`File: ${result.file}`); console.log(`Tokens: ${result.tokens.toLocaleString('en-US')}`); console.log(`Symbols: ${result.symbols.toLocaleString('en-US')}`); console.log(`Sections: ${result.sections.toLocaleString('en-US')}`); console.log(`Summary: ${path.relative(projectRoot, result.summaryPath)}`); }
function cmdEdit(projectRoot, args) { const file = args.find(arg => !arg.startsWith('--')); if (!file) { console.error('Usage: token-guard edit <file> --old TEXT --new TEXT [--all]'); process.exitCode = 1; return; } const options = parseOptions(args); const result = applyEdit(projectRoot, file, { ...options, all: args.includes('--all') }); console.log(`Token Guard edit applied: ${result.file}`); console.log(`Replacements: ${result.occurrences}`); }
function cmdReport(projectRoot) { const { html, svg, model } = generateReport(projectRoot); console.log('Generated Savings Report:'); console.log(`- ${html}`); console.log(`- ${svg}`); console.log(`Net saved after overhead: ${Math.round(model.netSavingsTokens).toLocaleString('en-US')} tokens`); console.log(`Potential avoidable context: ${Math.round(model.potentialWasteFlaggedTokens).toLocaleString('en-US')} tokens`); }
function cmdOpenReport(projectRoot) { openReport(projectRoot); console.log('Opening latest Savings Report...'); }
function cmdOpenFolder(projectRoot) { ensureProjectFiles(projectRoot); openFolder(projectRoot); console.log('Opening TokenGuard folder...'); }

function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => args[++i];
    if (arg === '--focus') { const v = next(); options.focus = v; options.symbol = v; options.section = v; continue; }
    if (arg.startsWith('--focus=')) { const v = arg.slice(8); options.focus = v; options.symbol = v; options.section = v; continue; }
    if (arg === '--symbol') { const v = next(); options.symbol = v; options.focus = v; continue; }
    if (arg.startsWith('--symbol=')) { const v = arg.slice(9); options.symbol = v; options.focus = v; continue; }
    if (arg === '--section') { const v = next(); options.section = v; options.focus = v; continue; }
    if (arg.startsWith('--section=')) { const v = arg.slice(10); options.section = v; options.focus = v; continue; }
    if (arg === '--around') { options.around = next(); continue; }
    if (arg.startsWith('--around=')) { options.around = arg.slice(9); continue; }
    if (arg === '--lines') { options.lines = next(); continue; }
    if (arg.startsWith('--lines=')) { options.lines = arg.slice(8); continue; }
    if (arg === '--max-tokens') { options.maxTokens = Number(next()); continue; }
    if (arg.startsWith('--max-tokens=')) { options.maxTokens = Number(arg.slice(13)); continue; }
    if (arg === '--context-lines' || arg === '--context') { options.contextLines = Number(next()); options.context = options.contextLines; continue; }
    if (arg.startsWith('--context=')) { options.context = Number(arg.slice(10)); options.contextLines = options.context; continue; }
    if (arg === '--old') { options.oldString = next(); continue; }
    if (arg.startsWith('--old=')) { options.oldString = arg.slice(6); continue; }
    if (arg === '--new') { options.newString = next(); continue; }
    if (arg.startsWith('--new=')) { options.newString = arg.slice(6); continue; }
    if (arg === '--diff') { options.diff = true; continue; }
  }
  return options;
}

function printHelp() {
  console.log(`Token Guard

Stop wasting tokens across the AI coding loop.

Usage:
  token-guard install [--no-claude] [--no-codex]
  token-guard doctor
  token-guard status
  token-guard report
  token-guard open-report
  token-guard uninstall

Agent-facing context tools:
  tg ctx <file>
  tg ctx <file> --focus <symbol-or-topic>
  tg ctx <file> --around <text> --context 10
  tg ctx <file> --lines A:B
  tg ctx <file> --diff

Advanced tools:
  token-guard estimate
  token-guard index
  token-guard find <symbol-or-query>
  token-guard read <file> [--symbol NAME] [--section NAME] [--around TEXT] [--lines A:B] [--diff]
  token-guard summarize <file>
  token-guard edit <file> --old TEXT --new TEXT [--all]
  token-guard allow <file> --once
  token-guard disable
  token-guard enable

Default behavior:
  Smart Savings is automatic. There are no user-facing modes.
  Token Guard compresses long inputs, trims noisy outputs, keeps compressed handoffs,
  and only intervenes on high-confidence token waste.

Trust model:
  Local-first. No daemon. No cloud backend. No code upload. No API calls.
`);
}

main();
