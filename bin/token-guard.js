#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, upgrade, uninstall, setEnabled, setMode, allowOnce } from '../lib/installer.js';
import { ensureProjectFiles, getPaths, loadConfig } from '../lib/project.js';
import { handleHook } from '../lib/hook-handler.js';
import { formatStats, appendEvent } from '../lib/ledger.js';
import { generateReport, openReport, openFolder } from '../lib/report.js';
import { scanProject, estimateTokens } from '../lib/token-utils.js';
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
import { applyEdit } from '../lib/edit-flow.js';
import {
  sessionCheck,
  turnTick,
  resetSession,
  getCodexActivity,
  recordHandoffWritten,
  formatSessionCheck,
  buildPressureFooter
} from '../lib/session-check.js';
import { writeHandoffManual } from '../lib/handoff.js';
import { uninstallGlobalCli, formatGlobalUninstallResult } from '../lib/global-uninstall.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGE_JSON = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
);

const VERSION = PACKAGE_JSON.version || 'unknown';

const [, , cmd, ...args] = process.argv;

async function main() {
  const projectRoot = process.cwd();

  try {
    switch (cmd) {
      case 'install':
        return cmdInstall(projectRoot, args);
      case 'upgrade':
        return cmdUpgrade(projectRoot, args);
      case 'uninstall':
        if (args.includes('--global')) {
          return cmdUninstallGlobal(args);
        }
        return cmdUninstall(projectRoot, args);
      case 'enable':
        return cmdEnable(projectRoot);
      case 'disable':
        return cmdDisable(projectRoot);
      case 'mode':
        return cmdMode(projectRoot);
      case 'status':
        return cmdStatus(projectRoot);
      case 'stats':
        return cmdStats(projectRoot);
      case 'version':
      case '--version':
      case '-v':
        return cmdVersion();
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
      case 'edit':
        return cmdEdit(projectRoot, args);
      case 'report':
        return cmdReport(projectRoot);
      case 'open-report':
        return cmdOpenReport(projectRoot);
      case 'open-folder':
        return cmdOpenFolder(projectRoot);
      case 'allow':
        return cmdAllow(projectRoot, args);
      case 'session-check':
      case 'session_check':
        return cmdSessionCheck(projectRoot, args);
      case 'turn-tick':
      case 'turn_tick':
      case 'tick':
        return cmdTurnTick(projectRoot, args);
      case 'handoff':
        return cmdHandoff(projectRoot, args);
      case 'hook':
        return handleHook(args[0]);
      case 'help':
      case undefined:
      case '-h':
      case '--help':
        return printHelp();
      case 'uninstall-global':
      case 'global-uninstall':
      case 'global-clean':
        return cmdUninstallGlobal(args);
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

  const { paths } = install(projectRoot, {
    claude: !noClaude,
    codex: !noCodex
  });

  console.log(`Token Guard installed in ${projectRoot}`);
  console.log(`Version: ${VERSION}`);
  console.log('Smart Savings: on');
  console.log(`Local folder: ${path.relative(projectRoot, paths.base)}/`);

  if (!noClaude) {
    console.log(`Claude Code hooks: enabled in ${path.relative(projectRoot, paths.claudeSettingsLocal)}`);
  }

  if (!noCodex) {
    console.log(`Codex desktop instructions: enabled in ${path.relative(projectRoot, paths.agents)}`);
  }

  console.log(`Reports: ${path.relative(projectRoot, paths.reports)}/`);
  console.log('Run `token-guard doctor` to verify the installation.');
  console.log('Run `token-guard report` anytime to generate your Savings Report.');
}

function cmdUpgrade(projectRoot, args) {
  const noClaude = args.includes('--no-claude');
  const noCodex = args.includes('--no-codex');

  const result = upgrade(projectRoot, {
    claude: !noClaude,
    codex: !noCodex
  });

  console.log(`Token Guard upgraded in ${projectRoot}`);
  console.log(`Version: ${VERSION}`);
  console.log('Smart Savings: on');

  if (result.preservedData) {
    console.log('Local TokenGuard data preserved.');
  }

  if (!noClaude) {
    console.log(`Claude Code hooks: refreshed in ${path.relative(projectRoot, result.paths.claudeSettingsLocal)}`);
  }

  if (!noCodex) {
    console.log(`Codex desktop instructions: refreshed in ${path.relative(projectRoot, result.paths.agents)}`);
  }

  console.log('Project rules refreshed. Run `token-guard doctor` to verify.');
}

function cmdUninstall(projectRoot, args) {
  const keepData = args.includes('--keep-data');
  const { removed } = uninstall(projectRoot, { keepData });

  console.log(
    keepData
      ? 'Token Guard hooks/instructions disabled. Local data kept.'
      : 'Token Guard fully uninstalled from this project.'
  );

  if (removed?.length) {
    console.log('\nRemoved/cleaned:');

    for (const item of removed) {
      console.log(`- ${item}`);
    }
  } else {
    console.log('No Token Guard files or hooks were found.');
  }

  if (!keepData) {
    console.log('\nProject cleanup complete. You can reinstall in this project with:');
    console.log('  token-guard install');
  }

  console.log('\nNote: this removes Token Guard from the current project only.');
  console.log('To remove the global CLI commands too, run:');
  console.log('  token-guard uninstall-global');
}

function cmdEnable(projectRoot) {
  const config = setEnabled(projectRoot, true);

  console.log(`Token Guard enabled. Smart Savings: ${config.policy?.strategy || 'smart'}`);
}

function cmdDisable(projectRoot) {
  setEnabled(projectRoot, false);

  console.log('Token Guard disabled. Hooks may still fire, but they will exit without doing work.');
}

function cmdUninstallGlobal(args) {
  const force = args.includes('--force');
  const yes = args.includes('--yes') || args.includes('-y');

  if (force && !yes) {
    console.error('--force will remove ANY file named `token-guard` or `tg` in candidate bin directories,');
    console.error('even if it is not recognized as Token Guard. This may delete unrelated tools with the same name.');
    console.error('');
    console.error('Re-run with both flags to confirm:');
    console.error('  token-guard uninstall-global --force --yes');
    process.exitCode = 1;
    return;
  }

  const result = uninstallGlobalCli({
    force,
    skipNpm: args.includes('--skip-npm'),
    dryRun: args.includes('--dry-run')
  });

  console.log(formatGlobalUninstallResult(result));
}

function cmdMode(projectRoot) {
  const config = setMode(projectRoot);

  console.log(`Token Guard uses one policy now: ${config.policy?.strategy || 'smart'}. No user-facing modes are required.`);
}

function cmdAllow(projectRoot, args) {
  const file = args.filter(arg => !arg.startsWith('--')).at(-1) || '*';
  const config = allowOnce(projectRoot, file);

  console.log(`Token Guard will allow one full read for: ${file}`);
  console.log(`Remaining one-time force-read entries: ${(config.forceRead?.once || []).join(', ') || '(none)'}`);
}

function cmdVersion() {
  console.log(`token-guard ${VERSION}`);
}

function cmdStats(projectRoot) {
  ensureProjectFiles(projectRoot);
  console.log(formatStats(projectRoot));
}

function cmdStatus(projectRoot) {
  ensureProjectFiles(projectRoot);

  const paths = getPaths(projectRoot);
  const config = loadConfig(projectRoot);

  console.log('Token Guard status\n');
  console.log(`Version: ${VERSION}`);
  console.log(`Project: ${projectRoot}`);
  console.log(`Enabled: ${config.enabled}`);
  console.log(`Smart Savings: ${config.policy?.strategy || 'smart'}`);
  console.log(`Signal: ${config.signal?.enabled !== false ? config.signal?.level || 'balanced' : 'off'}`);
  console.log(`Long input digest: ${config.longInput?.enabled !== false ? 'enabled' : 'disabled'}`);
  console.log(`Narrow Read max: ${config.thresholds.narrowReadMaxLines.toLocaleString('en-US')} lines`);
  console.log(`Precision read max: ${config.thresholds.precisionReadMaxTokens.toLocaleString('en-US')} tokens`);
  console.log(`Local folder: ${path.relative(projectRoot, paths.base)}/`);
  console.log(`Symbol index: ${fs.existsSync(paths.symbolsJson) ? 'present' : 'not found'}`);

  console.log('\n— Channels —');

  const claudeActive = fs.existsSync(paths.claudeSettingsLocal) && claudeHooksPresent(paths.claudeSettingsLocal);
  console.log(`Claude Code:  ${claudeActive ? 'hooks active' : 'no hooks installed'}${claudeActive ? ` (${path.relative(projectRoot, paths.claudeSettingsLocal)})` : ''}`);

  const codex = getCodexActivity(projectRoot);
  const agentsPresent = fs.existsSync(paths.agents);
  const codexLine = codex.present
    ? `CLI-mode (no hooks). Last tick: ${codex.lastTickAt || 'n/a'} · ${codex.turnCount} turns · ~${Number(codex.cumulative || 0).toLocaleString('en-US')} tok cumulative`
    : agentsPresent
      ? 'CLI-mode (no hooks). No turn-tick recorded yet — Codex may not be calling `tg turn-tick`.'
      : 'not installed (AGENTS.md missing)';
  console.log(`Codex:        ${codexLine}`);

  console.log('\nBackground daemon: not running. Token Guard only runs when hooks or CLI tools trigger it.');
}

function claudeHooksPresent(settingsPath) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const hooks = settings.hooks || {};
    return Object.values(hooks).some(groups => {
      if (!Array.isArray(groups)) return false;
      return groups.some(group => (group.hooks || []).some(hook => /token-guard hook/.test(String(hook.command || ''))));
    });
  } catch {
    return false;
  }
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
    console.error('Usage: token-guard ctx <file> [--focus NAME] [--around TEXT] [--lines A:B] [--diff] [--max-tokens N]');
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

  recordContextSavingsFromResult(projectRoot, result, {
    file,
    method: inferContextMethod(options),
    query: inferContextQuery(options)
  });

  console.log(formatContextResult(result, {
    includeLanguagePolicy: false
  }));

  const returned = Number(result.returnedTokens || 0);
  const footer = buildPressureFooter(projectRoot, returned);
  if (footer) console.log(footer);
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

  const footer = buildPressureFooter(projectRoot, 0);
  if (footer) console.log(footer);
}

