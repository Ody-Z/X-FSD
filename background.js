import {
  CLAUDE_CODE_HAIKU_MODEL,
  CLAUDE_CODE_LOCAL_MODEL,
  DEFAULT_VOICE_PROFILE,
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
import {
  appendMetricsSnapshot,
  buildMetricsSnapshot,
  createReplyAnalyticsRecord,
  isEventDueForMetricSync,
  markAnalyticsSyncError
} from './lib/analytics.js';
import {
  getAllReplyEvents,
  putReplyEvent,
  updateReplyEvent
} from './lib/analytics-db.js';
import {
  buildXOAuthAuthorizeUrl,
  createPkcePair,
  exchangeXOAuthCode,
  fetchAuthenticatedUser,
  fetchTweetMetricsByIds,
  hasXApiUserToken,
  isXApiAuthError,
  refreshXOAuthToken,
  resolveReplyPostId,
  resolveReplyPostIds
} from './lib/x-api.js';

const SETTINGS_CACHE = {
  value: null
};
const TONE_CACHE = new Map();
const AUTO_PROMPT_CACHE = {
  value: null
};
const AUTO_PROMPT_DATA_KEY = 'prompt_auto';
const MAX_AUTO_COMPARISONS = 25;
const QUICK_DRAFT_TIMEOUT_MS = 90000;
const FULL_DRAFT_TIMEOUT_MS = 120000;
const ANALYTICS_SYNC_ALARM = 'xga_analytics_sync';
const ANALYTICS_SYNC_PERIOD_MINUTES = 60;
const X_OAUTH_REQUIRED_SCOPES = ['tweet.read', 'users.read'];

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
  if (changes[AUTO_PROMPT_DATA_KEY]) AUTO_PROMPT_CACHE.value = null;

  for (const key of Object.keys(changes)) {
    if (key.startsWith('tone_')) {
      TONE_CACHE.delete(key.replace(/^tone_/, ''));
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OPEN_POST_TAB') {
    handleOpenPostTab(msg.url).then(sendResponse).catch((error) => sendResponse({
      ok: false,
      reason: error.message
    }));
    return true;
  }

  if (msg.type === 'OPEN_ANALYTICS_DASHBOARD') {
    handleOpenAnalyticsDashboard().then(sendResponse).catch((error) => sendResponse({
      ok: false,
      reason: error.message
    }));
    return true;
  }

  if (msg.type === 'GET_X_OAUTH_CONFIG') {
    handleGetXOAuthConfig().then(sendResponse).catch((error) => sendResponse({
      ok: false,
      reason: error.message
    }));
    return true;
  }

  if (msg.type === 'START_X_OAUTH') {
    handleStartXOAuth(msg.clientId).then(sendResponse).catch((error) => sendResponse({
      ok: false,
      reason: error.message
    }));
    return true;
  }

  if (msg.type === 'DISCONNECT_X_OAUTH') {
    handleDisconnectXOAuth().then(sendResponse).catch((error) => sendResponse({
      ok: false,
      reason: error.message
    }));
    return true;
  }

  if (msg.type === 'GENERATE_DRAFT') {
    handleGenerateDraft(msg).then(sendResponse).catch((error) => sendResponse({
      status: 'failed',
      reason: error.message
    }));
    return true;
  }

  if (msg.type === 'RECORD_ANALYTICS_REPLY') {
    handleRecordAnalyticsReply(msg.entry).then(sendResponse).catch((error) => sendResponse({
      ok: false,
      reason: error.message
    }));
    return true;
  }

  if (msg.type === 'SYNC_ANALYTICS_METRICS') {
    handleSyncAnalyticsMetrics(msg.options || {}).then(sendResponse).catch((error) => sendResponse({
      ok: false,
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

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ANALYTICS_SYNC_ALARM) return;
    handleSyncAnalyticsMetrics({ limit: 50 }).catch((error) => {
      console.warn('[XGA][analytics] Scheduled metric sync failed', error);
    });
  });
}

if (chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    void ensureAnalyticsSyncAlarm();
  });
}

if (chrome.runtime?.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    void ensureAnalyticsSyncAlarm();
  });
}

function isAllowedXUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      (parsed.hostname === 'x.com' || parsed.hostname.endsWith('.x.com'));
  } catch {
    return false;
  }
}

async function handleOpenPostTab(url) {
  if (!isAllowedXUrl(url)) {
    throw new Error('Refusing to open a non-X post URL.');
  }

  await chrome.tabs.create({ url, active: true });
  return { ok: true };
}

