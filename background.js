import {
  CLAUDE_CODE_HAIKU_MODEL,
  CLAUDE_CODE_LOCAL_MODEL,
  DRAFT_PHASE_FULL,
  DRAFT_PHASE_QUICK,
  GEMINI_CLI_MODEL,
  GEMINI_CLI_LOCAL_MODEL,
  GEMINI_MODEL,
  TONE_DEFAULTS,
  buildAdaptiveDraftPrompt,
  buildManualDraftPrompt,
  callClaudeResult,
  callGeminiResult,
  callKimiResult,
  detectAutoDraftSkipReason,
  getBaseToneForStrategy,
  guessStrategyForTone,
  parseAdaptiveDraftResult
} from './lib/api.js';
import {
  callLocalClaudeCodeBridgeWithUsage,
  callLocalGeminiCliBridgeWithUsage,
  reportLocalBridgeTrace
} from './lib/local-cli.js';
import { summarizeTokenUsage } from './lib/token-usage.js';

const SETTINGS_CACHE = {
  value: null
};
const TONE_CACHE = new Map();
const QUICK_DRAFT_TIMEOUT_MS = 90000;
const FULL_DRAFT_TIMEOUT_MS = 120000;

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function formatDuration(ms) {
  return `${Math.round(ms)}ms`;
}

function logRequest(requestId, message, extra) {
  void reportLocalBridgeTrace({ requestId, message, extra, source: 'bg' });
  if (typeof extra === 'undefined') {
    console.log(`[XGA][bg][${requestId}] ${message}`);
    return;
  }
  console.log(`[XGA][bg][${requestId}] ${message}`, extra);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.settings) SETTINGS_CACHE.value = null;

  for (const key of Object.keys(changes)) {
    if (key.startsWith('tone_')) {
      TONE_CACHE.delete(key.replace(/^tone_/, ''));
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GENERATE_DRAFT') {
    handleGenerateDraft(msg).then(sendResponse).catch((error) => sendResponse({
      status: 'failed',
      reason: error.message
    }));
    return true;
  }

  if (msg.type === 'SAVE_COMPARISON') {
    handleSaveComparison(msg.tone, msg.entry).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'GET_TONE_DATA') {
    getToneData(msg.tone).then(sendResponse);
    return true;
  }

  if (msg.type === 'SYNC_TONE_TO_STORAGE') {
    chrome.storage.local.set({ [`tone_${msg.tone}`]: msg.data }).then(() => {
      TONE_CACHE.delete(msg.tone);
      sendResponse({ ok: true });
    });
    return true;
  }
});

function getDefaultSettings() {
  return {
    anthropicApiKey: '',
    moonshotApiKey: '',
    geminiApiKey: '',
    activeModel: GEMINI_CLI_LOCAL_MODEL,
    username: '',
    autoDraftsEnabled: true
  };
}

async function getSettings() {
  if (SETTINGS_CACHE.value) return SETTINGS_CACHE.value;
  const { settings } = await chrome.storage.local.get('settings');
  SETTINGS_CACHE.value = { ...getDefaultSettings(), ...settings };
  return SETTINGS_CACHE.value;
}

async function getToneData(tone) {
  if (TONE_CACHE.has(tone)) return TONE_CACHE.get(tone);
  const key = `tone_${tone}`;
  const result = await chrome.storage.local.get(key);
  const value = result[key] || { prompt: TONE_DEFAULTS[tone] || '', comparisons: [] };
  TONE_CACHE.set(tone, value);
  return value;
}

async function getAdaptiveToneDataMap() {
  const tones = ['supportive', 'question', 'smart', 'funny'];
  const entries = await Promise.all(tones.map(async (tone) => [tone, await getToneData(tone)]));
  return Object.fromEntries(entries);
}

function resolvePhaseTimeout(phase) {
  return phase === DRAFT_PHASE_FULL ? FULL_DRAFT_TIMEOUT_MS : QUICK_DRAFT_TIMEOUT_MS;
}

async function generateWithGeminiLocal({
  requestId,
  systemPrompt,
  userPrompt,
  tweetText,
  context,
  phase,
  mode
}) {
  return callLocalGeminiCliBridgeWithUsage({
    systemPrompt,
    userPrompt,
    tweetText,
    context,
    model: GEMINI_CLI_MODEL,
    requestId,
    timeoutMs: resolvePhaseTimeout(phase),
    mode,
    phase
  });
}

