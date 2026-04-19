import { GEMINI_CLI_LOCAL_MODEL, GEMINI_MODEL } from './api.js';

const LOCAL_GEMINI_BRIDGE_ORIGIN = 'http://127.0.0.1:43117';

function isLocalBridgeFetchError(error) {
  return error instanceof TypeError || /Failed to fetch|NetworkError/i.test(error?.message || '');
}

async function callLocalGeminiCliBridge({ systemPrompt, tweetText, context, model = GEMINI_MODEL, bridgeOrigin = LOCAL_GEMINI_BRIDGE_ORIGIN }) {
  try {
    const res = await fetch(`${bridgeOrigin}/generate-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt, tweetText, context, model })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Gemini CLI bridge error (${res.status})`);
    if (!data.text) throw new Error('Gemini CLI bridge returned no text response');
    return data.text;
  } catch (error) {
    if (isLocalBridgeFetchError(error)) {
      throw new Error('Gemini CLI bridge is not reachable. Start it with `npm run bridge` and try again.');
    }
    throw error;
  }
}

export {
  GEMINI_CLI_LOCAL_MODEL,
  LOCAL_GEMINI_BRIDGE_ORIGIN,
  callLocalGeminiCliBridge
};
