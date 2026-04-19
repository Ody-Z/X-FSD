import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, generateReply, TONE_DEFAULTS } from '../lib/api.js';

// --- buildSystemPrompt ---

describe('buildSystemPrompt', () => {
  it('uses default tone when no custom prompt', () => {
    const result = buildSystemPrompt('smart', null);
    assert.ok(result.includes(TONE_DEFAULTS.smart));
  });

  it('uses custom prompt from toneData', () => {
    const result = buildSystemPrompt('smart', { prompt: 'Be a genius', comparisons: [] });
    assert.ok(result.includes('Be a genius'));
    assert.ok(!result.includes(TONE_DEFAULTS.smart));
  });

  it('falls back to supportive for unknown tone', () => {
    const result = buildSystemPrompt('nonexistent', null);
    assert.ok(result.includes(TONE_DEFAULTS.supportive));
  });

  it('includes comparison examples when present', () => {
    const toneData = {
      prompt: 'test',
      comparisons: [
        { originalPost: 'orig1', aiGenerated: 'ai1', userFinal: 'user1' },
        { originalPost: 'orig2', aiGenerated: 'ai2', userFinal: 'user2' }
      ]
    };
    const result = buildSystemPrompt('smart', toneData);
    assert.ok(result.includes('orig1'));
    assert.ok(result.includes('ai2'));
    assert.ok(result.includes('user1'));
    assert.ok(result.includes('Learn from the differences'));
  });

  it('excludes comparison section when empty', () => {
    const result = buildSystemPrompt('smart', { prompt: 'test', comparisons: [] });
    assert.ok(!result.includes('Learn from the differences'));
  });

  it('only uses last 10 comparisons', () => {
    const comparisons = Array.from({ length: 15 }, (_, i) => ({
      originalPost: `orig${i}`, aiGenerated: `ai${i}`, userFinal: `user${i}`
    }));
    const result = buildSystemPrompt('smart', { prompt: 'test', comparisons });
    assert.ok(!result.includes('orig0'));
    assert.ok(!result.includes('orig4'));
    assert.ok(result.includes('orig5'));
    assert.ok(result.includes('orig14'));
  });
});

// --- buildUserMessage (tested via generateReply internals, but we can import it) ---
// buildUserMessage is not exported, so we test it indirectly through generateReply
// and directly by re-implementing the import trick

