import { CLAUDE_CODE_LOCAL_MODEL, DEFAULT_VOICE_PROFILE, GEMINI_CLI_LOCAL_MODEL } from '../lib/api.js';

let generatedPromptSnapshot = '';
let canAutoSyncPrompt = true;
const DASH_HARD_RULES = [
  'Never use --.',
  'Never use em dashes or en dashes.',
  'Do not use dash-style asides.'
];
const CHOICE_GROUPS = {
  identity: [
    'builder',
    'founder',
    'designer',
    'marketer',
    'engineer',
    'creator',
    'investor',
    'researcher',
    'operator',
    'student'
  ],
  interests: [
    'AI products',
    'startups',
    'growth',
    'design taste',
    'distribution',
    'developer tools',
    'consumer apps',
    'markets',
    'culture',
    'product strategy'
  ],
  voice: [
    'short',
    'casual',
    'sharp',
    'warm',
    'curious',
    'skeptical',
    'funny',
    'high-conviction',
    'low punctuation',
    'builder-brained',
    'direct',
    'optimistic'
  ],
  samples: [
    'this is the part people keep underestimating',
    'yeah but distribution is doing half the work here',
    'lowkey the best products make the behavior feel obvious',
    'curious what changed after you shipped this',
    'feels true but only if the team has real taste',
    'this is why speed compounds so weirdly',
    'strong agree but the hard part is making it repeatable',
    'the boring version of this is probably the correct one',
    'need to see how users behave after the first week',
    'this is less about the model and more about the workflow'
  ]
};
const choiceState = {
  identity: new Set(),
  interests: new Set(),
  voice: new Set(),
  samples: new Set()
};

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
  document.getElementById('xApiClientId').value = settings.xApiClientId || '';
  document.getElementById('xApiUserAccessToken').value = settings.xApiUserAccessToken || '';
  document.getElementById('moonshotEndpoint').value = settings.moonshotEndpoint || 'https://api.moonshot.cn/v1';
  updateModelHintAndFields(settings.activeModel || 'claude-haiku');
  await updateXOAuthUi();
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

document.getElementById('saveAnalyticsSettings').addEventListener('click', async () => {
  const status = document.getElementById('analyticsStatus');
  try {
    await StorageHelper.saveSettings({
      xApiClientId: document.getElementById('xApiClientId').value.trim(),
      xApiUserAccessToken: document.getElementById('xApiUserAccessToken').value.trim()
    });
    showStatus(status, 'Analytics settings saved', 'success');
    await updateXOAuthUi();
  } catch (e) {
    showStatus(status, e.message, 'error');
  }
});

function formatExpiry(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

async function updateXOAuthUi() {
  const redirectInput = document.getElementById('xApiRedirectUri');
  const connectionState = document.getElementById('xApiConnectionState');
  const disconnectButton = document.getElementById('disconnectXApi');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_X_OAUTH_CONFIG' });
    if (!response?.ok) throw new Error(response?.reason || 'Could not load X OAuth config.');
    redirectInput.value = response.redirectUri || '';
    if (response.connected) {
      const username = response.authorizedUsername ? `@${response.authorizedUsername}` : 'X account';
      const expires = response.expiresAt ? `, token expires ${formatExpiry(response.expiresAt)}` : '';
      connectionState.textContent = `Connected as ${username}${expires}`;
      connectionState.className = 'connection-state connected';
      disconnectButton.disabled = false;
    } else {
      connectionState.textContent = 'Not connected';
      connectionState.className = 'connection-state';
      disconnectButton.disabled = true;
    }
  } catch (e) {
    connectionState.textContent = e.message;
    connectionState.className = 'connection-state error';
    disconnectButton.disabled = true;
  }
}

document.getElementById('copyXApiRedirectUri').addEventListener('click', async () => {
  const status = document.getElementById('analyticsStatus');
  const value = document.getElementById('xApiRedirectUri').value.trim();
  try {
    await navigator.clipboard.writeText(value);
    showStatus(status, 'Redirect URL copied', 'success');
  } catch (e) {
    showStatus(status, e.message, 'error');
  }
});

document.getElementById('connectXApi').addEventListener('click', async () => {
  const status = document.getElementById('analyticsStatus');
  const button = document.getElementById('connectXApi');
  const clientId = document.getElementById('xApiClientId').value.trim();
  try {
    button.disabled = true;
    await StorageHelper.saveSettings({ xApiClientId: clientId });
    showStatus(status, 'Opening X authorization...', 'success');
    const response = await chrome.runtime.sendMessage({
      type: 'START_X_OAUTH',
      clientId
    });
    if (!response?.ok) throw new Error(response?.reason || 'X connection failed.');
    const label = response.authorizedUsername ? `Connected @${response.authorizedUsername}` : 'Connected X';
    showStatus(status, label, 'success');
    await updateXOAuthUi();
  } catch (e) {
    showStatus(status, e.message, 'error');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('disconnectXApi').addEventListener('click', async () => {
  const status = document.getElementById('analyticsStatus');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'DISCONNECT_X_OAUTH' });
    if (!response?.ok) throw new Error(response?.reason || 'Could not disconnect X.');
    document.getElementById('xApiUserAccessToken').value = '';
    showStatus(status, 'Disconnected X', 'success');
    await updateXOAuthUi();
  } catch (e) {
    showStatus(status, e.message, 'error');
  }
});

