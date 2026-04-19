import { buildReplyPrompt, GEMINI_CLI_LOCAL_MODEL, GEMINI_CLI_MODEL, generateReply, TONE_DEFAULTS } from './lib/api.js';
import { callLocalGeminiCliBridge, reportLocalBridgeTrace } from './lib/local-cli.js';

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

// --- Message Handler ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GENERATE_REPLY') {
    handleGenerateReply(msg).then(sendResponse).catch(e => sendResponse({ error: e.message }));
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
    chrome.storage.local.set({ [`tone_${msg.tone}`]: msg.data }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// --- Reply Generation ---
async function handleGenerateReply(msg) {
  const requestId = msg.requestId || `bg-${Date.now().toString(36)}`;
  const startedAt = nowMs();
  logRequest(requestId, 'Start generate', {
    tone: msg.tone,
    modelHint: msg.model,
    tweetLength: msg.tweetText?.length || 0
  });

  const settingsStartedAt = nowMs();
  const { settings } = await chrome.storage.local.get('settings');
  const mergedSettings = { ...getDefaultSettings(), ...settings };
  logRequest(requestId, `Loaded settings in ${formatDuration(nowMs() - settingsStartedAt)}`, {
    activeModel: mergedSettings.activeModel
  });

  const toneDataStartedAt = nowMs();
  const toneData = await getToneData(msg.tone);
  logRequest(requestId, `Loaded tone data in ${formatDuration(nowMs() - toneDataStartedAt)}`, {
    comparisons: toneData?.comparisons?.length || 0
  });

  try {
    if (mergedSettings.activeModel === GEMINI_CLI_LOCAL_MODEL) {
      const promptStartedAt = nowMs();
      const { systemPrompt } = buildReplyPrompt(msg.tweetText, msg.tone, toneData, msg.context);
      logRequest(requestId, `Built CLI prompt in ${formatDuration(nowMs() - promptStartedAt)}`, {
        systemPromptLength: systemPrompt.length
      });

      const cliStartedAt = nowMs();
      const text = await callLocalGeminiCliBridge({
        systemPrompt,
        tweetText: msg.tweetText,
        context: msg.context,
        model: GEMINI_CLI_MODEL,
        requestId
      });
      logRequest(requestId, `Local Gemini CLI finished in ${formatDuration(nowMs() - cliStartedAt)}`, {
        replyLength: text.length
      });
      logRequest(requestId, `Total generate finished in ${formatDuration(nowMs() - startedAt)}`);
      return { text };
    }

    const modelStartedAt = nowMs();
    const text = await generateReply(msg.tweetText, msg.tone, toneData, mergedSettings, msg.context);
    logRequest(requestId, `Remote model finished in ${formatDuration(nowMs() - modelStartedAt)}`, {
      activeModel: mergedSettings.activeModel,
      replyLength: text.length
    });
    logRequest(requestId, `Total generate finished in ${formatDuration(nowMs() - startedAt)}`);
    return { text };
  } catch (e) {
    logRequest(requestId, `Generate failed after ${formatDuration(nowMs() - startedAt)}`, {
      error: e.message
    });
    return { error: e.message };
  }
}

function getDefaultSettings() {
  return {
    anthropicApiKey: '',
    moonshotApiKey: '',
    geminiApiKey: '',
    activeModel: 'claude-haiku',
    username: ''
  };
}

// --- Tone Data (chrome.storage.local cache) ---
async function getToneData(tone) {
  const key = `tone_${tone}`;
  const result = await chrome.storage.local.get(key);
  return result[key] || { prompt: TONE_DEFAULTS[tone] || '', comparisons: [] };
}

async function handleSaveComparison(tone, entry) {
  const toneData = await getToneData(tone);
  toneData.comparisons.push(entry);
  if (toneData.comparisons.length > 15) {
    toneData.comparisons = toneData.comparisons.slice(-15);
  }
  await chrome.storage.local.set({ [`tone_${tone}`]: toneData });
}
