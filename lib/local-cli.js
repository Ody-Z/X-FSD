import {
  CLAUDE_CODE_HAIKU_MODEL,
  CLAUDE_CODE_LOCAL_MODEL,
  GEMINI_CLI_LOCAL_MODEL,
  GEMINI_CLI_MODEL
} from './api.js';

const LOCAL_GEMINI_BRIDGE_ORIGIN = 'http://127.0.0.1:43117';
const LOCAL_CLAUDE_BRIDGE_ORIGIN = 'http://127.0.0.1:43118';

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function formatDuration(ms) {
  return `${Math.round(ms)}ms`;
}

function isLocalBridgeFetchError(error) {
  return error instanceof TypeError || /Failed to fetch|NetworkError/i.test(error?.message || '');
}

async function callLocalGeminiCliBridge({
  systemPrompt,
  userPrompt,
  tweetText,
  context,
  model = GEMINI_CLI_MODEL,
  bridgeOrigin = LOCAL_GEMINI_BRIDGE_ORIGIN,
  requestId = 'bridge',
  timeoutMs = null
}) {
  return callLocalBridge({
    systemPrompt,
    userPrompt: userPrompt || null,
    tweetText,
    context,
    model,
    bridgeOrigin,
    requestId,
    providerName: 'Gemini CLI',
    startCommand: 'npm run bridge',
    timeoutMs
  });
}

async function callLocalClaudeCodeBridge({
  systemPrompt,
  userPrompt,
  tweetText,
  context,
  model = CLAUDE_CODE_HAIKU_MODEL,
  bridgeOrigin = LOCAL_CLAUDE_BRIDGE_ORIGIN,
  requestId = 'bridge',
  timeoutMs = null
}) {
  return callLocalBridge({
    systemPrompt,
    userPrompt: userPrompt || null,
    tweetText,
    context,
    model,
    bridgeOrigin,
    requestId,
    providerName: 'Claude Code bridge',
    startCommand: 'npm run bridge:claude',
    timeoutMs
  });
}

async function callLocalBridge({
  systemPrompt,
  userPrompt,
  tweetText,
  context,
  model,
  bridgeOrigin,
  requestId,
  providerName,
  startCommand,
  timeoutMs
}) {
  const startedAt = nowMs();
  try {
    const res = await fetch(`${bridgeOrigin}/generate-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt, userPrompt, tweetText, context, model, requestId, timeoutMs })
    });

    const data = await res.json().catch(() => ({}));
    console.log(`[XGA][bridge-client][${requestId}] HTTP ${res.status} in ${formatDuration(nowMs() - startedAt)}`);
    if (!res.ok) throw new Error(data.error || `${providerName} error (${res.status})`);
    if (!data.text) throw new Error(`${providerName} returned no text response`);
    return data.text;
  } catch (error) {
    console.error(`[XGA][bridge-client][${requestId}] Failed after ${formatDuration(nowMs() - startedAt)}`, error?.message || error);
    if (isLocalBridgeFetchError(error)) {
      throw new Error(`${providerName} is not reachable. Start it with \`${startCommand}\` and try again.`);
    }
    throw error;
  }
}

async function reportLocalBridgeTrace({ requestId, message, extra, source = 'bg', bridgeOrigin = LOCAL_GEMINI_BRIDGE_ORIGIN }) {
  try {
    await fetch(`${bridgeOrigin}/trace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, message, extra, source })
    });
  } catch {
    // Diagnostics must never block reply generation.
  }
}

export {
  CLAUDE_CODE_LOCAL_MODEL,
  CLAUDE_CODE_HAIKU_MODEL,
  LOCAL_CLAUDE_BRIDGE_ORIGIN,
  GEMINI_CLI_LOCAL_MODEL,
  LOCAL_GEMINI_BRIDGE_ORIGIN,
  callLocalClaudeCodeBridge,
  callLocalGeminiCliBridge,
  reportLocalBridgeTrace
};
