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

  if (msg.type === 'SET_ALARM') {
    setPostAlarm(msg.postId, msg.time);
    sendResponse({ ok: true });
  }

  if (msg.type === 'CLEAR_ALARM') {
    chrome.alarms.clear(`post_${msg.postId}`);
    sendResponse({ ok: true });
  }

  if (msg.type === 'POST_PUBLISHED') {
    handlePostPublished(msg.postId);
    sendResponse({ ok: true });
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
    const text = await generateReply(msg.tweetText, msg.tone, toneData, mergedSettings);
    return { text };
  } catch (e) {
    return { error: e.message };
  }
}

function getDefaultSettings() {
  return {
    anthropicApiKey: '',
    moonshotApiKey: '',
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

// --- Scheduling ---
function setPostAlarm(postId, time) {
  chrome.alarms.create(`post_${postId}`, { when: time });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('post_')) return;
  const postId = alarm.name.replace('post_', '');

  const { scheduledPosts } = await chrome.storage.local.get('scheduledPosts');
  const posts = scheduledPosts || [];
  const post = posts.find(p => p.id === postId);

  if (!post || post.status !== 'pending') return;

  await chrome.storage.local.set({ postToPublish: { id: postId, text: post.text } });

  const tab = await chrome.tabs.create({
    url: 'https://x.com/compose/post',
    active: true
  });

  chrome.notifications.create(`posted_${postId}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'X Growth Assistant',
    message: 'Publishing your scheduled post...'
  });
});

async function handlePostPublished(postId) {
  const { scheduledPosts } = await chrome.storage.local.get('scheduledPosts');
  const posts = scheduledPosts || [];
  const idx = posts.findIndex(p => p.id === postId);
  if (idx !== -1) {
    posts[idx].status = 'posted';
    await chrome.storage.local.set({ scheduledPosts: posts });
  }

  chrome.notifications.create(`done_${postId}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'X Growth Assistant',
    message: 'Post published successfully!'
  });
}

// --- Re-register alarms on service worker wake ---
chrome.runtime.onStartup.addListener(async () => {
  const { scheduledPosts } = await chrome.storage.local.get('scheduledPosts');
  const posts = scheduledPosts || [];
  for (const post of posts) {
    if (post.status === 'pending' && post.scheduledTime > Date.now()) {
      setPostAlarm(post.id, post.scheduledTime);
    }
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const { scheduledPosts } = await chrome.storage.local.get('scheduledPosts');
  const posts = scheduledPosts || [];
  for (const post of posts) {
    if (post.status === 'pending' && post.scheduledTime > Date.now()) {
      setPostAlarm(post.id, post.scheduledTime);
    }
  }
});
