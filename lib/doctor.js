import fs from 'node:fs';
import path from 'node:path';
import { getPaths, loadConfig } from './project.js';
import { isTokenGuardCommand } from './installer.js';

const REQUIRED_HOOKS = ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','SessionEnd','PreCompact'];
const REQUIRED_GITIGNORE_ENTRIES = ['TokenGuard/','CLAUDE.local.md','.claude/settings.local.json'];

export function runDoctor(projectRoot = process.cwd()) {
  const paths = getPaths(projectRoot);
  const checks = [];
  const add = (id, label, status, detail = '', fix = '') => checks.push({ id, label, status, detail, fix });

  add('visible-local-folder','Visible local TokenGuard/ folder',fs.existsSync(paths.base)?'pass':'fail',fs.existsSync(paths.base)?`Found ${relative(projectRoot,paths.base)}/`:'TokenGuard/ was not found.','Run `token-guard install` inside the project root.');
  add('mixed-version-dirs','Legacy .token-guard folder',fs.existsSync(paths.legacyBase)?'warn':'pass',fs.existsSync(paths.legacyBase)?'Legacy .token-guard/ folder detected.':'No legacy .token-guard/ folder detected.','Run `token-guard uninstall`, then reinstall with `token-guard install`.');
  add('legacy-python-mvp','Legacy Python MVP file',fs.existsSync(paths.legacyPythonMvp)?'warn':'pass',fs.existsSync(paths.legacyPythonMvp)?'Legacy token_guard.py detected.':'No legacy token_guard.py detected.','Run `token-guard uninstall`, then reinstall with `token-guard install`.');

  let config=null;
  if (fs.existsSync(paths.config)) {
    try { config=loadConfig(projectRoot); add('config','Config file','pass',`Found ${relative(projectRoot,paths.config)}`); }
    catch(err){ add('config','Config file','fail',`Config exists but could not be parsed: ${err.message}`,'Delete or fix TokenGuard/config.json, then run `token-guard install`.'); }
  } else add('config','Config file','fail','TokenGuard/config.json was not found.','Run `token-guard install`.');

  if (config) {
    add('enabled','Enabled flag',config.enabled===true?'pass':'warn',config.enabled===true?'Token Guard is enabled.':'Token Guard is currently disabled.','Run `token-guard enable` if you want hooks to do work.');
    add('smart-policy','Smart Savings policy',config.policy?.strategy==='smart'?'pass':'warn',`strategy=${config.policy?.strategy || '(missing)'}`,'Run `token-guard install` to migrate to Smart Savings.');
    add('thresholds','Smart thresholds',Number(config.thresholds?.hardTokens)===60000 && Number(config.thresholds?.narrowReadMaxLines)===200?'pass':'warn',`hard=${config.thresholds?.hardTokens}, narrowReadMaxLines=${config.thresholds?.narrowReadMaxLines}`,'Recommended defaults: hard=60000, narrowReadMaxLines=200.');
    const allow=config.patterns?.alwaysAllow||[];
    const missing=['TokenGuard/','TokenGuard/sessions/','TokenGuard/summaries/','CLAUDE.local.md','AGENTS.md'].filter(item=>!allow.includes(item));
    add('self-allowlist','Self-file allowlist',missing.length===0?'pass':'fail',missing.length===0?'Token Guard self files are allowlisted.':`Missing allowlist entries: ${missing.join(', ')}`,'Reinstall or restore default patterns.alwaysAllow entries.');
    add('signal-mode','Balanced Signal Mode',config.signal?.enabled!==false?'pass':'warn',config.signal?.enabled!==false?`Enabled (${config.signal?.level||'balanced'}).`:'Disabled.','Set config.signal.enabled=true.');
    add('long-input','Long Input Digest',config.longInput?.enabled!==false?'pass':'warn',config.longInput?.enabled!==false?`Enabled at ${config.longInput?.minChars || 4000}+ chars.`:'Disabled.','Set config.longInput.enabled=true.');
  }

  checkClaudeSettings(projectRoot, paths, add);
  checkAgents(paths, add);
  checkGitignore(paths, add);
  add('local-first','Local-first posture','pass','No daemon, no cloud backend, no API key, no upload path is required by Token Guard.');

  const failed=checks.filter(c=>c.status==='fail').length;
  const warned=checks.filter(c=>c.status==='warn').length;
  const passed=checks.filter(c=>c.status==='pass').length;
  return { ok: failed===0, passed, warned, failed, checks };
}

