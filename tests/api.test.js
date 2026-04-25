import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VOICE_PROFILE,
  DRAFT_PHASE_FULL,
  DRAFT_PHASE_QUICK,
  TONE_DEFAULTS,
  buildAdaptiveDraftPrompt,
  buildManualDraftPrompt,
  buildSystemPrompt,
  buildUserMessage,
  detectAutoDraftSkipReason,
  generateReply,
  parseAdaptiveDraftResult
} from '../lib/api.js';

describe('buildSystemPrompt', () => {
  it('uses default tone when no custom prompt', () => {
    const result = buildSystemPrompt('smart', null);
    assert.ok(result.includes(TONE_DEFAULTS.smart));
    assert.ok(result.includes('Voice guide for the user'));
    assert.ok(result.includes('Never use --.'));
    assert.ok(!result.includes('Ody is a Gen Z AI native builder'));
  });

  it('uses custom prompt from toneData', () => {
    const result = buildSystemPrompt('smart', { prompt: 'Be a genius', comparisons: [] });
    assert.ok(result.includes('Be a genius'));
    assert.ok(!result.includes(TONE_DEFAULTS.smart));
  });

  it('includes comparison examples when present', () => {
    const result = buildSystemPrompt('smart', {
      prompt: 'test',
      comparisons: [
        { originalPost: 'orig', aiGenerated: 'ai', userFinal: 'user' }
      ]
    });
    assert.ok(result.includes('Learn from the differences'));
    assert.ok(result.includes('orig'));
    assert.ok(result.includes('user'));
  });

  it('uses a custom voice profile when provided', () => {
    const result = buildSystemPrompt('smart', null, {
      voiceProfile: {
        ...DEFAULT_VOICE_PROFILE,
        systemPrompt: 'Write as Alex: skeptical, concise, and pro open-source.'
      }
    });

    assert.ok(result.includes('Write as Alex'));
    assert.ok(result.includes('Never use --.'));
    assert.ok(!result.includes('Ody is a Gen Z AI native builder'));
  });
});

describe('buildUserMessage', () => {
  it('limits thread context to the latest 3 earlier tweets', () => {
    const message = buildUserMessage('tweet5', {
      posterHandle: '@someone',
      threadTweets: ['tweet1', 'tweet2', 'tweet3', 'tweet4', 'tweet5']
    });

    assert.ok(!message.includes('tweet1'));
    assert.ok(message.includes('tweet2'));
    assert.ok(message.includes('tweet4'));
    assert.ok(message.includes('tweet5'));
  });

  it('includes quoted post context when present', () => {
    const message = buildUserMessage('Many such cases.', {
      posterHandle: '@pmarca',
      quotedTweet: {
        posterHandle: '@bhorowitz',
        text: 'They put my father R.I.P. on a hate group list and nearly destroyed his non-profit.'
      },
      threadTweets: ['Many such cases.']
    });

    assert.match(message, /Quoted post by @bhorowitz/);
    assert.match(message, /hate group list/);
    assert.match(message, /Reply to this post by @pmarca/);
  });
});

describe('adaptive draft prompts', () => {
  it('quick phase optimizes for speed and omits style references', () => {
    const prompt = buildAdaptiveDraftPrompt({
      tweetText: 'A funny post',
      context: { posterHandle: '@a', threadTweets: ['A funny post'] },
      phase: DRAFT_PHASE_QUICK
    });

    assert.ok(prompt.systemPrompt.includes('Optimize for speed'));
    assert.ok(prompt.systemPrompt.includes('Never use --.'));
    assert.ok(prompt.systemPrompt.includes('Never exceed 2 sentences'));
    assert.ok(!prompt.systemPrompt.includes('Style references from the user'));
  });

  it('full phase includes style references when provided', () => {
    const prompt = buildAdaptiveDraftPrompt({
      tweetText: 'A high quality thread',
      context: { posterHandle: '@a', threadTweets: ['A high quality thread'] },
      phase: DRAFT_PHASE_FULL,
      toneDataByTone: {
        smart: {
          comparisons: [
            { originalPost: 'orig', aiGenerated: 'ai', userFinal: 'user' }
          ]
        }
      }
    });

    assert.ok(prompt.systemPrompt.includes('quality pass'));
    assert.ok(prompt.systemPrompt.includes('Style references from the user'));
    assert.ok(prompt.systemPrompt.includes('Base tone: smart'));
  });

  it('full phase includes auto comparison references and custom voice', () => {
    const prompt = buildAdaptiveDraftPrompt({
      tweetText: 'A high quality thread',
      context: { posterHandle: '@a', threadTweets: ['A high quality thread'] },
      phase: DRAFT_PHASE_FULL,
      voiceProfile: {
        ...DEFAULT_VOICE_PROFILE,
        systemPrompt: 'Write as Alex with high-conviction product taste.'
      },
      autoPromptData: {
        comparisons: [
          {
            strategyType: 'hot_take',
            originalPost: 'orig',
            aiGenerated: 'ai',
            userFinal: 'user'
          }
        ]
      }
    });

    assert.ok(prompt.systemPrompt.includes('Write as Alex'));
    assert.ok(prompt.systemPrompt.includes('Strategy: hot_take'));
    assert.ok(prompt.systemPrompt.includes('user'));
  });
});