// We can test the user message format by intercepting what callClaude receives
describe('generateReply', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(validator) {
    globalThis.fetch = async (url, opts) => {
      if (validator) validator(url, opts);
      if (url.includes('anthropic')) {
        return {
          ok: true,
          json: async () => ({ content: [{ type: 'text', text: 'mocked reply' }] })
        };
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        return {
          ok: true,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: 'mocked gemini reply' }] } }]
          })
        };
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'mocked kimi reply' } }] })
      };
    };
  }

  const baseSettings = { anthropicApiKey: 'sk-test', activeModel: 'claude-haiku' };
  const kimiSettings = { moonshotApiKey: 'sk-kimi', activeModel: 'kimi-k2.5' };
  const geminiSettings = { geminiApiKey: 'AIza-test', activeModel: 'gemini-3.1-flash-lite-preview' };

  // --- No web search tools ---

  it('Claude: no tools in request payload', async () => {
    mockFetch((url, opts) => {
      if (!url.includes('anthropic')) return;
      const body = JSON.parse(opts.body);
      assert.equal(body.tools, undefined, 'tools should not be in Claude payload');
    });
    await generateReply('hello world', 'smart', null, baseSettings);
  });

  it('Kimi: no tools in request payload', async () => {
    mockFetch((url, opts) => {
      if (!url.includes('moonshot')) return;
      const body = JSON.parse(opts.body);
      assert.equal(body.tools, undefined, 'tools should not be in Kimi payload');
    });
    await generateReply('hello world', 'smart', null, kimiSettings);
  });

  // --- Single API call (no iteration loop) ---

  it('Claude: makes exactly one fetch call', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'reply' }] }) };
    };
    await generateReply('test', 'smart', null, baseSettings);
    assert.equal(callCount, 1);
  });

  it('Kimi: makes exactly one fetch call', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'reply' } }] }) };
    };
    await generateReply('test', 'smart', null, kimiSettings);
    assert.equal(callCount, 1);
  });

  // --- Returns text correctly ---

  it('Claude: returns text content', async () => {
    mockFetch();
    const result = await generateReply('test', 'smart', null, baseSettings);
    assert.equal(result, 'mocked reply');
  });

  it('Kimi: returns text content', async () => {
    mockFetch();
    const result = await generateReply('test', 'smart', null, kimiSettings);
    assert.equal(result, 'mocked kimi reply');
  });

  it('Gemini: returns text content', async () => {
    mockFetch();
    const result = await generateReply('test', 'smart', null, geminiSettings);
    assert.equal(result, 'mocked gemini reply');
  });

  // --- Error handling ---

  it('throws when Anthropic API key missing', async () => {
    await assert.rejects(
      () => generateReply('test', 'smart', null, { activeModel: 'claude-haiku' }),
      { message: 'Anthropic API key not set' }
    );
  });

  it('throws when Moonshot API key missing', async () => {
    await assert.rejects(
      () => generateReply('test', 'smart', null, { activeModel: 'kimi-k2.5' }),
      { message: 'Moonshot API key not set' }
    );
  });

  it('throws when Gemini API key missing', async () => {
    await assert.rejects(
      () => generateReply('test', 'smart', null, { activeModel: 'gemini-3.1-flash-lite-preview' }),
      { message: 'Gemini API key not set' }
    );
  });

  it('throws on unsupported active model instead of falling back to Claude', async () => {
    await assert.rejects(
      () => generateReply('test', 'smart', null, { activeModel: 'gemini-cli-local' }),
      { message: 'Unsupported active model: gemini-cli-local' }
    );
  });

  it('throws on API error response', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' });
    await assert.rejects(
      () => generateReply('test', 'smart', null, baseSettings),
      /Claude API error \(401\)/
    );
  });

  // --- Context injection ---

  it('includes poster handle in user message', async () => {
    mockFetch((url, opts) => {
      if (!url.includes('anthropic')) return;
      const body = JSON.parse(opts.body);
      const userMsg = body.messages[0].content;
      assert.ok(userMsg.includes('by @elonmusk'), `Expected poster handle in: ${userMsg}`);
    });
    await generateReply('test tweet', 'smart', null, baseSettings, {
      posterHandle: '@elonmusk',
      threadTweets: ['test tweet']
    });
  });

  it('includes thread context when multiple tweets', async () => {
    mockFetch((url, opts) => {
      if (!url.includes('anthropic')) return;
      const body = JSON.parse(opts.body);
      const userMsg = body.messages[0].content;
      assert.ok(userMsg.includes('Thread context'), `Expected thread context in: ${userMsg}`);
      assert.ok(userMsg.includes('first tweet'));
      assert.ok(userMsg.includes('second tweet'));
    });
    await generateReply('third tweet', 'smart', null, baseSettings, {
      posterHandle: '@someone',
      threadTweets: ['first tweet', 'second tweet', 'third tweet']
    });
  });

  it('skips thread context for single tweet', async () => {
    mockFetch((url, opts) => {
      if (!url.includes('anthropic')) return;
      const body = JSON.parse(opts.body);
      const userMsg = body.messages[0].content;
      assert.ok(!userMsg.includes('Thread context'), `Should not have thread context: ${userMsg}`);
    });
    await generateReply('only tweet', 'smart', null, baseSettings, {
      posterHandle: '@someone',
      threadTweets: ['only tweet']
    });
  });

  it('works with null context (backward compat)', async () => {
    mockFetch((url, opts) => {
      if (!url.includes('anthropic')) return;
      const body = JSON.parse(opts.body);
      const userMsg = body.messages[0].content;
      assert.ok(userMsg.includes('Reply to this post'));
      assert.ok(userMsg.includes('some tweet'));
    });
    await generateReply('some tweet', 'smart', null, baseSettings, null);
  });

  it('works with undefined context (backward compat)', async () => {
    mockFetch();
    const result = await generateReply('test', 'smart', null, baseSettings);
    assert.equal(result, 'mocked reply');
  });

  // --- Model routing ---

  it('routes to Claude by default', async () => {
    let calledUrl = '';
    globalThis.fetch = async (url) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'r' }] }) };
    };
    await generateReply('test', 'smart', null, baseSettings);
    assert.ok(calledUrl.includes('anthropic'));
  });

  it('routes to Kimi when activeModel is kimi-k2.5', async () => {
    let calledUrl = '';
    globalThis.fetch = async (url) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'r' } }] }) };
    };
    await generateReply('test', 'smart', null, kimiSettings);
    assert.ok(calledUrl.includes('moonshot'));
  });

  it('uses custom Kimi endpoint when provided', async () => {
    let calledUrl = '';
    globalThis.fetch = async (url) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'r' } }] }) };
    };
    await generateReply('test', 'smart', null, {
      ...kimiSettings,
      moonshotEndpoint: 'https://custom.api.com/v1'
    });
    assert.ok(calledUrl.startsWith('https://custom.api.com/v1'));
  });

  it('routes to Gemini when activeModel is gemini-3.1-flash-lite-preview', async () => {
    let calledUrl = '';
    globalThis.fetch = async (url) => {
      calledUrl = url;
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'r' }] } }] })
      };
    };
    await generateReply('test', 'smart', null, geminiSettings);
    assert.ok(calledUrl.includes('generativelanguage.googleapis.com'));
  });

  it('Gemini: sends user message and google_search tool', async () => {
    mockFetch((url, opts) => {
      if (!url.includes('generativelanguage.googleapis.com')) return;
      const body = JSON.parse(opts.body);
      assert.deepEqual(body.tools, [{ google_search: {} }]);
      assert.ok(body.contents[0].parts[0].text.includes('by @someone'));
      assert.ok(body.contents[0].parts[0].text.includes('first tweet'));
      assert.ok(body.contents[0].parts[0].text.includes('third tweet'));
    });
    await generateReply('third tweet', 'smart', null, geminiSettings, {
      posterHandle: '@someone',
      threadTweets: ['first tweet', 'second tweet', 'third tweet']
    });
  });
});
