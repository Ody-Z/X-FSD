const X_API_BASE_URL = 'https://api.x.com/2';
const X_API_FALLBACK_BASE_URLS = ['https://api.twitter.com/2'];
const X_OAUTH_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
const X_OAUTH_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const X_OAUTH_SCOPES = ['tweet.read', 'users.read', 'offline.access'];
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

function base64UrlEncode(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createRandomBase64Url(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function createCodeChallenge(codeVerifier) {
  const bytes = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return base64UrlEncode(new Uint8Array(digest));
}

async function createPkcePair() {
  const codeVerifier = createRandomBase64Url(32);
  const codeChallenge = await createCodeChallenge(codeVerifier);
  return { codeVerifier, codeChallenge };
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

function isXApiAuthError(error) {
  return error instanceof XApiError && error.status === 401;
}

async function fetchXApiJson(path, token, options = {}) {
  if (!token) {
    throw new XApiError('X API User Access Token is not configured.');
  }

  const candidateUrls = path.startsWith('http')
    ? [path]
    : [X_API_BASE_URL, ...X_API_FALLBACK_BASE_URLS].map((baseUrl) => `${baseUrl}${path}`);
  let authError = null;

  for (const url of candidateUrls) {
    try {
      return await fetchXApiJsonUrl(url, token, options);
    } catch (error) {
      if (!(error instanceof XApiError) || error.status !== 401 || path.startsWith('http')) {
        throw error;
      }
      authError = authError || error;
    }
  }

  throw authError || new XApiError('X API request failed.');
}

async function fetchXApiJsonUrl(url, token, options = {}) {
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

function buildXOAuthAuthorizeUrl({
  clientId,
  redirectUri,
  state,
  codeChallenge,
  scopes = X_OAUTH_SCOPES
}) {
  const cleanClientId = normalizeWhitespace(clientId);
  const cleanRedirectUri = normalizeWhitespace(redirectUri);
  if (!cleanClientId) throw new XApiError('X API Client ID is not configured.');
  if (!cleanRedirectUri) throw new XApiError('X API Redirect URL is unavailable.');
  if (!state) throw new XApiError('OAuth state is missing.');
  if (!codeChallenge) throw new XApiError('OAuth code challenge is missing.');

  const params = [
    ['response_type', 'code'],
    ['client_id', cleanClientId],
    ['redirect_uri', cleanRedirectUri],
    ['scope', scopes.join(' ')],
    ['state', state],
    ['code_challenge', codeChallenge],
    ['code_challenge_method', 'S256']
  ];
  const query = params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${X_OAUTH_AUTHORIZE_URL}?${query}`;
}

async function postXOAuthToken(params) {
  const response = await fetch(X_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
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
    const message = body?.error_description || body?.detail || body?.error || `X OAuth token request failed with status ${response.status}.`;
    throw new XApiError(message, { status: response.status, body });
  }

  return body || {};
}

async function exchangeXOAuthCode({
  clientId,
  redirectUri,
  code,
  codeVerifier
}) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: normalizeWhitespace(clientId),
    redirect_uri: normalizeWhitespace(redirectUri),
    code: normalizeWhitespace(code),
    code_verifier: normalizeWhitespace(codeVerifier)
  });
  return postXOAuthToken(params);
}

async function refreshXOAuthToken({
  clientId,
  refreshToken
}) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: normalizeWhitespace(clientId),
    refresh_token: normalizeWhitespace(refreshToken)
  });
  return postXOAuthToken(params);
}

async function fetchAuthenticatedUser(token) {
  const body = await fetchXApiJson('/users/me', token);
  if (!body?.data?.id) throw new XApiError('Could not read the authenticated X user.', { body });
  return body.data;
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

async function resolveReplyPostIds({ settings, events, maxResults = 100 }) {
  const token = getXApiUserToken(settings);
  const username = normalizeHandle(settings?.username || events?.[0]?.ownerUsername || '');
  const unresolvedEvents = Array.isArray(events)
    ? events.filter((event) => event?.targetPostId && !event.replyPostId)
    : [];
  if (!token || !username || unresolvedEvents.length === 0) return new Map();

  const user = await fetchUserByUsername(username, token);
  const tweets = await fetchUserRecentTweets(user.id, token, maxResults);
  const resolved = new Map();

  for (const event of unresolvedEvents) {
    const reply = findMatchingReplyTweet(tweets, event);
    if (!reply?.id) continue;
    resolved.set(event.id, {
      id: reply.id,
      createdAt: Date.parse(reply.created_at || '') || 0,
      tweetUrl: `https://x.com/${username}/status/${reply.id}`,
      raw: reply
    });
  }

  return resolved;
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
    if (!(error instanceof XApiError) || ![400, 403].includes(error.status)) throw error;
    return {
      tweets: await fetchWithFields(PUBLIC_TWEET_FIELDS),
      privateMetricsAvailable: false,
      warning: error.message
    };
  }
}

export {
  X_OAUTH_SCOPES,
  XApiError,
  buildXOAuthAuthorizeUrl,
  createPkcePair,
  exchangeXOAuthCode,
  fetchAuthenticatedUser,
  fetchTweetMetricsByIds,
  fetchUserByUsername,
  fetchUserRecentTweets,
  findMatchingReplyTweet,
  getXApiUserToken,
  hasXApiUserToken,
  isXApiAuthError,
  refreshXOAuthToken,
  resolveReplyPostId,
  resolveReplyPostIds
};