document.getElementById('openAnalyticsDashboard').addEventListener('click', async () => {
  const status = document.getElementById('analyticsStatus');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'OPEN_ANALYTICS_DASHBOARD' });
    if (!response?.ok) throw new Error(response?.reason || 'Could not open analytics dashboard.');
    showStatus(status, 'Dashboard opened', 'success');
  } catch (e) {
    showStatus(status, e.message, 'error');
  }
});

document.getElementById('syncAnalyticsMetrics').addEventListener('click', async () => {
  const status = document.getElementById('analyticsStatus');
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SYNC_ANALYTICS_METRICS',
      options: { force: true, limit: 50 }
    });
    if (!response?.ok) throw new Error(response?.reason || 'Metric sync failed.');
    const privateNote = response.privateMetricsAvailable === false ? ' Public metrics only.' : '';
    showStatus(status, `Synced ${response.synced || 0} replies.${privateNote}`, 'success');
  } catch (e) {
    showStatus(status, e.message, 'error');
  }
});

// --- Onboarding ---
function normalizeLines(text, { splitCommas = true } = {}) {
  const delimiter = splitCommas ? /[\n,]/ : /\n/;
  return (text || '')
    .split(delimiter)
    .map((line) => line.trim())
    .filter(Boolean);
}

function uniqueLines(lines) {
  return Array.from(new Set(lines.map((line) => line.trim()).filter(Boolean)));
}

function setGroupSelections(group, values = []) {
  choiceState[group] = new Set(
    values.filter((value) => CHOICE_GROUPS[group].includes(value))
  );
}

function getSelectedChoiceLines(group) {
  return CHOICE_GROUPS[group].filter((value) => choiceState[group].has(value));
}

function getOtherLines(group) {
  const otherId = group === 'samples' ? 'samplesOther' : `${group}Other`;
  return normalizeLines(document.getElementById(otherId).value, { splitCommas: group !== 'samples' });
}

function getVoiceProfile() {
  const identity = uniqueLines([...getSelectedChoiceLines('identity'), ...getOtherLines('identity')]);
  const interests = uniqueLines([...getSelectedChoiceLines('interests'), ...getOtherLines('interests')]);
  const voice = uniqueLines([...getSelectedChoiceLines('voice'), ...getOtherLines('voice')]);
  const samples = uniqueLines([...getSelectedChoiceLines('samples'), ...getOtherLines('samples')]);

  return {
    displayName: document.getElementById('voiceDisplayName').value.trim(),
    identity: identity.join('\n'),
    viewpoints: interests.join('\n'),
    toneRules: voice.join('\n'),
    avoid: DASH_HARD_RULES.join('\n'),
    writingSamples: samples.join('\n'),
    systemPrompt: document.getElementById('voiceSystemPrompt').value.trim(),
    choiceSelections: {
      identity: getSelectedChoiceLines('identity'),
      interests: getSelectedChoiceLines('interests'),
      voice: getSelectedChoiceLines('voice'),
      samples: getSelectedChoiceLines('samples'),
      identityOther: document.getElementById('identityOther').value.trim(),
      interestsOther: document.getElementById('interestsOther').value.trim(),
      voiceOther: document.getElementById('voiceOther').value.trim(),
      samplesOther: document.getElementById('samplesOther').value.trim()
    }
  };
}

function setOtherValues(selections = {}) {
  document.getElementById('identityOther').value = selections.identityOther || '';
  document.getElementById('interestsOther').value = selections.interestsOther || '';
  document.getElementById('voiceOther').value = selections.voiceOther || '';
  document.getElementById('samplesOther').value = selections.samplesOther || '';
}

function inferSelectionsFromText(group, text) {
  const lowerText = (text || '').toLowerCase();
  return CHOICE_GROUPS[group].filter((value) => lowerText.includes(value.toLowerCase()));
}

function inferOtherText(group, text, selectedValues) {
  const selectedSet = new Set(selectedValues.map((value) => value.toLowerCase()));
  return normalizeLines(text, { splitCommas: group !== 'samples' })
    .filter((line) => !selectedSet.has(line.toLowerCase()))
    .join('\n');
}