function cmdRead(projectRoot, args) {
  ensureProjectFiles(projectRoot);

  const file = args.find(arg => !arg.startsWith('--') && !arg.includes(':'));

  if (!file) {
    console.error('Usage: token-guard read <file> [--symbol NAME] [--section NAME] [--around TEXT] [--lines A:B] [--diff]');
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

  const returned = Number(result.returnedTokens || 0);
  const footer = buildPressureFooter(projectRoot, returned);
  if (footer) console.log(footer);
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

  const footer = buildPressureFooter(projectRoot, 0);
  if (footer) console.log(footer);
}

function cmdEdit(projectRoot, args) {
  const file = args.find(arg => !arg.startsWith('--'));

  if (!file) {
    console.error('Usage: token-guard edit <file> --old TEXT --new TEXT [--all]');
    process.exitCode = 1;
    return;
  }

  const options = parseOptions(args);

  const result = applyEdit(projectRoot, file, {
    ...options,
    all: args.includes('--all')
  });

  console.log(`Token Guard edit applied: ${result.file}`);
  console.log(`Replacements: ${result.occurrences}`);

  const footer = buildPressureFooter(projectRoot, 0);
  if (footer) console.log(footer);
}

function cmdSessionCheck(projectRoot, args) {
  ensureProjectFiles(projectRoot);

  if (args.includes('--reset')) {
    const result = resetSession(projectRoot);
    if (args.includes('--json')) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatSessionCheck(result));
    }
    return;
  }

  const result = sessionCheck(projectRoot);

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatSessionCheck(result));

  if (result.level === 'switch') {
    process.exitCode = 2;
  } else if (result.level === 'warn') {
    process.exitCode = 0;
  }
}

