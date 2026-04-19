import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { callLocalGeminiCliBridge } from '../lib/local-cli.js';

describe('callLocalGeminiCliBridge', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('posts the expected payload to the local bridge', async () => {
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({ text: 'reply text' })
      };
    };

    const text = await callLocalGeminiCliBridge({
      systemPrompt: 'system',
      tweetText: 'tweet',
      context: { posterHandle: '@a', threadTweets: ['tweet'] },
      model: 'gemini-3.1-flash-lite-preview'
    });

    assert.equal(text, 'reply text');
    assert.equal(request.url, 'http://127.0.0.1:43117/generate-reply');
    assert.equal(request.options.method, 'POST');

    const body = JSON.parse(request.options.body);
    assert.equal(body.systemPrompt, 'system');
    assert.equal(body.tweetText, 'tweet');
    assert.equal(body.model, 'gemini-3.1-flash-lite-preview');
    assert.deepEqual(body.context, { posterHandle: '@a', threadTweets: ['tweet'] });
  });

  it('surfaces bridge error responses', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      json: async () => ({ error: 'Gemini CLI is not authenticated. Run `gemini` once locally and sign in.' })
    });

    await assert.rejects(
      () => callLocalGeminiCliBridge({ systemPrompt: 'system', tweetText: 'tweet' }),
      /Gemini CLI is not authenticated/
    );
  });

  it('maps network failures to startup guidance', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };

    await assert.rejects(
      () => callLocalGeminiCliBridge({ systemPrompt: 'system', tweetText: 'tweet' }),
      /Start it with `npm run bridge`/
    );
  });
});
