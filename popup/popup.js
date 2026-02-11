import { TONE_DEFAULTS } from '../lib/api.js';

const DB_NAME = 'xGrowthFS';
const STORE_NAME = 'dirHandles';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveDirHandle(handle) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(handle, 'toneDir');
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function getDirHandle() {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const req = tx.objectStore(STORE_NAME).get('toneDir');
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function verifyPermission(handle) {
  if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

async function readToneFile(dirHandle, tone) {
  try {
    const fileHandle = await dirHandle.getFileHandle(`${tone}.json`);
    const file = await fileHandle.getFile();
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

async function writeToneFile(dirHandle, tone, data) {
  const fileHandle = await dirHandle.getFileHandle(`${tone}.json`, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(data, null, 2));
  await writable.close();
}

// --- Tab Navigation ---
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
});

// --- Settings ---
async function loadSettings() {
  const settings = await StorageHelper.getSettings();
  document.getElementById('username').value = settings.username || '';
  document.getElementById('activeModel').value = settings.activeModel || 'claude-haiku';
  document.getElementById('anthropicApiKey').value = settings.anthropicApiKey || '';
  document.getElementById('moonshotApiKey').value = settings.moonshotApiKey || '';
  document.getElementById('moonshotEndpoint').value = settings.moonshotEndpoint || 'https://api.moonshot.cn/v1';

  const handle = await getDirHandle();
  if (handle) {
    document.getElementById('folderPath').textContent = handle.name;
  }
}

document.getElementById('saveSettings').addEventListener('click', async () => {
  const status = document.getElementById('settingsStatus');
  try {
    await StorageHelper.saveSettings({
      username: document.getElementById('username').value.replace('@', ''),
      activeModel: document.getElementById('activeModel').value,
      anthropicApiKey: document.getElementById('anthropicApiKey').value,
      moonshotApiKey: document.getElementById('moonshotApiKey').value,
      moonshotEndpoint: document.getElementById('moonshotEndpoint').value
    });
    status.textContent = 'Settings saved';
    status.className = 'status success';
  } catch (e) {
    status.textContent = e.message;
    status.className = 'status error';
  }
  setTimeout(() => { status.textContent = ''; }, 2000);
});

document.getElementById('pickFolder').addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await saveDirHandle(handle);
    document.getElementById('folderPath').textContent = handle.name;
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('Folder picker error:', e);
    }
  }
});

// --- Tones ---
async function renderTones() {
  const container = document.getElementById('tonesList');
  const handle = await getDirHandle();

  if (!handle) {
    container.innerHTML = '<div class="empty-state">Pick a folder in Settings first</div>';
    return;
  }

  const granted = await verifyPermission(handle);
  if (!granted) {
    container.innerHTML = '<div class="empty-state">Folder access denied. Re-pick in Settings.</div>';
    return;
  }

  const tones = Object.keys(TONE_DEFAULTS);
  const cards = [];

  for (const tone of tones) {
    const data = await readToneFile(handle, tone);
    const count = data?.comparisons?.length || 0;
    cards.push(`
      <div class="tone-card">
        <span class="tone-name">${tone}</span>
        <span class="tone-count">${count}/15 comparisons</span>
      </div>`);
  }

  container.innerHTML = cards.length ? cards.join('') : '<div class="empty-state">No tone files found. Click Initialize below.</div>';
}

document.getElementById('initTones').addEventListener('click', async () => {
  const status = document.getElementById('tonesStatus');
  const handle = await getDirHandle();

  if (!handle) {
    showStatus(status, 'Pick a folder in Settings first', 'error');
    return;
  }

  const granted = await verifyPermission(handle);
  if (!granted) {
    showStatus(status, 'Folder access denied', 'error');
    return;
  }

  for (const [tone, prompt] of Object.entries(TONE_DEFAULTS)) {
    const existing = await readToneFile(handle, tone);
    if (!existing) {
      await writeToneFile(handle, tone, { prompt, comparisons: [] });
    }
  }

  showStatus(status, 'Tone files initialized', 'success');
  renderTones();
});

// --- Tone File <-> Chrome Storage Sync ---
async function syncTonesToStorage() {
  const handle = await getDirHandle();
  if (!handle) return;

  try {
    const granted = await verifyPermission(handle);
    if (!granted) return;
  } catch {
    return;
  }

  for (const tone of Object.keys(TONE_DEFAULTS)) {
    const fileData = await readToneFile(handle, tone);
    if (!fileData) continue;

    const storageKey = `tone_${tone}`;
    const result = await chrome.storage.local.get(storageKey);
    const storageData = result[storageKey];

    if (storageData && storageData.comparisons?.length > (fileData.comparisons?.length || 0)) {
      const merged = { ...fileData, comparisons: storageData.comparisons.slice(-15) };
      await writeToneFile(handle, tone, merged);
      await chrome.storage.local.set({ [storageKey]: merged });
    } else {
      await chrome.storage.local.set({ [storageKey]: fileData });
    }
  }
}

async function syncStorageToFiles() {
  const handle = await getDirHandle();
  if (!handle) return;

  try {
    const granted = await verifyPermission(handle);
    if (!granted) return;
  } catch {
    return;
  }

  for (const tone of Object.keys(TONE_DEFAULTS)) {
    const storageKey = `tone_${tone}`;
    const result = await chrome.storage.local.get(storageKey);
    const storageData = result[storageKey];
    if (!storageData) continue;

    const fileData = await readToneFile(handle, tone);
    if (fileData) {
      const merged = {
        prompt: fileData.prompt,
        comparisons: storageData.comparisons?.slice(-15) || []
      };
      await writeToneFile(handle, tone, merged);
    }
  }
}

// --- Helpers ---
function showStatus(el, msg, type) {
  el.textContent = msg;
  el.className = `status ${type}`;
  setTimeout(() => { el.textContent = ''; }, 3000);
}

// --- Tab activation on tones tab click ---
document.querySelector('[data-tab="tones"]').addEventListener('click', () => {
  syncStorageToFiles().then(renderTones);
});

// --- Init ---
loadSettings();
syncTonesToStorage();