async function handleOpenAnalyticsDashboard() {
  await chrome.tabs.create({
    url: chrome.runtime.getURL('analytics/analytics.html'),
    active: true
  });
  return { ok: true };
}

async function ensureAnalyticsSyncAlarm() {
  if (!chrome.alarms?.create) return;
  await chrome.alarms.create(ANALYTICS_SYNC_ALARM, {
    periodInMinutes: ANALYTICS_SYNC_PERIOD_MINUTES
  });
}

function getDefaultSettings() {
  return {
    anthropicApiKey: '',
    moonshotApiKey: '',
    geminiApiKey: '',
    xApiClientId: '',
    xApiUserAccessToken: '',
    xApiRefreshToken: '',
    xApiAccessTokenExpiresAt: 0,
    xApiConnectedAt: 0,
    xApiAuthorizedUsername: '',
    xApiScope: '',
    activeModel: GEMINI_CLI_LOCAL_MODEL,
    username: '',
    autoDraftsEnabled: true,
    onboardingCompleted: false,
    voiceProfile: DEFAULT_VOICE_PROFILE
  };
}

async function getSettings() {
  if (SETTINGS_CACHE.value) return SETTINGS_CACHE.value;
  const { settings } = await chrome.storage.local.get('settings');
  const defaults = getDefaultSettings();
  SETTINGS_CACHE.value = {
    ...defaults,
    ...settings,
    voiceProfile: {
      ...defaults.voiceProfile,
      ...(settings?.voiceProfile || {}),
      choiceSelections: {
        ...defaults.voiceProfile.choiceSelections,
        ...(settings?.voiceProfile?.choiceSelections || {})
      }
    }
  };
  return SETTINGS_CACHE.value;
}

async function saveSettingsPatch(patch) {
  const settings = await getSettings();
  const nextSettings = {
    ...settings,
    ...patch
  };
  SETTINGS_CACHE.value = nextSettings;
  await chrome.storage.local.set({ settings: nextSettings });
  return nextSettings;
}

function getXOAuthRedirectUri() {
  if (!chrome.identity?.getRedirectURL) {
    throw new Error('Chrome identity API is unavailable. Reload the extension after updating permissions.');
  }
  return chrome.identity.getRedirectURL('x-oauth');
}

function normalizeTokenExpiry(tokenResponse) {
  const expiresInSeconds = Number(tokenResponse?.expires_in);
  return Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
    ? Date.now() + expiresInSeconds * 1000
    : 0;
}

function assertXOAuthScopes(tokenResponse) {
  const rawScope = typeof tokenResponse?.scope === 'string' ? tokenResponse.scope : '';
  if (!rawScope) return;
  const grantedScopes = new Set(rawScope.split(/[\s,]+/).filter(Boolean));
  const missingScopes = X_OAUTH_REQUIRED_SCOPES.filter((scope) => !grantedScopes.has(scope));
  if (missingScopes.length > 0) {
    throw new Error(`X authorization is missing required scopes: ${missingScopes.join(', ')}.`);
  }
}

function summarizeXApiErrorBody(body) {
  if (!body || typeof body !== 'object') {
    return typeof body === 'string' ? body.slice(0, 240) : '';
  }

  const parts = [];
  const push = (label, value) => {
    if (typeof value === 'string' && value.trim()) parts.push(`${label}: ${value.trim()}`);
  };

  push('title', body.title);
  push('detail', body.detail);
  push('error', body.error);
  push('error_description', body.error_description);
  push('type', body.type);

  if (Array.isArray(body.errors)) {
    for (const error of body.errors.slice(0, 2)) {
      if (typeof error === 'string') {
        push('error', error);
      } else if (error && typeof error === 'object') {
        push('error', error.message || error.detail || error.title || error.code);
      }
    }
  }

  if (parts.length > 0) return parts.join('; ').slice(0, 320);

  try {
    return JSON.stringify(body).slice(0, 320);
  } catch {
    return '';
  }
}

function formatXOAuthStepError(step, error, extra = {}) {
  const status = Number.isFinite(error?.status) && error.status > 0 ? ` (${error.status})` : '';
  const bodySummary = summarizeXApiErrorBody(error?.body);
  const scope = typeof extra.scope === 'string' && extra.scope.trim()
    ? ` Granted scope: ${extra.scope.trim()}.`
    : '';
  const detail = bodySummary && bodySummary !== error?.message
    ? ` X response: ${bodySummary}.`
    : '';
  return `${step} failed${status}: ${error?.message || 'Unknown X API error.'}.${detail}${scope}`;
}

