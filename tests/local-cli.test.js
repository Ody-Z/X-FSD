import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  callLocalClaudeCodeBridge,
  callLocalGeminiCliBridge,
  reportLocalBridgeTrace
} from '../lib/local-cli.js';

describe('callLocalGeminiCliBridge', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('posts the expected payload to the Gemini bridge', async () => {
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
      userPrompt: 'user prompt',
      tweetText: 'tweet',
      context: { posterHandle: '@a', threadTweets: ['tweet'] },
      model: 'flash-lite',
      timeoutMs: 12000
    });

    assert.equal(text, 'reply text');
    assert.equal(request.url, 'http://127.0.0.1:43117/generate-reply');
    const body = JSON.parse(request.options.body);
    assert.equal(body.systemPrompt, 'system');
    assert.equal(body.userPrompt, 'user prompt');
    assert.equal(body.model, 'flash-lite');
    assert.equal(body.timeoutMs, 12000);
  });

  it('maps Gemini bridge network failures to startup guidance', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };

    await assert.rejects(
      () => callLocalGeminiCliBridge({ systemPrompt: 'system', tweetText: 'tweet' }),
      /Start it with `npm run bridge`/
    );
  });

  it('posts trace events to the local bridge', async () => {
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ ok: true }) };
    };

    await reportLocalBridgeTrace({
      requestId: 'xga-test',
      message: 'Loaded settings in 2ms',
      extra: { activeModel: 'gemini-cli-local' },
      source: 'bg'
    });

    assert.equal(request.url, 'http://127.0.0.1:43117/trace');
    assert.equal(request.options.method, 'POST');
  });
});

describe('callLocalClaudeCodeBridge', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('posts the expected payload to the Claude bridge', async () => {
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({ text: 'reply text' })
      };
    };

    const text = await callLocalClaudeCodeBridge({
      systemPrompt: 'system',
      userPrompt: 'user prompt',
      tweetText: 'tweet',
      context: { posterHandle: '@a', threadTweets: ['tweet'] },
      model: 'claude-haiku-4-5-20251001',
      timeoutMs: 25000
    });

    assert.equal(text, 'reply text');
    assert.equal(request.url, 'http://127.0.0.1:43118/generate-reply');
    const body = JSON.parse(request.options.body);
    assert.equal(body.systemPrompt, 'system');
    assert.equal(body.userPrompt, 'user prompt');
    assert.equal(body.model, 'claude-haiku-4-5-20251001');
    assert.equal(body.timeoutMs, 25000);
  });

  it('maps Claude bridge network failures to startup guidance', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };

    await assert.rejects(
      () => callLocalClaudeCodeBridge({ systemPrompt: 'system', tweetText: 'tweet' }),
      /Start it with `npm run bridge:claude`/
    );
  });
});
