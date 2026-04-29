const X_API_BASE_URL = 'https://api.x.com/2';
const DEFAULT_TWEET_FIELDS = [
  'created_at',
  'public_metrics',
  'non_public_metrics',
  'organic_metrics',
  'referenced_tweets',
  'conversation_id'
];
const PUBLIC_TWEET_FIELDS = [
  'created_at',
  'public_metrics',
  'referenced_tweets',
  'conversation_id'
];

class XApiError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = 'XApiError';
    this.status = status;
    this.body = body;
  }
}

function normalizeWhitespace(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

function normalizeHandle(handle) {
  return normalizeWhitespace(handle).replace(/^@/, '');
}

function normalizeForMatch(text) {
  return normalizeWhitespace(text)
    .replace(/^(@[a-z0-9_]+\s+)+/i, '')
    .toLowerCase();
}

function getXApiUserToken(settings = {}) {
  return normalizeWhitespace(settings.xApiUserAccessToken || settings.xApiBearerToken || '');
}

function hasXApiUserToken(settings = {}) {
  return Boolean(getXApiUserToken(settings));
}

async function fetchXApiJson(path, token, options = {}) {
  if (!token) {
    throw new XApiError('X API User Access Token is not configured.');
  }

  const url = path.startsWith('http') ? path : `${X_API_BASE_URL}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const message = body?.detail || body?.title || body?.errors?.[0]?.message || `X API request failed with status ${response.status}.`;
    throw new XApiError(message, { status: response.status, body });
  }

  return body || {};
}

async function fetchUserByUsername(username, token) {
  const handle = normalizeHandle(username);
  if (!handle) throw new XApiError('X username is not configured.');

  const params = new URLSearchParams({
    'user.fields': 'created_at,description,public_metrics,verified'
  });
  const body = await fetchXApiJson(`/users/by/username/${encodeURIComponent(handle)}?${params.toString()}`, token);
  if (!body?.data?.id) throw new XApiError(`Could not find X user @${handle}.`, { body });
  return body.data;
}

async function fetchUserRecentTweets(userId, token, maxResults = 10) {
  const params = new URLSearchParams({
    max_results: String(Math.max(5, Math.min(maxResults, 100))),
    exclude: 'retweets',
    'tweet.fields': PUBLIC_TWEET_FIELDS.join(',')
  });
  const body = await fetchXApiJson(`/users/${encodeURIComponent(userId)}/tweets?${params.toString()}`, token);
  return Array.isArray(body?.data) ? body.data : [];
}

function isReplyToTarget(tweet, targetPostId) {
  const referencedTweets = Array.isArray(tweet?.referenced_tweets) ? tweet.referenced_tweets : [];
  return referencedTweets.some((ref) => ref?.type === 'replied_to' && String(ref.id) === String(targetPostId));
}

function findMatchingReplyTweet(tweets, event) {
  const targetPostId = normalizeWhitespace(event?.targetPostId || '');
  const expectedReplyText = normalizeForMatch(event?.replyText || '');
  const sentAt = Number.isFinite(event?.sentAt) ? event.sentAt : 0;
  const minCreatedAt = sentAt ? sentAt - 10 * 60 * 1000 : 0;

  return tweets
    .filter((tweet) => {
      if (!tweet?.id || !isReplyToTarget(tweet, targetPostId)) return false;
      const createdAt = Date.parse(tweet.created_at || '');
      if (minCreatedAt && Number.isFinite(createdAt) && createdAt < minCreatedAt) return false;
      const tweetText = normalizeForMatch(tweet.text || '');
      return !expectedReplyText ||
        tweetText.includes(expectedReplyText) ||
        expectedReplyText.includes(tweetText);
    })
    .sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''))[0] || null;
}

async function resolveReplyPostId({ settings, event }) {
  const token = getXApiUserToken(settings);
  const username = normalizeHandle(settings?.username || event?.ownerUsername || '');
  if (!token || !username || !event?.targetPostId) return null;

  const user = await fetchUserByUsername(username, token);
  const tweets = await fetchUserRecentTweets(user.id, token, 20);
  const reply = findMatchingReplyTweet(tweets, event);
  if (!reply) return null;

  return {
    id: reply.id,
    createdAt: Date.parse(reply.created_at || '') || 0,
    tweetUrl: `https://x.com/${username}/status/${reply.id}`,
    raw: reply
  };
}

async function fetchTweetMetricsByIds(ids, settings) {
  const token = getXApiUserToken(settings);
  const uniqueIds = Array.from(new Set(ids.map((id) => normalizeWhitespace(id)).filter(Boolean))).slice(0, 100);
  if (uniqueIds.length === 0) return { tweets: [], privateMetricsAvailable: false };

  const fetchWithFields = async (fields) => {
    const params = new URLSearchParams({
      ids: uniqueIds.join(','),
      'tweet.fields': fields.join(',')
    });
    const body = await fetchXApiJson(`/tweets?${params.toString()}`, token);
    return Array.isArray(body?.data) ? body.data : [];
  };

  try {
    return {
      tweets: await fetchWithFields(DEFAULT_TWEET_FIELDS),
      privateMetricsAvailable: true
    };
  } catch (error) {
    if (!(error instanceof XApiError) || ![400, 401, 403].includes(error.status)) throw error;
    return {
      tweets: await fetchWithFields(PUBLIC_TWEET_FIELDS),
      privateMetricsAvailable: false,
      warning: error.message
    };
  }
}

export {
  XApiError,
  fetchTweetMetricsByIds,
  fetchUserByUsername,
  fetchUserRecentTweets,
  findMatchingReplyTweet,
  getXApiUserToken,
  hasXApiUserToken,
  resolveReplyPostId
};
