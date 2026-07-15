import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendMetricsSnapshot,
  buildMetricsSnapshot,
  classifyTargetCategory,
  createReplyAnalyticsRecord,
  getTimingWindow,
  summarizeAnalytics
} from '../lib/analytics.js';
import {
  buildXOAuthAuthorizeUrl,
  fetchAuthenticatedUser,
  findMatchingReplyTweet
} from '../lib/x-api.js';

describe('analytics helpers', () => {
  it('classifies high-value target categories', () => {
    assert.equal(classifyTargetCategory('OpenAI launched a new agent benchmark'), 'ai');
    assert.equal(classifyTargetCategory('What do you think about this?', {}), 'question');
    assert.equal(classifyTargetCategory('', { linkedArticle: { title: 'A long post' } }), 'article');
  });

  it('creates reply records with derived timing and reply type', () => {
    const record = createReplyAnalyticsRecord({
      targetPostId: '123',
      targetText: 'We shipped a new AI workflow.',
      targetCreatedAt: 1000,
      replyText: 'this is the bit people miss',
      strategyType: 'case_data',
      sentAt: 121000
    }, 121000);

    assert.equal(record.targetAgeMinutesAtReply, 2);
    assert.equal(record.replyType, 'case_data');
    assert.equal(record.targetCategory, 'ai');
    assert.equal(record.sync.status, 'pending');
  });

  it('builds snapshots from private metrics when present', () => {
    const snapshot = buildMetricsSnapshot({
      id: '999',
      public_metrics: {
        impression_count: 90,
        like_count: 4
      },
      non_public_metrics: {
        impression_count: 100,
        user_profile_clicks: 5,
        engagements: 9
      }
    }, 2000);

    assert.equal(snapshot.impressions, 100);
    assert.equal(snapshot.profileClicks, 5);
    assert.equal(snapshot.profileIntent, 0.05);
    assert.equal(snapshot.hasPrivateMetrics, true);
  });

  it('summarizes reply cohorts by type and target category', () => {
    const first = appendMetricsSnapshot(createReplyAnalyticsRecord({
      id: 'a',
      targetPostId: '1',
      targetText: 'AI agents are getting useful',
      replyText: 'yep',
      strategyType: 'case_data',
      sentAt: 10
    }, 10), {
      capturedAt: 100,
      impressions: 1000,
      profileClicks: 20,
      profileIntent: 0.02
    });
    const second = appendMetricsSnapshot(createReplyAnalyticsRecord({
      id: 'b',
      targetPostId: '2',
      targetText: 'What would you build?',
      replyText: 'curious about this',
      strategyType: 'boundary_condition',
      sentAt: 20
    }, 20), {
      capturedAt: 100,
      impressions: 500,
      profileClicks: 20,
      profileIntent: 0.04
    });

    const summary = summarizeAnalytics([first, second], { now: 1000, days: 1 });
    assert.equal(summary.totalReplies, 2);
    assert.equal(summary.totalImpressions, 1500);
    assert.equal(summary.totalProfileClicks, 40);
    assert.equal(summary.byReplyType[0].key, 'boundary_condition');
    assert.equal(summary.byTargetCategory.some((row) => row.key === 'ai'), true);
  });

  it('labels target age windows', () => {
    assert.equal(getTimingWindow(3), '0-5m');
    assert.equal(getTimingWindow(20), '15-30m');
    assert.equal(getTimingWindow(90), '60-120m');
  });
});

describe('x api matching helpers', () => {
  it('builds an OAuth authorize URL with PKCE fields', () => {
    const url = new URL(buildXOAuthAuthorizeUrl({
      clientId: 'client-123',
      redirectUri: 'https://example.chromiumapp.org/x-oauth',
      state: 'state-1',
      codeChallenge: 'challenge-1'
    }));

    assert.equal(url.origin + url.pathname, 'https://x.com/i/oauth2/authorize');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), 'client-123');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://example.chromiumapp.org/x-oauth');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(url.searchParams.get('scope'), /tweet\.read/);
    assert.match(url.searchParams.get('scope'), /offline\.access/);
    assert.match(url.toString(), /scope=tweet\.read%20users\.read%20offline\.access/);
    assert.ok(!url.toString().includes('scope=tweet.read+users.read'));
  });

  it('verifies the OAuth user token with the minimal users/me request', async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = '';
    let capturedAuth = '';
    globalThis.fetch = async (url, options = {}) => {
      capturedUrl = url;
      capturedAuth = options.headers?.Authorization || '';
      return new Response(JSON.stringify({
        data: {
          id: 'user-1',
          username: 'odyzhou'
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const user = await fetchAuthenticatedUser('user-token-1');
      assert.equal(capturedUrl, 'https://api.x.com/2/users/me');
      assert.equal(capturedAuth, 'Bearer user-token-1');
      assert.equal(user.username, 'odyzhou');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to the legacy Twitter API host when api.x.com rejects the user token', async () => {
    const originalFetch = globalThis.fetch;
    const capturedUrls = [];
    globalThis.fetch = async (url) => {
      capturedUrls.push(url);
      if (url === 'https://api.x.com/2/users/me') {
        return new Response(JSON.stringify({
          title: 'Unauthorized',
          detail: 'Unauthorized',
          type: 'about:blank'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({
        data: {
          id: 'user-1',
          username: 'odyzhou'
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const user = await fetchAuthenticatedUser('user-token-1');
      assert.deepEqual(capturedUrls, [
        'https://api.x.com/2/users/me',
        'https://api.twitter.com/2/users/me'
      ]);
      assert.equal(user.username, 'odyzhou');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('matches a recent owned reply to the target post', () => {
    const match = findMatchingReplyTweet([
      {
        id: 'reply-1',
        text: '@someone this is the bit people miss',
        created_at: new Date(20_000).toISOString(),
        referenced_tweets: [{ type: 'replied_to', id: 'target-1' }]
      }
    ], {
      targetPostId: 'target-1',
      replyText: 'this is the bit people miss',
      sentAt: 19_000
    });

    assert.equal(match.id, 'reply-1');
  });
});
