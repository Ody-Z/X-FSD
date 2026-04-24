const TOKEN_USAGE_CSV_COLUMNS = [
  'timestamp',
  'requestId',
  'provider',
  'model',
  'mode',
  'phase',
  'status',
  'strategyType',
  'baseTone',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
  'estimated',
  'source',
  'promptChars',
  'systemPromptChars',
  'userPromptChars',
  'replyChars',
  'durationMs',
  'error'
];

function asFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function pickNumber(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    const value = asFiniteNumber(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function normalizeTokenUsage({
  inputTokens = null,
  outputTokens = null,
  totalTokens = null,
  cacheCreationInputTokens = null,
  cacheReadInputTokens = null,
  estimated = false,
  source = 'provider'
} = {}) {
  const normalizedInput = asFiniteNumber(inputTokens);
  const normalizedOutput = asFiniteNumber(outputTokens);
  const normalizedCacheCreation = asFiniteNumber(cacheCreationInputTokens);
  const normalizedCacheRead = asFiniteNumber(cacheReadInputTokens);
  const normalizedTotal = asFiniteNumber(totalTokens) ??
    (normalizedInput !== null || normalizedOutput !== null
      ? (normalizedInput || 0) + (normalizedOutput || 0)
      : null);

  if (
    normalizedInput === null &&
    normalizedOutput === null &&
    normalizedTotal === null &&
    normalizedCacheCreation === null &&
    normalizedCacheRead === null
  ) {
    return null;
  }

  return {
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    totalTokens: normalizedTotal,
    cacheCreationInputTokens: normalizedCacheCreation,
    cacheReadInputTokens: normalizedCacheRead,
    estimated: Boolean(estimated),
    source
  };
}

function estimateTokenCount(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return 0;
  return Math.ceil(value.length / 4);
}

function createEstimatedTokenUsage({ systemPrompt = '', userPrompt = '', prompt = '', outputText = '' } = {}) {
  const inputText = prompt || [systemPrompt, userPrompt].filter(Boolean).join('\n');
  return normalizeTokenUsage({
    inputTokens: estimateTokenCount(inputText),
    outputTokens: estimateTokenCount(outputText),
    estimated: true,
    source: 'estimated'
  });
}

function extractAnthropicTokenUsage(payload) {
  const usage = payload?.usage;
  if (!usage || typeof usage !== 'object') return null;

  return normalizeTokenUsage({
    inputTokens: usage.input_tokens ?? usage.inputTokens,
    outputTokens: usage.output_tokens ?? usage.outputTokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? usage.cacheReadInputTokens,
    source: 'anthropic'
  });
}

function extractOpenAiTokenUsage(payload, source = 'openai-compatible') {
  const usage = payload?.usage;
  if (!usage || typeof usage !== 'object') return null;

  return normalizeTokenUsage({
    inputTokens: usage.prompt_tokens ?? usage.promptTokens,
    outputTokens: usage.completion_tokens ?? usage.completionTokens,
    totalTokens: usage.total_tokens ?? usage.totalTokens,
    source
  });
}

function extractGeminiTokenUsage(payload) {
  const usage = payload?.usageMetadata || payload?.usage;
  if (!usage || typeof usage !== 'object') return null;

  return normalizeTokenUsage({
    inputTokens: usage.promptTokenCount ?? usage.prompt_token_count ?? usage.prompt_tokens ?? usage.promptTokens,
    outputTokens: usage.candidatesTokenCount ?? usage.candidates_token_count ?? usage.completion_tokens ?? usage.completionTokens,
    totalTokens: usage.totalTokenCount ?? usage.total_token_count ?? usage.total_tokens ?? usage.totalTokens,
    source: 'gemini'
  });
}

function hasTokenLikeKey(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).some((key) => /token/i.test(key));
}

function findUsageLikeObject(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return null;

  if (hasTokenLikeKey(value)) {
    const usage = normalizeTokenUsage({
      inputTokens: pickNumber(value, [
        'input_tokens',
        'inputTokens',
        'prompt_tokens',
        'promptTokens',
        'prompt_token_count',
        'promptTokenCount',
        'inputTokenCount',
        'totalInputTokens'
      ]),
      outputTokens: pickNumber(value, [
        'output_tokens',
        'outputTokens',
        'completion_tokens',
        'completionTokens',
        'completion_token_count',
        'candidatesTokenCount',
        'candidates_token_count',
        'outputTokenCount',
        'completionTokenCount',
        'totalOutputTokens'
      ]),
      totalTokens: pickNumber(value, [
        'total_tokens',
        'totalTokens',
        'total_token_count',
        'totalTokenCount'
      ]),
      cacheCreationInputTokens: pickNumber(value, [
        'cache_creation_input_tokens',
        'cacheCreationInputTokens'
      ]),
      cacheReadInputTokens: pickNumber(value, [
        'cache_read_input_tokens',
        'cacheReadInputTokens'
      ]),
      source: 'provider'
    });
    if (usage) return usage;
  }

  const preferredKeys = ['usage', 'usageMetadata', 'tokenUsage', 'stats', 'models'];
  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const found = findUsageLikeObject(value[key], depth + 1);
      if (found) return found;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUsageLikeObject(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const item of Object.values(value)) {
    const found = findUsageLikeObject(item, depth + 1);
    if (found) return found;
  }

  return null;
}

function extractGenericTokenUsage(payload, source = 'provider') {
  const usage = findUsageLikeObject(payload);
  if (!usage) return null;
  return { ...usage, source };
}

function extractGeminiCliStatsTokenUsage(payload) {
  const models = payload?.stats?.models;
  if (!models || typeof models !== 'object') return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cacheReadInputTokens = 0;
  let found = false;

  for (const modelStats of Object.values(models)) {
    const tokens = modelStats?.tokens;
    if (!tokens || typeof tokens !== 'object') continue;

    const input = asFiniteNumber(tokens.input) ??
      asFiniteNumber(tokens.prompt) ??
      asFiniteNumber(tokens.promptTokenCount);
    const output = asFiniteNumber(tokens.candidates) ??
      asFiniteNumber(tokens.output) ??
      asFiniteNumber(tokens.candidatesTokenCount);
    const total = asFiniteNumber(tokens.total) ??
      asFiniteNumber(tokens.totalTokenCount);
    const cached = asFiniteNumber(tokens.cached) ??
      asFiniteNumber(tokens.cachedContentTokenCount);

    if (input !== null || output !== null || total !== null || cached !== null) {
      found = true;
      inputTokens += input || 0;
      outputTokens += output || 0;
      totalTokens += total || ((input || 0) + (output || 0));
      cacheReadInputTokens += cached || 0;
    }
  }

  if (!found) return null;

  return normalizeTokenUsage({
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadInputTokens,
    source: 'gemini-cli'
  });
}

function summarizeTokenUsage(tokenUsage) {
  if (!tokenUsage) return null;
  return {
    inputTokens: tokenUsage.inputTokens,
    outputTokens: tokenUsage.outputTokens,
    totalTokens: tokenUsage.totalTokens,
    cacheCreationInputTokens: tokenUsage.cacheCreationInputTokens,
    cacheReadInputTokens: tokenUsage.cacheReadInputTokens,
    estimated: Boolean(tokenUsage.estimated),
    source: tokenUsage.source || 'provider'
  };
}

function csvEscape(value) {
  if (value === null || typeof value === 'undefined') return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildTokenUsageCsvHeader() {
  return TOKEN_USAGE_CSV_COLUMNS.join(',');
}

function buildTokenUsageCsvRow(entry = {}) {
  const tokenUsage = entry.tokenUsage || {};
  const row = {
    timestamp: entry.timestamp || new Date().toISOString(),
    requestId: entry.requestId || '',
    provider: entry.provider || '',
    model: entry.model || entry.activeModel || '',
    mode: entry.mode || '',
    phase: entry.phase || '',
    status: entry.status || '',
    strategyType: entry.strategyType || '',
    baseTone: entry.baseTone || '',
    inputTokens: tokenUsage.inputTokens,
    outputTokens: tokenUsage.outputTokens,
    totalTokens: tokenUsage.totalTokens,
    cacheCreationInputTokens: tokenUsage.cacheCreationInputTokens,
    cacheReadInputTokens: tokenUsage.cacheReadInputTokens,
    estimated: tokenUsage.estimated ? 'true' : 'false',
    source: tokenUsage.source || '',
    promptChars: entry.promptChars,
    systemPromptChars: entry.systemPromptChars,
    userPromptChars: entry.userPromptChars,
    replyChars: entry.replyChars,
    durationMs: entry.durationMs,
    error: entry.error || ''
  };

  return TOKEN_USAGE_CSV_COLUMNS.map((column) => csvEscape(row[column])).join(',');
}

export {
  TOKEN_USAGE_CSV_COLUMNS,
  buildTokenUsageCsvHeader,
  buildTokenUsageCsvRow,
  createEstimatedTokenUsage,
  estimateTokenCount,
  extractAnthropicTokenUsage,
  extractGeminiTokenUsage,
  extractGeminiCliStatsTokenUsage,
  extractGenericTokenUsage,
  extractOpenAiTokenUsage,
  normalizeTokenUsage,
  summarizeTokenUsage
};
