import { CLAUDE_CODE_LOCAL_MODEL, DEFAULT_VOICE_PROFILE, GEMINI_CLI_LOCAL_MODEL } from '../lib/api.js';

let generatedPromptSnapshot = '';
let canAutoSyncPrompt = true;

// --- Tab Navigation ---
function activateTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

  const tab = document.querySelector(`[data-tab="${tabName}"]`);
  const content = document.getElementById(tabName);
  if (!tab || !content) return;

  tab.classList.add('active');
  content.classList.add('active');
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    activateTab(tab.dataset.tab);
  });
});

// --- Settings ---
async function loadSettings() {
  const settings = await StorageHelper.getSettings();
  document.getElementById('username').value = settings.username || '';
  document.getElementById('activeModel').value = settings.activeModel || 'gemini-cli-local';
  document.getElementById('autoDraftsEnabled').checked = settings.autoDraftsEnabled !== false;
  document.getElementById('anthropicApiKey').value = settings.anthropicApiKey || '';
  document.getElementById('moonshotApiKey').value = settings.moonshotApiKey || '';
  document.getElementById('geminiApiKey').value = settings.geminiApiKey || '';
  document.getElementById('moonshotEndpoint').value = settings.moonshotEndpoint || 'https://api.moonshot.cn/v1';
  updateModelHintAndFields(settings.activeModel || 'claude-haiku');
  loadVoiceProfile(settings.voiceProfile);

  if (!settings.onboardingCompleted) {
    activateTab('onboarding');
  }
}

function updateModelHintAndFields(activeModel) {
  const hint = document.getElementById('modelHint');
  const geminiApiKey = document.getElementById('geminiApiKey');
  const anthropicApiKey = document.getElementById('anthropicApiKey');
  const anthropicField = document.getElementById('anthropicApiKeyField');
  const moonshotKeyField = document.getElementById('moonshotApiKeyField');
  const geminiKeyField = document.getElementById('geminiApiKeyField');
  const moonshotEndpointField = document.getElementById('moonshotEndpointField');
  const isGeminiLocal = activeModel === GEMINI_CLI_LOCAL_MODEL;
  const isClaudeLocal = activeModel === CLAUDE_CODE_LOCAL_MODEL;

  anthropicField.classList.toggle('hidden', activeModel !== 'claude-haiku');
  moonshotKeyField.classList.toggle('hidden', activeModel !== 'kimi-k2.5');
  moonshotEndpointField.classList.toggle('hidden', activeModel !== 'kimi-k2.5');
  geminiKeyField.classList.toggle('hidden', isGeminiLocal || activeModel !== 'gemini-3.1-flash-lite-preview');

  if (isGeminiLocal) {
    hint.textContent = 'Gemini CLI Local uses your local bridge. Start it first with `npm run bridge`. Gemini API Key is ignored in this mode.';
    geminiApiKey.disabled = true;
    geminiApiKey.placeholder = 'Not used in Gemini CLI Local mode';
    anthropicApiKey.disabled = false;
    anthropicApiKey.placeholder = 'sk-ant-...';
    return;
  }

  geminiApiKey.disabled = false;
  geminiApiKey.placeholder = 'AIza...';

  if (isClaudeLocal) {
    hint.textContent = 'Claude Code Haiku Local uses your local Claude Code login via bridge. Start it first with `npm run bridge:claude`. Anthropic API Key is ignored in this mode.';
    anthropicApiKey.disabled = true;
    anthropicApiKey.placeholder = 'Not used in Claude Code Local mode';
    return;
  }

  anthropicApiKey.disabled = false;
  anthropicApiKey.placeholder = 'sk-ant-...';

  if (activeModel === 'gemini-3.1-flash-lite-preview') {
    hint.textContent = 'Gemini HTTP mode uses your Gemini API Key.';
    return;
  }

  if (activeModel === 'kimi-k2.5') {
    hint.textContent = 'Kimi mode uses your Moonshot API key and selected region.';
    return;
  }

  hint.textContent = 'Claude mode uses your Anthropic API key.';
}

async function saveActiveModelSelection(activeModel) {
  await StorageHelper.saveSettings({ activeModel });
}

document.getElementById('activeModel').addEventListener('change', async (event) => {
  const status = document.getElementById('settingsStatus');
  const activeModel = event.target.value;
  updateModelHintAndFields(activeModel);

  try {
    await saveActiveModelSelection(activeModel);
    status.textContent = 'Model updated';
    status.className = 'status success';
  } catch (e) {
    status.textContent = e.message;
    status.className = 'status error';
  }

  setTimeout(() => { status.textContent = ''; }, 2000);
});

