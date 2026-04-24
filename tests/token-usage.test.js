import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTokenUsageCsvHeader,
  buildTokenUsageCsvRow,
  createEstimatedTokenUsage,
  extractAnthropicTokenUsage,
  extractGeminiCliStatsTokenUsage,
  extractGeminiTokenUsage,
  extractGenericTokenUsage,
  extractOpenAiTokenUsage
} from '../lib/token-usage.js';

describe('token usage helpers', () => {
  it('extracts Anthropic usage', () => {
    assert.deepEqual(extractAnthropicTokenUsage({
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 4
      }
    }), {
      inputTokens: 10,
      outputTokens: 3,
      totalTokens: 13,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 4,
      estimated: false,
      source: 'anthropic'
    });
  });

  it('extracts OpenAI-compatible usage', () => {
    assert.deepEqual(extractOpenAiTokenUsage({
      usage: {
        prompt_tokens: 20,
        completion_tokens: 5,
        total_tokens: 25
      }
    }, 'kimi'), {
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      estimated: false,
      source: 'kimi'
    });
  });

  it('extracts Gemini usage metadata', () => {
    assert.deepEqual(extractGeminiTokenUsage({
      usageMetadata: {
        promptTokenCount: 30,
        candidatesTokenCount: 7,
        totalTokenCount: 37
      }
    }), {
      inputTokens: 30,
      outputTokens: 7,
      totalTokens: 37,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      estimated: false,
      source: 'gemini'
    });
  });

  it('finds nested CLI token stats', () => {
    assert.deepEqual(extractGenericTokenUsage({
      response: 'hello',
      stats: {
        models: [{
          promptTokens: 14,
          completionTokens: 4,
          totalTokens: 18
        }]
      }
    }, 'gemini-cli'), {
      inputTokens: 14,
      outputTokens: 4,
      totalTokens: 18,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      estimated: false,
      source: 'gemini-cli'
    });
  });

  it('extracts Gemini CLI stats token usage', () => {
    assert.deepEqual(extractGeminiCliStatsTokenUsage({
      response: 'hello',
      stats: {
        models: {
          'flash-lite': {
            tokens: {
              input: 100,
              prompt: 120,
              candidates: 12,
              total: 132,
              cached: 20
            }
          }
        }
      }
    }), {
      inputTokens: 100,
      outputTokens: 12,
      totalTokens: 132,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: 20,
      estimated: false,
      source: 'gemini-cli'
    });
  });

  it('builds estimated usage and CSV rows', () => {
    const tokenUsage = createEstimatedTokenUsage({
      systemPrompt: 'system prompt',
      userPrompt: 'user prompt',
      outputText: 'reply'
    });
    const row = buildTokenUsageCsvRow({
      timestamp: '2026-01-01T00:00:00.000Z',
      requestId: 'req-1',
      provider: 'gemini-cli-local',
      model: 'flash-lite',
      mode: 'auto',
      phase: 'quick',
      status: 'ready',
      tokenUsage,
      replyChars: 5
    });

    assert.match(buildTokenUsageCsvHeader(), /inputTokens,outputTokens,totalTokens/);
    assert.match(row, /^2026-01-01T00:00:00.000Z,req-1,gemini-cli-local,flash-lite,auto,quick,ready/);
    assert.match(row, /,true,estimated,/);
  });
});
