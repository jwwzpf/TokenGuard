import { appendEvent } from './ledger.js';
import { saveConfig } from './project.js';
import { estimateTokens, hashText } from './token-utils.js';

const DEFAULT_TTL_MS = 20 * 60 * 1000;
const DEFAULT_MIN_PROMPT_CHARS = 18;

export function maybeSuggestPrecisionInput(projectRoot = process.cwd(), prompt = '', config = {}) {
  const precisionConfig = {
    enabled: true,
    ttlMs: DEFAULT_TTL_MS,
    minPromptChars: DEFAULT_MIN_PROMPT_CHARS,
    ...(config.precisionInput || {})
  };

  if (precisionConfig.enabled === false) {
    return {
      suggested: false,
      reason: 'disabled'
    };
  }

  const text = String(prompt || '').trim();

  if (text.length < Number(precisionConfig.minPromptChars || DEFAULT_MIN_PROMPT_CHARS)) {
    return {
      suggested: false,
      reason: 'prompt_too_short'
    };
  }

  if (userAskedToAvoidQuestions(text)) {
    return {
      suggested: false,
      reason: 'user_asked_to_avoid_questions'
    };
  }

  if (!isBroadExplorationRisk(text)) {
    return {
      suggested: false,
      reason: 'not_broad'
    };
  }

  if (hasUsefulStartingPoint(text)) {
    return {
      suggested: false,
      reason: 'has_starting_point'
    };
  }

  const hash = hashText(normalizePromptForHash(text)).slice(0, 16);
  const now = Date.now();
  const lastAt = config.state?.lastPrecisionInputAt
    ? Date.parse(config.state.lastPrecisionInputAt)
    : 0;

  const same = config.state?.lastPrecisionInputHash === hash;
  const withinTtl = lastAt && now - lastAt < Number(precisionConfig.ttlMs || DEFAULT_TTL_MS);

  if (same && withinTtl) {
    return {
      suggested: false,
      reason: 'deduped'
    };
  }

  const isChinese = containsChinese(text);
  const notice = isChinese
    ? 'Token Guard Precision Input Assistant: 这个任务范围比较大，直接全项目排查会消耗很多 token。为了帮用户省 token，请先问用户一个入口：错误日志、相关文件名、页面名、模块名或测试命令，任意一个都可以。除非你已经有一个安全的窄范围第一步。'
    : 'Token Guard Precision Input Assistant: This request is broad. Broad repo exploration can cost many tokens. To reduce the user’s token cost, ask for one starting point first: an error log, related file name, page/screen name, module name, or test command. Skip this if a safe narrow first step is obvious.';

  saveConfig(projectRoot, {
    ...config,
    state: {
      ...(config.state || {}),
      lastPrecisionInputHash: hash,
      lastPrecisionInputAt: new Date(now).toISOString()
    }
  });

  appendEvent(projectRoot, {
    type: 'precision_input_suggested',
    promptTokens: estimateTokens(text),
    estimatedAvoidableTokens: estimateAvoidableTokens(text),
    language: isChinese ? 'zh' : 'en',
    hash
  });

  return {
    suggested: true,
    reason: 'broad_request_without_starting_point',
    notice,
    overheadTokens: estimateTokens(notice),
    estimatedAvoidableTokens: estimateAvoidableTokens(text)
  };
}