describe('manual draft prompts', () => {
  it('enhance uses the current draft in the user prompt', () => {
    const prompt = buildManualDraftPrompt({
      tweetText: 'Original post',
      tone: 'enhance',
      toneData: { prompt: 'Improve it', comparisons: [] },
      context: { threadTweets: ['Original post'] },
      currentDraft: 'first draft',
      baseToneHint: 'smart'
    });

    assert.ok(prompt.userMessage.includes('Current draft to improve'));
    assert.ok(prompt.userMessage.includes('first draft'));
    assert.equal(prompt.baseTone, 'smart');
  });
});

describe('detectAutoDraftSkipReason', () => {
  it('skips low-signal posts', () => {
    assert.match(
      detectAutoDraftSkipReason('nice'),
      /low-signal/
    );
  });

  it('skips sensitive posts', () => {
    assert.match(
      detectAutoDraftSkipReason('RIP to everyone affected by the shooting.'),
      /Sensitive post/
    );
  });

  it('keeps substantive posts', () => {
    assert.equal(
      detectAutoDraftSkipReason('Interesting tradeoff: lower latency models often need stricter prompt contracts.'),
      ''
    );
  });

  it('skips posts older than 2 hours when timestamp is available', () => {
    assert.match(
      detectAutoDraftSkipReason(
        'Interesting tradeoff: lower latency models often need stricter prompt contracts.',
        { createdAt: Date.now() - (2 * 60 * 60 * 1000) - 1000 }
      ),
      /older than 2 hours/
    );
  });

  it('keeps posts within 2 hours when timestamp is available', () => {
    assert.equal(
      detectAutoDraftSkipReason(
        'Interesting tradeoff: lower latency models often need stricter prompt contracts.',
        { createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() }
      ),
      ''
    );
  });

  it('keeps short quote tweets when the quoted post adds context', () => {
    assert.equal(
      detectAutoDraftSkipReason('Many such cases.', {
        quotedTweet: {
          posterHandle: '@bhorowitz',
          text: 'They put my father R.I.P. on a hate group list and nearly destroyed his non-profit.'
        }
      }),
      ''
    );
  });
});

describe('parseAdaptiveDraftResult', () => {
  it('parses a ready result', () => {
    const result = parseAdaptiveDraftResult(JSON.stringify({
      status: 'ready',
      strategyType: 'humor',
      baseTone: 'funny',
      reply: 'That joke has legs.',
      reason: ''
    }));

    assert.deepEqual(result, {
      status: 'ready',
      strategyType: 'humor',
      baseTone: 'funny',
      text: 'That joke has legs.',
      reason: ''
    });
  });

  it('parses a skipped result', () => {
    const result = parseAdaptiveDraftResult(JSON.stringify({
      status: 'skipped',
      strategyType: null,
      baseTone: null,
      reply: '',
      reason: 'Too thin'
    }));

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'Too thin');
  });

  it('throws on invalid strategy types', () => {
    assert.throws(
      () => parseAdaptiveDraftResult(JSON.stringify({
        status: 'ready',
        strategyType: 'unknown',
        baseTone: 'smart',
        reply: 'hello',
        reason: ''
      })),
      /invalid strategy type/
    );
  });
});

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

  it('returns Claude text content', async () => {
    mockFetch();
    const result = await generateReply('test', 'smart', null, {
      anthropicApiKey: 'sk-test',
      activeModel: 'claude-haiku'
    });
    assert.equal(result, 'mocked reply');
  });

  it('returns Gemini text content', async () => {
    mockFetch();
    const result = await generateReply('test', 'smart', null, {
      geminiApiKey: 'AIza-test',
      activeModel: 'gemini-3.1-flash-lite-preview'
    });
    assert.equal(result, 'mocked gemini reply');
  });

  it('throws on unsupported local models in direct API path', async () => {
    await assert.rejects(
      () => generateReply('test', 'smart', null, { activeModel: 'gemini-cli-local' }),
      { message: 'Unsupported active model: gemini-cli-local' }
    );
    await assert.rejects(
      () => generateReply('test', 'smart', null, { activeModel: 'claude-code-haiku-local' }),
      { message: 'Unsupported active model: claude-code-haiku-local' }
    );
  });

  it('includes poster handle in the user message', async () => {
    mockFetch((url, opts) => {
      if (!url.includes('anthropic')) return;
      const body = JSON.parse(opts.body);
      assert.match(body.messages[0].content, /by @elonmusk/);
    });

    await generateReply('test tweet', 'smart', null, {
      anthropicApiKey: 'sk-test',
      activeModel: 'claude-haiku'
    }, {
      posterHandle: '@elonmusk',
      threadTweets: ['test tweet']
    });
  });
});