function cmdTurnTick(projectRoot, args) {
  ensureProjectFiles(projectRoot);

  const options = parseOptions(args);
  const result = turnTick(projectRoot, {
    prompt: options.prompt || '',
    promptTokens: options.promptTokens || 0,
    outputTokens: options.outputTokens || 0,
    tools: options.tools || [],
    note: options.note || ''
  });

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatSessionCheck(result));
}

function cmdHandoff(projectRoot, args) {
  ensureProjectFiles(projectRoot);

  const sub = args.find(arg => !arg.startsWith('--')) || 'write';
  const options = parseOptions(args);

  if (sub === 'write' || sub === 'update') {
    const result = writeHandoffManual(projectRoot, {
      goal: options.goal || '',
      note: options.note || '',
      reason: 'cli_handoff_write',
      force: args.includes('--force')
    });

    if (!result.updated) {
      console.log(`Token Guard handoff: not updated (${result.reason}).`);
      return;
    }

    recordHandoffWritten(projectRoot);

    console.log('Token Guard handoff written.');
    console.log(`Path: ${path.relative(projectRoot, result.handoffPath)}`);
    console.log(`Files read: ${result.filesRead}, touched: ${result.filesTouched}, commands: ${result.commandsRun}, failures: ${result.failures}`);
    console.log(`Size: ${result.handoffLines} lines / ${result.handoffChars.toLocaleString('en-US')} chars`);
    console.log('Next Codex session SessionStart will auto-load this handoff.');
    return;
  }

  if (sub === 'show' || sub === 'cat') {
    const paths = getPaths(projectRoot);
    if (!fs.existsSync(paths.handoff)) {
      console.log('No handoff present.');
      return;
    }
    console.log(fs.readFileSync(paths.handoff, 'utf8'));
    return;
  }

  console.error(`Unknown handoff subcommand: ${sub}\nUsage: token-guard handoff [write|show] [--goal TEXT] [--note TEXT] [--force]`);
  process.exitCode = 1;
}

