import { GEMINI_CLI_LOCAL_MODEL, GEMINI_CLI_MODEL } from './api.js';

const LOCAL_GEMINI_BRIDGE_ORIGIN = 'http://127.0.0.1:43117';

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

async function callLocalGeminiCliBridge({ systemPrompt, tweetText, context, model = GEMINI_CLI_MODEL, bridgeOrigin = LOCAL_GEMINI_BRIDGE_ORIGIN, requestId = 'bridge' }) {
  const startedAt = nowMs();
  try {
    const res = await fetch(`${bridgeOrigin}/generate-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt, tweetText, context, model, requestId })
    });

    const data = await res.json().catch(() => ({}));
    console.log(`[XGA][bridge-client][${requestId}] HTTP ${res.status} in ${formatDuration(nowMs() - startedAt)}`);
    if (!res.ok) throw new Error(data.error || `Gemini CLI bridge error (${res.status})`);
    if (!data.text) throw new Error('Gemini CLI bridge returned no text response');
    return data.text;
  } catch (error) {
    console.error(`[XGA][bridge-client][${requestId}] Failed after ${formatDuration(nowMs() - startedAt)}`, error?.message || error);
    if (isLocalBridgeFetchError(error)) {
      throw new Error('Gemini CLI bridge is not reachable. Start it with `npm run bridge` and try again.');
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
  GEMINI_CLI_LOCAL_MODEL,
  LOCAL_GEMINI_BRIDGE_ORIGIN,
  callLocalGeminiCliBridge,
  reportLocalBridgeTrace
};