document.getElementById('saveSettings').addEventListener('click', async () => {
  const status = document.getElementById('settingsStatus');
  try {
    await StorageHelper.saveSettings({
      username: document.getElementById('username').value.replace('@', ''),
      activeModel: document.getElementById('activeModel').value,
      autoDraftsEnabled: document.getElementById('autoDraftsEnabled').checked,
      anthropicApiKey: document.getElementById('anthropicApiKey').value,
      moonshotApiKey: document.getElementById('moonshotApiKey').value,
      geminiApiKey: document.getElementById('geminiApiKey').value,
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

// --- Onboarding ---
function getVoiceProfile() {
  return {
    displayName: document.getElementById('voiceDisplayName').value.trim(),
    identity: document.getElementById('voiceIdentity').value.trim(),
    viewpoints: document.getElementById('voiceViewpoints').value.trim(),
    toneRules: document.getElementById('voiceToneRules').value.trim(),
    avoid: document.getElementById('voiceAvoid').value.trim(),
    writingSamples: document.getElementById('voiceSamples').value.trim(),
    systemPrompt: document.getElementById('voiceSystemPrompt').value.trim()
  };
}

function loadVoiceProfile(profile = {}) {
  const voiceProfile = { ...DEFAULT_VOICE_PROFILE, ...(profile || {}) };
  const generatedPrompt = buildVoiceSystemPrompt(voiceProfile);
  document.getElementById('voiceDisplayName').value = voiceProfile.displayName || '';
  document.getElementById('voiceIdentity').value = voiceProfile.identity || '';
  document.getElementById('voiceViewpoints').value = voiceProfile.viewpoints || '';
  document.getElementById('voiceToneRules').value = voiceProfile.toneRules || '';
  document.getElementById('voiceAvoid').value = voiceProfile.avoid || '';
  document.getElementById('voiceSamples').value = voiceProfile.writingSamples || '';
  setVoiceSystemPrompt(voiceProfile.systemPrompt || generatedPrompt, {
    autoSync: !voiceProfile.systemPrompt || voiceProfile.systemPrompt === generatedPrompt
  });
}

function toBulletLines(text) {
  return (text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join('\n');
}

function buildSection(label, text) {
  const bullets = toBulletLines(text);
  return bullets ? `${label}:\n${bullets}` : '';
}

function buildVoiceSystemPrompt(profile) {
  const displayName = profile.displayName || 'the user';
  return [
    `Write replies as ${displayName}.`,
    buildSection('Identity', profile.identity),
    buildSection('Viewpoints to preserve', profile.viewpoints),
    buildSection('Tone and style rules', profile.toneRules),
    buildSection('Avoid', profile.avoid),
    buildSection('Reference writing samples', profile.writingSamples),
    'When the post conflicts with these viewpoints, reply with nuance instead of copying the post author.',
    'Keep the reply compact, casual, and specific to the post.'
  ].filter(Boolean).join('\n\n');
}

function setVoiceSystemPrompt(prompt, { autoSync = true } = {}) {
  generatedPromptSnapshot = prompt;
  canAutoSyncPrompt = autoSync;
  document.getElementById('voiceSystemPrompt').value = prompt;
}

function syncGeneratedVoicePrompt() {
  if (!canAutoSyncPrompt) return;
  const promptField = document.getElementById('voiceSystemPrompt');
  if (promptField.value && promptField.value !== generatedPromptSnapshot) {
    canAutoSyncPrompt = false;
    return;
  }
  setVoiceSystemPrompt(buildVoiceSystemPrompt(getVoiceProfile()));
}

document.getElementById('buildVoicePrompt').addEventListener('click', () => {
  const profile = getVoiceProfile();
  setVoiceSystemPrompt(buildVoiceSystemPrompt(profile));
});

document.getElementById('resetVoicePrompt').addEventListener('click', () => {
  loadVoiceProfile(DEFAULT_VOICE_PROFILE);
});

document.getElementById('saveVoiceProfile').addEventListener('click', async () => {
  const status = document.getElementById('onboardingStatus');
  const profile = getVoiceProfile();
  const generatedPrompt = buildVoiceSystemPrompt(profile);
  const shouldUseGeneratedPrompt = canAutoSyncPrompt && (!profile.systemPrompt || profile.systemPrompt === generatedPromptSnapshot);
  const voiceProfile = {
    ...profile,
    systemPrompt: shouldUseGeneratedPrompt ? generatedPrompt : profile.systemPrompt
  };

  try {
    await StorageHelper.saveSettings({
      voiceProfile,
      onboardingCompleted: true
    });
    setVoiceSystemPrompt(voiceProfile.systemPrompt, { autoSync: shouldUseGeneratedPrompt });
    showStatus(status, 'Voice profile saved', 'success');
  } catch (e) {
    showStatus(status, e.message, 'error');
  }
});

[
  'voiceDisplayName',
  'voiceIdentity',
  'voiceViewpoints',
  'voiceToneRules',
  'voiceAvoid',
  'voiceSamples'
].forEach((id) => {
  document.getElementById(id).addEventListener('input', syncGeneratedVoicePrompt);
});

document.getElementById('voiceSystemPrompt').addEventListener('input', (event) => {
  canAutoSyncPrompt = event.target.value === generatedPromptSnapshot;
});

// --- Helpers ---
function showStatus(el, msg, type) {
  el.textContent = msg;
  el.className = `status ${type}`;
  setTimeout(() => { el.textContent = ''; }, 3000);
}

// --- Init ---
loadSettings();
