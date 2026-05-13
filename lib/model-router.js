import { estimateTokens } from './token-utils.js';

const PRICING = {
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-opus-4-5': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-haiku-4-0': { input: 1, output: 5 },
  'gpt-5-extra': { input: 20, output: 80 },
  'gpt-5': { input: 5, output: 20 },
  'gpt-5-mini': { input: 1, output: 4 },
  'gpt-5-nano': { input: 0.3, output: 1.2 }
};

const DEFAULT_PARENT = 'claude-opus-4-7';
const HINT_MIN_CHARS = 600;

const HEAVY_PATTERNS = [
  /\b(architect(ure|ural)?|hexagonal|layering|port[- ]?adapter|bounded[- ]?context|domain[- ]?driven|ddd)\b/i,
  /\badr[-_ ]?\d+\b/i,
  /\b(scope[- ]?decision|design[- ]?(doc|decision|review)|implementation[- ]?plan)\b/i,
  /\b(security|auth(n|z)?|crypto|signing|secret|key[- ]?management|csrf|xss|sql[- ]?injection|owasp)\b/i,
  /\b(migrat(e|ion)|breaking[- ]?change|downgrade|backwards?[- ]?compat)\b/i,
  /\b(cross[- ]?(file|service|module|package|domain)|multi[- ]?(file|service))\b.*\b(refactor|redesign|review|judge|decide)\b/i,
  /\b(refactor|redesign|restructure|rewrite)\b/i,
  /(重构|重写|重新设计|迁移|架构|安全审查)/,
  /(Refactoring|Architekt(ur|ural)|Sicherheits(audit|prüfung))/i,
  /\b(root[- ]?cause|race[- ]?condition|deadlock|memory[- ]?leak|data[- ]?loss|inconsistency)\b/i,
  /\b(irreversible|destructive|production[- ]?(deploy|push)|force[- ]?push|rm[- ]?rf|drop[- ]?table)\b/i
];

const LIGHT_LOOKUP_PATTERNS = [
  /^\s*(find|locate|search|grep|rg|where (is|are|does)|which (file|class|symbol|module))\b/i,
  /^\s*(what (file|path|class|symbol|method|line)|show (me )?the (path|file|line))\b/i,
  /\bpath[- ]?exists?\b/i,
  /\bsymbol[- ]?(search|lookup)\b/i,
  /\bglob\b.*\bpattern\b/i,
  /\blist (all|the) (files|classes|functions|methods|exports)\b/i
];

const LIGHT_MECHANICAL_PATTERNS = [
  /^\s*(rename|format|lint|prettify|reformat|fix[- ]?typo|fix[- ]?whitespace|sort[- ]?imports|prettier|eslint --fix)\b/i,
  /^\s*(commit (message)?|git status|push|stash)\b/i,
  /^\s*(generate|scaffold|stub out)\s+(a |an |the )?(boilerplate|test stub|mock|interface|type definition)\b/i
];

const LOOKUP_NEED_SIGNALS = [
  /\bacross (the )?(repo|codebase|services|modules|packages|project)\b/i,
  /\bin all (files|modules|services|packages|tests)\b/i,
  /\bevery (usage|reference|caller|callsite|implementation|occurrence) of\b/i,
  /\b(gather|collect) (info|context|references|usages|callers|implementations)\b/i,
  /\bscan(ning)? (the )?(repo|codebase|tree|project)\b/i,
  /\b(grep|search|find|locate) (all|every|each)\b/i,
  /\bcheck (all|every|each) (file|service|module|caller|usage)\b/i,
  /\b(list|enumerate) (all|every) (caller|usage|implementation|reference|file)\b/i,
  /(整个仓库|跨服务|全部 (调用|引用|使用)|查找所有|找出所有|扫描整个)/,
  /(im (gesamten|ganzen) (Repository|Repo|Codebase)|alle (Verwendungen|Aufrufe|Referenzen))/i
];