async function generateWithClaudeLocal({
  requestId,
  systemPrompt,
  userPrompt,
  tweetText,
  context,
  phase,
  mode
}) {
  return callLocalClaudeCodeBridgeWithUsage({
    systemPrompt,
    userPrompt,
    tweetText,
    context,
    model: CLAUDE_CODE_HAIKU_MODEL,
    requestId,
    timeoutMs: resolvePhaseTimeout(phase),
    mode,
    phase
  });
}

function getModelLabel(activeModel) {
  switch (activeModel) {
    case 'kimi-k2.5':
      return 'kimi';
    case 'claude-haiku':
    case CLAUDE_CODE_LOCAL_MODEL:
      return 'claude';
    default:
      return 'gemini';
  }
}

function resolveDraftModel(settings, requestedProvider) {
  const activeModel = requestedProvider === 'claude-local'
    ? CLAUDE_CODE_LOCAL_MODEL
    : requestedProvider === 'gemini-local'
      ? GEMINI_CLI_LOCAL_MODEL
      : (settings.activeModel || GEMINI_CLI_LOCAL_MODEL);

  return {
    activeModel,
    modelLabel: getModelLabel(activeModel)
  };
}

async function runDraftModel({
  settings,
  modelTarget,
  requestId,
  systemPrompt,
  userPrompt,
  tweetText,
  context,
  phase,
  mode
}) {
  switch (modelTarget.activeModel) {
    case CLAUDE_CODE_LOCAL_MODEL:
      return generateWithClaudeLocal({
        requestId,
        systemPrompt,
        userPrompt,
        tweetText,
        context,
        phase,
        mode
      });
    case GEMINI_CLI_LOCAL_MODEL:
      return generateWithGeminiLocal({
        requestId,
        systemPrompt,
        userPrompt,
        tweetText,
        context,
        phase,
        mode
      });
    case GEMINI_MODEL:
      if (!settings.geminiApiKey) throw new Error('Gemini API key not set');
      return callGeminiResult(settings.geminiApiKey, systemPrompt, userPrompt);
    case 'kimi-k2.5':
      if (!settings.moonshotApiKey) throw new Error('Moonshot API key not set');
      return callKimiResult(settings.moonshotApiKey, systemPrompt, userPrompt, settings.moonshotEndpoint);
    case 'claude-haiku':
      if (!settings.anthropicApiKey) throw new Error('Anthropic API key not set');
      return callClaudeResult(settings.anthropicApiKey, systemPrompt, userPrompt);
    default:
      throw new Error(`Unsupported active model: ${modelTarget.activeModel}`);
  }
}

async function handleGenerateAutoDraft(msg, requestId, settings, modelTarget) {
  const skipReason = detectAutoDraftSkipReason(msg.tweetText, msg.context);
  if (skipReason) {
    return {
      status: 'skipped',
      strategyType: null,
      baseTone: null,
      text: '',
      reason: skipReason,
      modelLabel: modelTarget.modelLabel,
      activeModel: modelTarget.activeModel
    };
  }

  const phase = msg.phase === DRAFT_PHASE_FULL ? DRAFT_PHASE_FULL : DRAFT_PHASE_QUICK;
  const toneDataByTone = phase === DRAFT_PHASE_FULL ? await getAdaptiveToneDataMap() : null;
  const { systemPrompt, userMessage } = buildAdaptiveDraftPrompt({
    tweetText: msg.tweetText,
    context: msg.context,
    phase,
    toneDataByTone
  });

  const modelResult = await runDraftModel({
    settings,
    modelTarget,
    requestId,
    systemPrompt,
    userPrompt: userMessage,
    tweetText: msg.tweetText,
    context: msg.context,
    phase,
    mode: 'auto'
  });
  const rawText = modelResult.text;

  return {
    ...parseAdaptiveDraftResult(rawText),
    tokenUsage: summarizeTokenUsage(modelResult.tokenUsage),
    modelLabel: modelTarget.modelLabel,
    activeModel: modelTarget.activeModel
  };
}