async function getFreshXApiSettings(settings = null) {
  const current = settings || await getSettings();
  const expiresAt = Number(current.xApiAccessTokenExpiresAt || 0);
  const needsRefresh = Boolean(
    current.xApiRefreshToken &&
    current.xApiClientId &&
    (!current.xApiUserAccessToken || !expiresAt || expiresAt - Date.now() <= 120000)
  );
  if (!needsRefresh) return current;

  let tokenResponse;
  try {
    tokenResponse = await refreshXOAuthToken({
      clientId: current.xApiClientId,
      refreshToken: current.xApiRefreshToken
    });
  } catch (error) {
    if (!isXApiAuthError(error)) throw error;
    await handleDisconnectXOAuth();
    throw new Error('X authorization expired. Reconnect X in the Analytics tab.');
  }

  return saveSettingsPatch({
    xApiUserAccessToken: tokenResponse.access_token || current.xApiUserAccessToken || '',
    xApiRefreshToken: tokenResponse.refresh_token || current.xApiRefreshToken || '',
    xApiAccessTokenExpiresAt: normalizeTokenExpiry(tokenResponse),
    xApiScope: tokenResponse.scope || current.xApiScope || ''
  });
}

async function launchWebAuthFlow(options) {
  if (!chrome.identity?.launchWebAuthFlow) {
    throw new Error('Chrome identity API is unavailable. Reload the extension after updating permissions.');
  }
  return chrome.identity.launchWebAuthFlow(options);
}

async function handleGetXOAuthConfig() {
  const settings = await getSettings();
  const redirectUri = getXOAuthRedirectUri();
  return {
    ok: true,
    redirectUri,
    connected: Boolean(settings.xApiUserAccessToken || settings.xApiRefreshToken),
    clientId: settings.xApiClientId || '',
    authorizedUsername: settings.xApiAuthorizedUsername || '',
    expiresAt: settings.xApiAccessTokenExpiresAt || 0,
    scope: settings.xApiScope || ''
  };
}

function parseOAuthRedirectUrl(redirectUrl, expectedState) {
  if (!redirectUrl) throw new Error('X authorization was cancelled.');
  const parsed = new URL(redirectUrl);
  const error = parsed.searchParams.get('error');
  if (error) throw new Error(parsed.searchParams.get('error_description') || error);

  const state = parsed.searchParams.get('state');
  if (!state || state !== expectedState) throw new Error('X authorization state did not match.');

  const code = parsed.searchParams.get('code');
  if (!code) throw new Error('X authorization did not return a code.');
  return code;
}