export function classifyPrompt(prompt = '') {
  const text = String(prompt || '');

  const isHeavy = HEAVY_PATTERNS.some(re => re.test(text));
  const hasLookupNeed = LOOKUP_NEED_SIGNALS.some(re => re.test(text)) || countDistinctSymbols(text) >= 2;

  if (isHeavy && hasLookupNeed) return 'heavy_with_lookup';
  if (isHeavy) return 'heavy';
  if (LIGHT_LOOKUP_PATTERNS.some(re => re.test(text))) return 'light_lookup';
  if (LIGHT_MECHANICAL_PATTERNS.some(re => re.test(text))) return 'light_mechanical';
  if (countCriteria(text) >= 2 && text.length < 4000) return 'fan_out';
  return 'ambiguous';
}

function countDistinctSymbols(text) {
  const camel = text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]*){1,}\b/g) || [];
  const backticked = text.match(/`[A-Za-z_][\w./-]{2,}`/g) || [];
  const set = new Set([...camel, ...backticked.map(s => s.replace(/`/g, ''))]);
  return set.size;
}

function countCriteria(text) {
  const akMatches = text.match(/\bAK[- ]?\d+\b/gi) || [];
  if (akMatches.length >= 2) return akMatches.length;

  const acMatches = text.match(/\bAC[- ]?\d+\b/g) || [];
  if (acMatches.length >= 2) return acMatches.length;

  const criterionMatches = text.match(/\b(acceptance[- ]?criter(ion|ia|ium)|akzeptanzkriteri(um|en))\b/gi) || [];
  if (criterionMatches.length >= 1) {
    const enumerated = (text.match(/^\s*(\d+[.)]\s|\-\s+\[ \])/gm) || []).length;
    if (enumerated >= 2) return enumerated;
  }

  return 0;
}

export function buildRoutingHint(prompt = '', config = {}) {
  if (config.modelRouter?.enabled === false) return null;

  const text = String(prompt || '').trim();
  const minChars = Number(config.modelRouter?.minPromptCharsForHint || HINT_MIN_CHARS);
  if (text.length < minChars) return null;

  const parent = config.modelRouter?.parentModel || DEFAULT_PARENT;
  const qualityFirst = config.modelRouter?.qualityFirst !== false;
  const klass = classifyPrompt(text);

  const preamble = 'Token Guard routing hint (quality > savings; default = keep current model):';

  if (klass === 'heavy_with_lookup') {
    return [
      preamble,
      `- Heavy task with parallel-able info gathering detected. Recommended pattern: ${parent} main axis + Explore subagents.`,
      `- Keep synthesis / judgment / writing / architecture-decisions on ${parent} (main thread).`,
      '- Spawn parallel `Agent(subagent_type="Explore")` per lookup target (grep, file-scan, symbol-locate, caller-enumeration). Read-only, cheaper, runs in parallel — saves wall-time.',
      '- Aggregate subagent results in main context, then judge. Do NOT let subagents make architecture/ADR/security calls.',
      '- Verify class/file/path names returned by subagents before depending on them (cheaper models can hallucinate plausibly).'
    ].join('\n');
  }

  if (klass === 'heavy') {
    return [
      preamble,
      `- Heavy signal detected (architecture / ADR / security / refactor / irreversible). Stay on ${parent}.`,
      '- DO NOT delegate this. Bad architecture/security calls cost more than tokens.',
      '- If you spawn a subagent for read-only lookup inside this task, verify class/file/path names before depending on them.'
    ].join('\n');
  }

  if (klass === 'light_lookup') {
    return [
      preamble,
      '- Pure-lookup signal (find / grep / where-is / list). Safe to delegate.',
      '- Prefer `Agent(subagent_type="Explore")` over `general-purpose` — read-only, fast, cheaper.',
      '- Verify returned paths/symbols exist before acting on them (subagent output can be stale or hallucinated).'
    ].join('\n');
  }

  if (klass === 'light_mechanical') {
    return [
      preamble,
      '- Mechanical-task signal (rename / format / lint / scaffold). Safe to delegate.',
      `- Use \`Agent(subagent_type="general-purpose", model="haiku")\` or \`model="sonnet"\` instead of ${parent}.`,
      '- Verify the diff before commit.'
    ].join('\n');
  }

  if (klass === 'fan_out') {
    return [
      preamble,
      '- Multiple acceptance criteria / AKs detected. Consider fan-out: one Agent per criterion in parallel.',
      `- Keep architecture/scope decisions on ${parent}; delegate per-criterion implementation/verification work to subagents.`,
      '- Aggregate results in main context, then verify cross-criterion consistency.'
    ].join('\n');
  }

  if (qualityFirst) return null;

  return [
    preamble,
    `- Ambiguous task. Default: keep current model (${parent}).`,
    '- Only delegate if you can name a clearly-light sub-step (lookup / format / rename / scaffold).',
    '- For Codex: same idea — gpt-5-extra only for heavy reasoning; gpt-5-mini/nano for trivial work.'
  ].join('\n');
}

export function recordSubagentDelegation(input = {}, response = {}, config = {}) {
  const toolInput = input.tool_input || input.toolInput || {};
  const rawChild = String(toolInput.model || toolInput.modelOverride || '').toLowerCase();
  const subagentType = toolInput.subagent_type || toolInput.subagentType || 'default';
  const parentModel = String(config.modelRouter?.parentModel || DEFAULT_PARENT).toLowerCase();
  const childModel = normalizeModelName(rawChild) || parentModel;

  const promptText = String(toolInput.prompt || toolInput.description || '');
  const responseText = typeof response === 'string'
    ? response
    : extractText(response).slice(0, 200000);

  const promptTokens = estimateTokens(promptText);
  const responseTokens = estimateTokens(responseText);
  const estimatedSubagentTokens = promptTokens + responseTokens + 500;

  const factor = savingsFactor(parentModel, childModel);
  const savedEquivalentTokens = Math.max(0, Math.round(estimatedSubagentTokens * factor));

  return {
    parentModel,
    childModel,
    subagentType,
    promptTokens,
    responseTokens,
    estimatedSubagentTokens,
    savedEquivalentTokens,
    savingsFactor: Number(factor.toFixed(3))
  };
}

export function normalizeModelName(name) {
  const raw = String(name || '').toLowerCase().trim();
  if (!raw) return '';
  if (PRICING[raw]) return raw;

  if (/opus/.test(raw)) return raw.includes('4-7') ? 'claude-opus-4-7' : 'claude-opus-4-7';
  if (/sonnet/.test(raw)) return 'claude-sonnet-4-6';
  if (/haiku/.test(raw)) return 'claude-haiku-4-5';
  if (/gpt-?5-?nano/.test(raw)) return 'gpt-5-nano';
  if (/gpt-?5-?mini/.test(raw)) return 'gpt-5-mini';
  if (/gpt-?5-?extra/.test(raw) || /extra\s*hoch/.test(raw)) return 'gpt-5-extra';
  if (/gpt-?5/.test(raw)) return 'gpt-5';
  return raw;
}

function savingsFactor(parentModel, childModel) {
  const parent = priceFor(parentModel);
  const child = priceFor(childModel);
  if (!parent || !child) return 0;
  if (child.input >= parent.input && child.output >= parent.output) return 0;

  const parentBlend = (parent.input + parent.output) / 2;
  const childBlend = (child.input + child.output) / 2;
  if (parentBlend <= 0) return 0;

  return Math.max(0, Math.min(0.99, 1 - childBlend / parentBlend));
}

function priceFor(model) {
  const key = String(model || '').toLowerCase();
  if (PRICING[key]) return PRICING[key];
  const match = Object.keys(PRICING).find(name => key.includes(name) || name.includes(key));
  return match ? PRICING[match] : null;
}

function extractText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);
  if (typeof value.stdout === 'string') return value.stdout;
  if (typeof value.text === 'string') return value.text;
  if (Array.isArray(value)) return value.map(extractText).join('\n');
  try { return JSON.stringify(value); } catch { return ''; }
}