function cmdReport(projectRoot) {
  const { html, svg, model, todayDisplay, weekDisplay } = generateReport(projectRoot);
  const weekSaved = Math.round(Number(weekDisplay?.savedTokens ?? model.displaySavedTokens ?? 0));
  const todaySaved = Math.round(Number(todayDisplay?.savedTokens ?? 0));

  console.log('Generated Savings Report:');
  console.log(`- ${html}`);
  console.log(`- ${svg}`);
  console.log(`Token Guard saved today: ${todaySaved.toLocaleString('en-US')} tokens`);
  console.log(`Token Guard saved this week: ${weekSaved.toLocaleString('en-US')} tokens`);
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

function recordContextSavingsFromResult(projectRoot, result, meta = {}) {
  const text = result?.text || result?.content || result?.snippet || '';
  const original = Number(
    result?.originalTokens ||
    result?.estimatedOriginalTokens ||
    result?.fullTokens ||
    0
  );
  const returned = Number(
    result?.returnedTokens ||
    result?.estimatedTokens ||
    estimateTokens(text)
  );

  const saved = Math.max(0, original - returned);

  if (!original || !returned || saved <= 0) return;

  appendEvent(projectRoot, {
    type: 'context_read_saved',
    file: result.file || meta.file,
    kind: result.kind || 'ctx',
    method: meta.method || result.kind || 'ctx',
    query: meta.query ? String(meta.query).slice(0, 160) : '',
    originalTokens: original,
    returnedTokens: returned,
    savedTokens: saved,
    startLine: result.startLine || null,
    endLine: result.endLine || null
  });
}

function inferContextMethod(options = {}) {
  if (options.diff) return 'diff';
  if (options.lines) return 'lines';
  if (options.around) return 'around';
  if (options.focus || options.symbol) return 'focus';
  if (options.section) return 'section';

  return 'ctx';
}

function inferContextQuery(options = {}) {
  return options.around || options.focus || options.symbol || options.section || options.lines || '';
}

function parseOptions(args) {
  const options = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => args[++i];

    if (arg === '--focus') {
      const value = next();
      options.focus = value;
      options.symbol = value;
      options.section = value;
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
      const value = next();
      options.symbol = value;
      options.focus = value;
      continue;
    }

    if (arg.startsWith('--symbol=')) {
      const value = arg.slice('--symbol='.length);
      options.symbol = value;
      options.focus = value;
      continue;
    }

    if (arg === '--section') {
      const value = next();
      options.section = value;
      options.focus = value;
      continue;
    }

    if (arg.startsWith('--section=')) {
      const value = arg.slice('--section='.length);
      options.section = value;
      options.focus = value;
      continue;
    }

    if (arg === '--around') {
      options.around = next();
      continue;
    }

    if (arg.startsWith('--around=')) {
      options.around = arg.slice('--around='.length);
      continue;
    }

    if (arg === '--lines') {
      options.lines = next();
      continue;
    }

    if (arg.startsWith('--lines=')) {
      options.lines = arg.slice('--lines='.length);
      continue;
    }

    if (arg === '--max-tokens') {
      options.maxTokens = Number(next());
      continue;
    }

    if (arg.startsWith('--max-tokens=')) {
      options.maxTokens = Number(arg.slice('--max-tokens='.length));
      continue;
    }

    if (arg === '--context-lines' || arg === '--context') {
      options.contextLines = Number(next());
      options.context = options.contextLines;
      continue;
    }

    if (arg.startsWith('--context=')) {
      options.context = Number(arg.slice('--context='.length));
      options.contextLines = options.context;
      continue;
    }

    if (arg === '--old') {
      options.oldString = next();
      continue;
    }

    if (arg.startsWith('--old=')) {
      options.oldString = arg.slice('--old='.length);
      continue;
    }

    if (arg === '--new') {
      options.newString = next();
      continue;
    }

    if (arg.startsWith('--new=')) {
      options.newString = arg.slice('--new='.length);
      continue;
    }

    if (arg === '--diff') {
      options.diff = true;
      continue;
    }

    if (arg === '--note') { options.note = next(); continue; }
    if (arg.startsWith('--note=')) { options.note = arg.slice('--note='.length); continue; }

    if (arg === '--goal') { options.goal = next(); continue; }
    if (arg.startsWith('--goal=')) { options.goal = arg.slice('--goal='.length); continue; }

    if (arg === '--prompt') { options.prompt = next(); continue; }
    if (arg.startsWith('--prompt=')) { options.prompt = arg.slice('--prompt='.length); continue; }

    if (arg === '--prompt-tokens') { options.promptTokens = Number(next()); continue; }
    if (arg.startsWith('--prompt-tokens=')) { options.promptTokens = Number(arg.slice('--prompt-tokens='.length)); continue; }

    if (arg === '--output-tokens') { options.outputTokens = Number(next()); continue; }
    if (arg.startsWith('--output-tokens=')) { options.outputTokens = Number(arg.slice('--output-tokens='.length)); continue; }

    if (arg === '--tool' || arg === '--tools') {
      const value = next();
      options.tools = String(value || '').split(',').map(s => s.trim()).filter(Boolean);
      continue;
    }

    if (arg.startsWith('--tool=') || arg.startsWith('--tools=')) {
      const value = arg.slice(arg.indexOf('=') + 1);
      options.tools = String(value || '').split(',').map(s => s.trim()).filter(Boolean);
      continue;
    }
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
  token-guard stats
  token-guard version
  token-guard upgrade
  token-guard report
  token-guard open-report
  token-guard uninstall                              # remove from current project
  token-guard uninstall-global [--force --yes] [--skip-npm] [--dry-run]  # remove global CLI + npm package
  token-guard uninstall --global                     # alias for uninstall-global

Agent-facing context tools:
  tg ctx <file>
  tg ctx <file> --focus <symbol-or-topic>
  tg ctx <file> --around <text> --context 10
  tg ctx <file> --lines A:B
  tg ctx <file> --diff

Codex session monitoring (CLI-only, no daemon):
  tg session-check                                 # check context pressure each turn (exit 2 = switch)
  tg session-check --reset                         # mark a new Codex session boundary
  tg turn-tick --output-tokens N --note "<goal>"   # record one turn's cumulative tokens
  tg turn-tick --prompt "<text>" --tool tg-ctx     # estimate prompt + record tools
  tg handoff write --goal "<goal>" --note "<next>" # explicit handoff before /clear
  tg handoff show                                  # print current handoff

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

Update current project:
  After updating the global npm package, run \`token-guard upgrade\` inside projects that need refreshed hooks/rules.

Default behavior:
  Smart Savings is automatic. There are no user-facing modes.
  Token Guard compresses long inputs, trims noisy outputs, keeps compressed handoffs,
  records targeted context savings, and only intervenes on high-confidence token waste.

Trust model:
  Local-first. No daemon. No cloud backend. No code upload. No API calls.
`);
}

main();