async function handleStartXOAuth(clientId) {
  const cleanClientId = String(clientId || '').trim();
  if (!cleanClientId) throw new Error('Paste your X API OAuth 2.0 Client ID first.');

  const redirectUri = getXOAuthRedirectUri();
  const state = `xga-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const { codeVerifier, codeChallenge } = await createPkcePair();
  const authUrl = buildXOAuthAuthorizeUrl({
    clientId: cleanClientId,
    redirectUri,
    state,
    codeChallenge
  });

  await saveSettingsPatch({ xApiClientId: cleanClientId });
  const redirectUrl = await launchWebAuthFlow({
    url: authUrl,
    interactive: true
  });
  const code = parseOAuthRedirectUrl(redirectUrl, state);
  let tokenResponse;
  try {
    tokenResponse = await exchangeXOAuthCode({
      clientId: cleanClientId,
      redirectUri,
      code,
      codeVerifier
    });
  } catch (error) {
    throw new Error(formatXOAuthStepError('X OAuth token exchange', error));
  }
  assertXOAuthScopes(tokenResponse);
  if (!tokenResponse.access_token) {
    throw new Error('X authorization did not return an access token.');
  }

  let user;
  try {
    user = await fetchAuthenticatedUser(tokenResponse.access_token);
  } catch (error) {
    console.warn('[XGA][analytics] X OAuth user verification failed', {
      status: error?.status || 0,
      body: error?.body || null,
      scope: tokenResponse.scope || ''
    });
    throw new Error(formatXOAuthStepError('X user token verification', error, {
      scope: tokenResponse.scope || ''
    }));
  }
  const authorizedUsername = user?.username || '';

  await saveSettingsPatch({
    xApiClientId: cleanClientId,
    xApiUserAccessToken: tokenResponse.access_token || '',
    xApiRefreshToken: tokenResponse.refresh_token || '',
    xApiAccessTokenExpiresAt: normalizeTokenExpiry(tokenResponse),
    xApiConnectedAt: Date.now(),
    xApiAuthorizedUsername: authorizedUsername,
    xApiScope: tokenResponse.scope || ''
  });

  await ensureAnalyticsSyncAlarm();
  return {
    ok: true,
    redirectUri,
    authorizedUsername,
    expiresAt: normalizeTokenExpiry(tokenResponse)
  };
}

async function handleDisconnectXOAuth() {
  await saveSettingsPatch({
    xApiUserAccessToken: '',
    xApiRefreshToken: '',
    xApiAccessTokenExpiresAt: 0,
    xApiConnectedAt: 0,
    xApiAuthorizedUsername: '',
    xApiScope: ''
  });
  return { ok: true };
}

async function resolveAnalyticsReplyIdentity(settings, event) {
  if (event.replyPostId || !hasXApiUserToken(settings)) return event;

  const resolved = await resolveReplyPostId({ settings, event });
  if (!resolved?.id) return event;

  return {
    ...event,
    replyPostId: resolved.id,
    replyTweetUrl: resolved.tweetUrl || event.replyTweetUrl || '',
    replyCreatedAt: resolved.createdAt || event.replyCreatedAt || 0
  };
}

async function handleRecordAnalyticsReply(entry = {}) {
  const settings = await getFreshXApiSettings();
  let event = createReplyAnalyticsRecord({
    ...entry,
    ownerUsername: settings.username || entry.ownerUsername || ''
  });

  try {
    event = await resolveAnalyticsReplyIdentity(settings, event);
  } catch (error) {
    event = markAnalyticsSyncError(event, error);
  }

  await putReplyEvent(event);
  await ensureAnalyticsSyncAlarm();
  void handleSyncAnalyticsMetrics({ limit: 50 }).catch((error) => {
    console.warn('[XGA][analytics] Auto metric sync after send failed', error);
  });
  return {
    ok: true,
    eventId: event.id,
    replyPostId: event.replyPostId || ''
  };
}

async function resolvePendingReplyIdentities(settings, events, now) {
  const resolvedByEventId = await resolveReplyPostIds({
    settings,
    events,
    maxResults: Math.max(20, Math.min(100, events.length * 2))
  });

  const resolvedEvents = [];
  for (const event of events) {
    if (event.replyPostId || !hasXApiUserToken(settings)) {
      resolvedEvents.push(event);
      continue;
    }

    try {
      const resolved = resolvedByEventId.get(event.id);
      const next = resolved?.id
        ? {
            ...event,
            replyPostId: resolved.id,
            replyTweetUrl: resolved.tweetUrl || event.replyTweetUrl || '',
            replyCreatedAt: resolved.createdAt || event.replyCreatedAt || 0
          }
        : event;
      if (next !== event) await putReplyEvent(next);
      resolvedEvents.push(next);
    } catch (error) {
      const failed = markAnalyticsSyncError(event, error, now);
      await putReplyEvent(failed);
      resolvedEvents.push(failed);
    }
  }
  return resolvedEvents;
}

async function handleSyncAnalyticsMetrics(options = {}) {
  try {
    const settings = await getFreshXApiSettings();
    if (!hasXApiUserToken(settings)) {
      return {
        ok: false,
        authRequired: true,
        reason: 'Connect X in the Analytics tab before metrics can sync.'
      };
    }

    const now = Date.now();
    const force = options.force === true;
    const limit = Number.isFinite(options.limit) ? options.limit : 50;
    const allEvents = await getAllReplyEvents();
    const recentlySent = allEvents
      .filter((event) => !event.replyPostId)
      .sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0))
      .slice(0, Math.max(20, Math.min(100, limit)));
    const resolvedEvents = await resolvePendingReplyIdentities(settings, recentlySent, now);
    const eventById = new Map(allEvents.map((event) => [event.id, event]));
    for (const event of resolvedEvents) eventById.set(event.id, event);

    const dueEvents = Array.from(eventById.values())
      .filter((event) => isEventDueForMetricSync(event, now, force))
      .sort((a, b) => (a.sync?.nextAttemptAt || a.sentAt || 0) - (b.sync?.nextAttemptAt || b.sentAt || 0))
      .slice(0, limit);

    if (dueEvents.length === 0) {
      return {
        ok: true,
        synced: 0,
        resolvedReplyIds: resolvedEvents.filter((event) => event.replyPostId).length,
        privateMetricsAvailable: null
      };
    }

    const { tweets, privateMetricsAvailable, warning } = await fetchTweetMetricsByIds(
      dueEvents.map((event) => event.replyPostId),
      settings
    );
    const tweetById = new Map(tweets.map((tweet) => [tweet.id, tweet]));
    let synced = 0;

    for (const event of dueEvents) {
      const tweet = tweetById.get(event.replyPostId);
      if (!tweet) {
        await updateReplyEvent(event.id, (current) => markAnalyticsSyncError(current, new Error('X API did not return this reply post.'), now));
        continue;
      }

      const snapshot = buildMetricsSnapshot(
        tweet,
        now,
        privateMetricsAvailable ? 'x-api-v2' : 'x-api-v2-public'
      );
      await updateReplyEvent(event.id, (current) => appendMetricsSnapshot(current, snapshot));
      synced += 1;
    }

    return {
      ok: true,
      synced,
      requested: dueEvents.length,
      resolvedReplyIds: resolvedEvents.filter((event) => event.replyPostId).length,
      privateMetricsAvailable,
      warning: warning || ''
    };
  } catch (error) {
    if (isXApiAuthError(error) || /authorization expired|unauthorized|unauthorised/i.test(error?.message || '')) {
      await handleDisconnectXOAuth();
      return {
        ok: false,
        authRequired: true,
        reason: 'X authorization expired. Reconnect X in the Analytics tab.'
      };
    }
    throw error;
  }
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

function normalizeAutoPromptData(data) {
  return {
    comparisons: Array.isArray(data?.comparisons)
      ? data.comparisons.slice(-MAX_AUTO_COMPARISONS)
      : []
  };
}

async function getAutoPromptData() {
  if (AUTO_PROMPT_CACHE.value) return AUTO_PROMPT_CACHE.value;

  const result = await chrome.storage.local.get(AUTO_PROMPT_DATA_KEY);
  if (result[AUTO_PROMPT_DATA_KEY]) {
    AUTO_PROMPT_CACHE.value = normalizeAutoPromptData(result[AUTO_PROMPT_DATA_KEY]);
    return AUTO_PROMPT_CACHE.value;
  }

  const legacyToneData = await getAdaptiveToneDataMap();
  const comparisons = Object.entries(legacyToneData)
    .flatMap(([tone, data]) => (data.comparisons || []).map((entry) => ({
      ...entry,
      baseTone: entry.baseTone || tone
    })))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .slice(-MAX_AUTO_COMPARISONS);

  AUTO_PROMPT_CACHE.value = { comparisons };
  return AUTO_PROMPT_CACHE.value;
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
      return callGeminiResult(settings.geminiApiKey, systemPrompt, userPrompt, context);
    case 'kimi-k2.5':
      if (!settings.moonshotApiKey) throw new Error('Moonshot API key not set');
      return callKimiResult(settings.moonshotApiKey, systemPrompt, userPrompt, settings.moonshotEndpoint);
    case 'claude-haiku':
      if (!settings.anthropicApiKey) throw new Error('Anthropic API key not set');
      return callClaudeResult(settings.anthropicApiKey, systemPrompt, userPrompt, context);
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
  const autoPromptData = phase === DRAFT_PHASE_FULL ? await getAutoPromptData() : null;
  const { systemPrompt, userMessage } = buildAdaptiveDraftPrompt({
    tweetText: msg.tweetText,
    context: msg.context,
    phase,
    autoPromptData,
    voiceProfile: settings.voiceProfile
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
    baseToneHint: msg.baseToneHint || 'smart',
    voiceProfile: settings.voiceProfile
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
  const autoPromptData = await getAutoPromptData();
  autoPromptData.comparisons.push({
    ...entry,
    baseTone: entry.baseTone || (tone === 'auto' ? null : tone)
  });
  autoPromptData.comparisons = autoPromptData.comparisons.slice(-MAX_AUTO_COMPARISONS);
  AUTO_PROMPT_CACHE.value = autoPromptData;
  await chrome.storage.local.set({ [AUTO_PROMPT_DATA_KEY]: autoPromptData });
}

export {
  getDefaultSettings,
  getSettings,
  getToneData,
  handleGenerateDraft,
  handleRecordAnalyticsReply,
  handleSyncAnalyticsMetrics,
  handleSaveComparison
};