async function handleGenerateToneDraft(msg, requestId, settings, modelTarget) {
  const phase = msg.phase === DRAFT_PHASE_FULL ? DRAFT_PHASE_FULL : DRAFT_PHASE_QUICK;
  const toneData = await getToneData(msg.tone);
  const { systemPrompt, userMessage, baseTone } = buildManualDraftPrompt({
    tweetText: msg.tweetText,
    tone: msg.tone,
    toneData,
    context: msg.context,
    currentDraft: msg.currentDraft || '',
    baseToneHint: msg.baseToneHint || 'smart'
  });

  const modelResult = await runDraftModel({
    settings,
    modelTarget,
    requestId,
    systemPrompt,
    userPrompt: userMessage,
    tweetText: msg.tweetText,
    context: msg.context,
    phase,
    mode: 'tone'
  });
  const text = modelResult.text;

  const strategyType = msg.tone === 'enhance'
    ? guessStrategyForTone(baseTone, msg.strategyTypeHint || 'deep_share')
    : guessStrategyForTone(msg.tone, msg.strategyTypeHint || 'personal');

  return {
    status: 'ready',
    strategyType,
    baseTone: msg.tone === 'enhance' ? (msg.baseToneHint || baseTone || getBaseToneForStrategy(strategyType)) : baseTone,
    text: typeof text === 'string' ? text.trim() : '',
    reason: '',
    tokenUsage: summarizeTokenUsage(modelResult.tokenUsage),
    modelLabel: modelTarget.modelLabel,
    activeModel: modelTarget.activeModel
  };
}

async function handleGenerateDraft(msg) {
  const requestId = msg.requestId || `bg-${Date.now().toString(36)}`;
  const startedAt = nowMs();
  logRequest(requestId, 'Start generate draft', {
    mode: msg.mode || 'auto',
    tone: msg.tone || null,
    provider: msg.provider || 'gemini-local',
    phase: msg.phase || DRAFT_PHASE_QUICK,
    tweetLength: msg.tweetText?.length || 0
  });

  const settingsStartedAt = nowMs();
  const settings = await getSettings();
  const modelTarget = resolveDraftModel(settings, msg.provider);
  logRequest(requestId, `Loaded settings in ${formatDuration(nowMs() - settingsStartedAt)}`, {
    autoDraftsEnabled: settings.autoDraftsEnabled,
    activeModel: modelTarget.activeModel
  });

  if (settings.autoDraftsEnabled === false) {
    return {
      status: 'skipped',
      strategyType: null,
      baseTone: null,
      text: '',
      reason: 'Auto drafts are disabled in settings.',
      modelLabel: modelTarget.modelLabel,
      activeModel: modelTarget.activeModel
    };
  }

  try {
    const response = msg.mode === 'tone'
      ? await handleGenerateToneDraft(msg, requestId, settings, modelTarget)
      : await handleGenerateAutoDraft(msg, requestId, settings, modelTarget);

    logRequest(requestId, `Draft finished in ${formatDuration(nowMs() - startedAt)}`, {
      status: response.status,
      strategyType: response.strategyType,
      baseTone: response.baseTone,
      replyLength: response.text?.length || 0,
      tokenUsage: response.tokenUsage || null,
      activeModel: modelTarget.activeModel
    });
    return response;
  } catch (error) {
    logRequest(requestId, `Draft failed after ${formatDuration(nowMs() - startedAt)}`, {
      error: error.message,
      activeModel: modelTarget.activeModel
    });
    return {
      status: 'failed',
      strategyType: null,
      baseTone: null,
      text: '',
      reason: error.message,
      modelLabel: modelTarget.modelLabel,
      activeModel: modelTarget.activeModel
    };
  }
}

async function handleSaveComparison(tone, entry) {
  const toneData = await getToneData(tone);
  toneData.comparisons.push(entry);
  if (toneData.comparisons.length > 15) {
    toneData.comparisons = toneData.comparisons.slice(-15);
  }
  TONE_CACHE.set(tone, toneData);
  await chrome.storage.local.set({ [`tone_${tone}`]: toneData });
}

export {
  getDefaultSettings,
  getSettings,
  getToneData,
  handleGenerateDraft,
  handleSaveComparison
};
