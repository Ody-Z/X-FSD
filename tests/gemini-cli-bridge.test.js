import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeError, buildCliPrompt, buildMinimalSettings, createBridgeServer, extractFirstJsonObject, parseCliJsonOutput } from '../bridge/gemini-cli-bridge.js';

async function withServer(server, fn) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('parseCliJsonOutput', () => {
  it('extracts the first JSON object from noisy stdout', () => {
    const text = [
      'Loaded cached credentials.',
      '{',
      '  "session_id": "a",',
      '  "response": "hello",',
      '  "stats": {}',
      '}',
      'Hook execution complete'
    ].join('\n');

    assert.equal(
      extractFirstJsonObject(text),
      '{\n  "session_id": "a",\n  "response": "hello",\n  "stats": {}\n}'
    );
  });

  it('extracts the text response from Gemini CLI json output', () => {
    assert.equal(
      parseCliJsonOutput(JSON.stringify({ session_id: 'a', response: 'hello', stats: {} })),
      'hello'
    );
  });

  it('parses noisy stdout around the JSON response', () => {
    const stdout = [
      'Loaded cached credentials.',
      '{',
      '  "session_id": "a",',
      '  "response": "hello",',
      '  "stats": {}',
      '}',
      'Hook execution complete'
    ].join('\n');

    assert.equal(parseCliJsonOutput(stdout), 'hello');
  });

  it('throws when Gemini CLI returns an empty response', () => {
    assert.throws(
      () => parseCliJsonOutput(JSON.stringify({ session_id: 'a', response: '   ', stats: {} })),
      /no text response/
    );
  });
});

describe('buildCliPrompt', () => {
  it('includes system prompt, poster handle, and thread context', () => {
    const prompt = buildCliPrompt('system prompt', 'third tweet', {
      posterHandle: '@someone',
      threadTweets: ['first tweet', 'second tweet', 'third tweet']
    });

    assert.ok(prompt.includes('system prompt'));
    assert.ok(prompt.includes('by @someone'));
    assert.ok(prompt.includes('first tweet'));
    assert.ok(prompt.includes('third tweet'));
  });
});

describe('buildMinimalSettings', () => {
  it('keeps auth selection but strips hooks', () => {
    const settings = buildMinimalSettings({
      general: { previewFeatures: true },
      hooks: { SessionStart: [{ hooks: [{ command: 'slow-hook' }] }] },
      security: { auth: { selectedType: 'oauth-personal' } }
    });

    assert.deepEqual(settings, {
      general: { previewFeatures: true },
      security: { auth: { selectedType: 'oauth-personal' } }
    });
  });
});

describe('createBridgeServer', () => {
  it('returns health info', async () => {
    const server = createBridgeServer({
      getStatus: async () => ({ installed: true, binary: 'gemini', version: '0.27.3' })
    });

    await withServer(server, async (origin) => {
      const res = await fetch(`${origin}/health`);
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.equal(data.gemini.installed, true);
      assert.equal(data.gemini.version, '0.27.3');
    });
  });

  it('builds a reply through the injected CLI handler', async () => {
    let requestPayload;
    const server = createBridgeServer({
      invokeReply: async (payload) => {
        requestPayload = payload;
        return 'reply text';
      }
    });

    await withServer(server, async (origin) => {
      const res = await fetch(`${origin}/generate-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemPrompt: 'system prompt',
          tweetText: 'tweet body',
          context: { posterHandle: '@a', threadTweets: ['tweet body'] },
          model: 'gemini-3.1-flash-lite-preview'
        })
      });
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.equal(data.text, 'reply text');
      assert.equal(requestPayload.systemPrompt, 'system prompt');
      assert.equal(requestPayload.tweetText, 'tweet body');
      assert.equal(requestPayload.model, 'gemini-3.1-flash-lite-preview');
    });
  });

  it('returns structured bridge errors', async () => {
    const server = createBridgeServer({
      invokeReply: async () => {
        throw new BridgeError('gemini_auth_required', 'Gemini CLI is not authenticated. Run `gemini` once locally and sign in.', 503);
      }
    });

    await withServer(server, async (origin) => {
      const res = await fetch(`${origin}/generate-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemPrompt: 'system prompt',
          tweetText: 'tweet body'
        })
      });
      const data = await res.json();
      assert.equal(res.status, 503);
      assert.equal(data.code, 'gemini_auth_required');
    });
  });

  it('accepts external trace events', async () => {
    const server = createBridgeServer();

    await withServer(server, async (origin) => {
      const res = await fetch(`${origin}/trace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: 'xga-trace',
          source: 'bg',
          message: 'Loaded settings in 1ms',
          extra: { activeModel: 'gemini-cli-local' }
        })
      });
      const data = await res.json();
      assert.equal(res.status, 202);
      assert.equal(data.ok, true);
    });
  });
});
