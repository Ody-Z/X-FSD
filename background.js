import { generateReply, TONE_DEFAULTS } from './lib/api.js';

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
  const { settings } = await chrome.storage.local.get('settings');
  const mergedSettings = { ...getDefaultSettings(), ...settings };
  const toneData = await getToneData(msg.tone);

  try {
    const text = await generateReply(msg.tweetText, msg.tone, toneData, mergedSettings, msg.context);
    return { text };
  } catch (e) {
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