function isBroadExplorationRisk(text) {
  const s = text.toLowerCase();

  const broadChinese =
    /(帮我|请你|能不能|可以不可以|看看|检查|排查|优化|改进|修复|解决|分析|评估|review|检查一下)/i.test(text) &&
    /(项目|代码|功能|问题|bug|错误|失败|性能|体验|结构|架构|页面|流程|逻辑|质量|上线|重构|测试)/i.test(text);

  const veryBroadChinese =
    /(帮我看看|检查一下|排查一下|优化一下|修一下|哪里有问题|为什么不行|不工作|有问题|报错了|失败了|性能不好|体验不好|帮我改进|帮我优化)/i.test(text);

  const broadEnglish =
    /\b(help|check|review|debug|fix|improve|optimize|analyze|investigate|look into|figure out)\b/i.test(s) &&
    /\b(project|codebase|bug|issue|problem|error|failure|performance|flow|logic|architecture|tests?|build|screen|page|feature)\b/i.test(s);

  const vagueEnglish =
    /\b(it fails|not working|broken|something is wrong|make it better|improve this|fix this|debug this|review this project)\b/i.test(s);

  const broadGerman =
    /\b(hilf|prüf|prüfen|analysier|analysieren|verbesser|optimier|debug|beheben|anschauen)\b/i.test(s) &&
    /\b(projekt|code|fehler|problem|bug|performance|test|build|seite|funktion)\b/i.test(s);

  return Boolean(broadChinese || veryBroadChinese || broadEnglish || vagueEnglish || broadGerman);
}

function hasUsefulStartingPoint(text) {
  const s = String(text || '');

  if (hasFilePath(s)) return true;
  if (hasCommand(s)) return true;
  if (hasErrorLog(s)) return true;
  if (hasCodeSymbol(s)) return true;
  if (hasUrlOrRoute(s)) return true;
  if (hasTestName(s)) return true;
  if (hasTicketId(s)) return true;

  return false;
}

function hasFilePath(text) {
  return /(?:\.{0,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:js|jsx|ts|tsx|dart|java|kt|py|go|rs|json|yaml|yml|xml|html|css|scss|md|sql|sh|log)|[A-Za-z0-9_.-]+\.(?:js|jsx|ts|tsx|dart|java|kt|py|go|rs|json|yaml|yml|xml|html|css|scss|md|sql|sh|log)/.test(text);
}

function hasCommand(text) {
  return /\b(npm|pnpm|yarn|node|git|mvn|mvnw|gradle|pytest|jest|vitest|flutter|docker|kubectl|java|python|python3|go test|cargo)\b/.test(text);
}

function hasErrorLog(text) {
  return /(Error:|Exception:|Traceback|BUILD FAILURE|BUILD SUCCESS|Tests run:|Failed tests?:|AssertionFailedError|Caused by:|exit code|npm ERR!|\[ERROR\]|panic:|fatal:)/i.test(text);
}

function hasCodeSymbol(text) {
  const codeTicks = text.match(/`([^`]{3,120})`/g) || [];

  if (codeTicks.length > 0) return true;

  return /\b[A-Za-z_$][A-Za-z0-9_$]{2,}\.(?:[A-Za-z_$][A-Za-z0-9_$]{2,})\b|\b[A-Za-z_$][A-Za-z0-9_$]{8,}\(\)?/.test(text);
}

function hasUrlOrRoute(text) {
  return /(https?:\/\/|\/api\/|\/v\d+\/|GET\s+\/|POST\s+\/|PUT\s+\/|DELETE\s+\/|route|endpoint)/i.test(text);
}

function hasTestName(text) {
  return /\b[A-Za-z0-9_$]+(?:Test|Tests|Spec)\b|测试命令|测试类|测试失败/.test(text);
}

function hasTicketId(text) {
  return /\b[A-Z][A-Z0-9]+-\d+\b|#\d{2,}/.test(text);
}

function userAskedToAvoidQuestions(text) {
  return /(不要问|别问|直接做|直接改|不要确认|不用确认|no questions|do not ask|don't ask|just do it|without asking)/i.test(text);
}

function containsChinese(text) {
  return /[\u3400-\u9FFF]/.test(text);
}

function normalizePromptForHash(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 1000);
}

function estimateAvoidableTokens(text) {
  const promptTokens = estimateTokens(text);

  if (promptTokens > 1200) return 15000;
  if (promptTokens > 600) return 10000;

  return 6000;
}