function loadVoiceProfile(profile = {}) {
  const voiceProfile = {
    ...DEFAULT_VOICE_PROFILE,
    ...(profile || {}),
    choiceSelections: {
      ...DEFAULT_VOICE_PROFILE.choiceSelections,
      ...(profile?.choiceSelections || {})
    }
  };
  const selections = voiceProfile.choiceSelections || {};
  const hasSavedSelections = Boolean(profile?.choiceSelections);

  setGroupSelections('identity', hasSavedSelections ? selections.identity : inferSelectionsFromText('identity', voiceProfile.identity));
  setGroupSelections('interests', hasSavedSelections ? selections.interests : inferSelectionsFromText('interests', voiceProfile.viewpoints));
  setGroupSelections('voice', hasSavedSelections ? selections.voice : inferSelectionsFromText('voice', voiceProfile.toneRules));
  setGroupSelections('samples', hasSavedSelections ? selections.samples : inferSelectionsFromText('samples', voiceProfile.writingSamples));
  renderChoiceStates();

  document.getElementById('voiceDisplayName').value = voiceProfile.displayName || '';
  if (hasSavedSelections) {
    setOtherValues(selections);
  } else {
    setOtherValues({
      identityOther: inferOtherText('identity', voiceProfile.identity, getSelectedChoiceLines('identity')),
      interestsOther: inferOtherText('interests', voiceProfile.viewpoints, getSelectedChoiceLines('interests')),
      voiceOther: inferOtherText('voice', voiceProfile.toneRules, getSelectedChoiceLines('voice')),
      samplesOther: inferOtherText('samples', voiceProfile.writingSamples, getSelectedChoiceLines('samples'))
    });
  }
  renderChoiceStates();

  const generatedPrompt = buildVoiceSystemPrompt(getVoiceProfile());
  setVoiceSystemPrompt(voiceProfile.systemPrompt || generatedPrompt, {
    autoSync: !voiceProfile.systemPrompt || voiceProfile.systemPrompt === generatedPrompt
  });
}

function toBulletLines(text) {
  const bullets = normalizeLines(text, { splitCommas: false })
    .map((line) => `- ${line}`)
    .join('\n');
  return bullets;
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
    buildSection('Interests and viewpoints', profile.viewpoints),
    buildSection('Voice', profile.toneRules),
    buildSection('Reference replies', profile.writingSamples),
    `Hard rules:\n${DASH_HARD_RULES.map((rule) => `- ${rule}`).join('\n')}`
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

function renderChoiceGroup(group, containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  CHOICE_GROUPS[group].forEach((value) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = group === 'samples' ? 'choice-chip sample-chip' : 'choice-chip';
    button.dataset.group = group;
    button.dataset.value = value;
    button.textContent = value;
    button.addEventListener('click', () => {
      if (choiceState[group].has(value)) {
        choiceState[group].delete(value);
      } else {
        choiceState[group].add(value);
      }
      renderChoiceStates();
      syncGeneratedVoicePrompt();
    });
    container.appendChild(button);
  });
}

function renderChoiceStates() {
  Object.keys(CHOICE_GROUPS).forEach((group) => {
    document.querySelectorAll(`[data-group="${group}"]`).forEach((button) => {
      const active = choiceState[group].has(button.dataset.value);
      button.classList.toggle('selected', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    const count = choiceState[group].size + getOtherLines(group).length;
    const countNode = document.getElementById(`${group}Count`);
    if (countNode) countNode.textContent = `${count} selected`;
  });
}

function resetOnboarding() {
  Object.keys(choiceState).forEach((group) => {
    choiceState[group].clear();
  });
  document.getElementById('voiceDisplayName').value = '';
  setOtherValues();
  renderChoiceStates();
  setVoiceSystemPrompt(buildVoiceSystemPrompt(getVoiceProfile()));
}

document.getElementById('resetVoicePrompt').addEventListener('click', resetOnboarding);

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

['voiceDisplayName', 'identityOther', 'interestsOther', 'voiceOther', 'samplesOther'].forEach((id) => {
  document.getElementById(id).addEventListener('input', () => {
    renderChoiceStates();
    syncGeneratedVoicePrompt();
  });
});

document.getElementById('voiceSystemPrompt').addEventListener('input', (event) => {
  canAutoSyncPrompt = event.target.value === generatedPromptSnapshot;
});

renderChoiceGroup('identity', 'identityChoices');
renderChoiceGroup('interests', 'interestsChoices');
renderChoiceGroup('voice', 'voiceChoices');
renderChoiceGroup('samples', 'samplesChoices');

// --- Helpers ---
function showStatus(el, msg, type) {
  el.textContent = msg;
  el.className = `status ${type}`;
  setTimeout(() => { el.textContent = ''; }, 3000);
}

// --- Init ---
loadSettings();
