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

export function buildRoutingHint(prompt = '', config = {}) {
  if (config.modelRouter?.enabled === false) return null;

  const text = String(prompt || '').trim();
  const minChars = Number(config.modelRouter?.minPromptCharsForHint || HINT_MIN_CHARS);
  if (text.length < minChars) return null;

  if (/^\s*(commit|format|rename|lint|status)\b/i.test(text) && text.length < 200) return null;

  const parent = config.modelRouter?.parentModel || DEFAULT_PARENT;

  return [
    'Token Guard model routing hint:',
    `- This session likely runs ${parent} (most expensive tier). Do NOT use it for trivial sub-tasks.`,
    '- Classify THIS task yourself — heavy (architecture, multi-file refactor, root-cause debug, security audit) vs light (rename, format, single-file edit, log scan, commit message, doc lookup, status check) vs mixed.',
    '- For light or trivial sub-parts, delegate via the Agent tool with a cheaper model parameter: `Agent(subagent_type="general-purpose", model="haiku")` or `model="sonnet"`. Subagent summary returns to main context, saving both subagent cost and main-context tokens.',
    '- For Codex: same idea — pick gpt-5-extra only for heavy reasoning; use gpt-5-mini/nano for trivial work.',
    '- Token Guard cannot switch the main-session model (host limitation). Token Guard only reminds you to classify and delegate.',
    '- Token Guard tracks every subagent delegation and reports opus-equivalent token savings in the weekly report.',
    '- DO NOT delegate work that requires deep cross-file reasoning, security judgment, or destructive ops — bad delegation costs more than running heavy here.'
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