export function formatDoctor(result) {
  const lines=['Token Guard doctor',''];
  for (const check of result.checks) {
    const icon=check.status==='pass'?'✓':check.status==='warn'?'!':'x';
    lines.push(`${icon} ${check.label}`);
    if (check.detail) lines.push(`  ${check.detail}`);
    if (check.status!=='pass' && check.fix) lines.push(`  Fix: ${check.fix}`);
    lines.push('');
  }
  lines.push(`Summary: ${result.passed} passed, ${result.warned} warning(s), ${result.failed} failed.`);
  lines.push(result.ok?'Token Guard installation looks usable.':'Token Guard installation needs attention.');
  return lines.join('\n');
}

function checkClaudeSettings(projectRoot, paths, add) {
  if (!fs.existsSync(paths.claudeSettingsLocal)) { add('claude-settings','Claude Code local settings','warn','.claude/settings.local.json was not found. This is fine if you installed with --no-claude.','Run `token-guard install` without --no-claude to install Claude hooks.'); return; }
  let settings=null;
  try { settings=JSON.parse(fs.readFileSync(paths.claudeSettingsLocal,'utf8')); }
  catch(err){ add('claude-settings','Claude Code local settings','fail',`.claude/settings.local.json could not be parsed: ${err.message}`,'Fix the JSON file or reinstall Token Guard.'); return; }
  add('claude-settings','Claude Code local settings','pass',`Found ${relative(projectRoot,paths.claudeSettingsLocal)}`);
  const hooks=settings.hooks||{};
  const missing=REQUIRED_HOOKS.filter(name=>!Object.keys(hooks).includes(name));
  add('claude-hooks','Claude Code hooks',missing.length===0?'pass':'warn',missing.length===0?`Found hooks: ${REQUIRED_HOOKS.join(', ')}`:`Missing hooks: ${missing.join(', ')}`,'Run `token-guard install` to rewrite hook entries.');
  const commands=collectHookCommands(hooks);
  const current=commands.filter(command=>command.includes('token-guard hook'));
  const old=commands.filter(command=>isTokenGuardCommand(command)&&!command.includes('token-guard hook'));
  add('claude-hook-commands','Token Guard hook commands',current.length>=5?'pass':'warn',current.length?`Found ${current.length} current token-guard hook command(s).`:'No current token-guard hook commands found.','Run `token-guard install`.');
  add('legacy-hook-commands','Legacy Token Guard hook commands',old.length===0?'pass':'warn',old.length?`Found legacy hook command(s): ${old.join(' | ')}`:'No legacy Token Guard hook commands detected.','Run `token-guard uninstall`, then reinstall.');
}

function checkAgents(paths, add) {
  if (!fs.existsSync(paths.agents)) { add('agents-md','Codex AGENTS.md rules','warn','AGENTS.md was not found. This is fine if you installed with --no-codex.','Run `token-guard install` without --no-codex to add Codex instructions.'); return; }
  const content=fs.readFileSync(paths.agents,'utf8');
  add('agents-md','Codex AGENTS.md rules',content.includes('TOKEN_GUARD_START')?'pass':'warn',content.includes('TOKEN_GUARD_START')?'Token Guard Codex instruction block found.':'AGENTS.md exists, but Token Guard block was not found.','Run `token-guard install`.');
}

function checkGitignore(paths, add) {
  if (!fs.existsSync(paths.gitignore)) { add('gitignore','.gitignore protection','warn','.gitignore was not found.','Run `token-guard install` to add local Token Guard paths to .gitignore.'); return; }
  const lines=fs.readFileSync(paths.gitignore,'utf8').split(/\r?\n/).map(line=>line.trim());
  const missing=REQUIRED_GITIGNORE_ENTRIES.filter(entry=>!lines.includes(entry));
  add('gitignore','.gitignore protection',missing.length===0?'pass':'warn',missing.length===0?'Local Token Guard files are ignored by git.':`Missing .gitignore entries: ${missing.join(', ')}`,'Run `token-guard install` or add the missing entries manually.');
}

function collectHookCommands(hooks) { const commands=[]; for (const groups of Object.values(hooks||{})) { if (!Array.isArray(groups)) continue; for (const group of groups) for (const hook of group.hooks||[]) if (hook.command) commands.push(String(hook.command)); } return commands; }
function relative(projectRoot,target){return path.relative(projectRoot,target).split(path.sep).join('/');}
