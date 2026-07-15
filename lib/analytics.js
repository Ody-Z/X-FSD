const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const METRIC_SYNC_OFFSETS_MS = [
  HOUR_MS,
  6 * HOUR_MS,
  DAY_MS,
  3 * DAY_MS,
  7 * DAY_MS
];

const REPLY_TYPE_LABELS = {
  case_data: 'Case / Data',
  first_hand: 'First-hand',
  boundary_condition: 'Boundary Condition',
  humor: 'Humor',
  deep_share: 'Insight',
  hot_take: 'Hot Take',
  news: 'Context',
  personal: 'Personal',
  supportive: 'Supportive',
  question: 'Question',
  smart: 'Analytical',
  funny: 'Humor',
  general: 'General'
};

const TARGET_CATEGORY_LABELS = {
  ai: 'AI',
  launch: 'Launch',
  question: 'Question',
  article: 'Article',
  quote: 'Quote',
  media: 'Media',
  company_event: 'Company Event',
  discussion: 'Discussion'
};

function normalizeWhitespace(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

function normalizeHandle(handle) {
  return normalizeWhitespace(handle).replace(/^@/, '');
}

function normalizeMetricNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function getReplyType(strategyType, baseTone, replyText = '') {
  const strategy = normalizeWhitespace(strategyType).toLowerCase();
  if (REPLY_TYPE_LABELS[strategy]) return strategy;

  const tone = normalizeWhitespace(baseTone).toLowerCase();
  if (REPLY_TYPE_LABELS[tone]) return tone;

  const text = normalizeWhitespace(replyText);
  if (/\?$/.test(text)) return 'question';
  return 'general';
}

function getReplyTypeLabel(replyType) {
  return REPLY_TYPE_LABELS[replyType] || REPLY_TYPE_LABELS.general;
}

function getTargetCategoryLabel(category) {
  return TARGET_CATEGORY_LABELS[category] || TARGET_CATEGORY_LABELS.discussion;
}

function classifyTargetCategory(text = '', context = {}) {
  const combined = [
    text,
    context?.linkedArticle?.title,
    context?.linkedArticle?.excerpt,
    context?.quotedTweet?.text
  ].map(normalizeWhitespace).filter(Boolean).join(' ').toLowerCase();

  if (context?.linkedArticle?.title || context?.linkedArticle?.excerpt) return 'article';
  if (/\b(ai|agent|agents|llm|model|models|openai|anthropic|gemini|claude|grok|inference|benchmark)\b/i.test(combined)) return 'ai';
  if (/\b(launch|launched|ship|shipped|shipping|release|released|announcing|introducing|new product|beta)\b/i.test(combined)) return 'launch';
  if (/\?/.test(combined) || /\b(thoughts|wdyt|what do you think|anyone else|how would you)\b/i.test(combined)) return 'question';
  if (context?.quotedTweet?.text || context?.quotedTweet?.url) return 'quote';
  if (context?.quotedTweet?.media?.length || context?.media?.length) return 'media';
  if (/\b(funding|raised|acquired|acquisition|hiring|layoff|ipo|revenue|arr|mrr)\b/i.test(combined)) return 'company_event';
  return 'discussion';
}

function getTargetTraits(context = {}) {
  return {
    hasQuote: Boolean(context?.quotedTweet?.text || context?.quotedTweet?.url || context?.quotedTweet?.media?.length),
    hasMedia: Boolean(context?.media?.length || context?.quotedTweet?.media?.length),
    hasLinkedArticle: Boolean(context?.linkedArticle?.title || context?.linkedArticle?.excerpt || context?.linkedArticle?.url)
  };
}

function createReplyAnalyticsRecord(entry, now = Date.now()) {
  const sentAt = Number.isFinite(entry?.sentAt) ? entry.sentAt : now;
  const targetCreatedAt = Number.isFinite(entry?.targetCreatedAt) ? entry.targetCreatedAt : 0;
  const targetAgeMinutesAtReply = Number.isFinite(entry?.targetAgeMinutesAtReply)
    ? entry.targetAgeMinutesAtReply
    : targetCreatedAt > 0
      ? Math.max(0, Math.round((sentAt - targetCreatedAt) / 60000))
      : null;
  const replyText = normalizeWhitespace(entry?.replyText || '');
  const replyType = entry?.replyType || getReplyType(entry?.strategyType, entry?.baseTone, replyText);
  const targetCategory = entry?.targetCategory || classifyTargetCategory(entry?.targetText, entry?.context);
  const targetPostId = normalizeWhitespace(entry?.targetPostId || '');
  const id = entry?.id || `xga-reply-${sentAt}-${targetPostId || Math.random().toString(36).slice(2, 8)}`;

  return {
    id,
    targetPostId,
    targetTweetUrl: normalizeWhitespace(entry?.targetTweetUrl || ''),
    targetHandle: normalizeWhitespace(entry?.targetHandle || ''),
    targetText: normalizeWhitespace(entry?.targetText || ''),
    targetCreatedAt,
    targetAgeMinutesAtReply,
    targetCategory,
    targetTraits: getTargetTraits(entry?.context),
    replyPostId: normalizeWhitespace(entry?.replyPostId || ''),
    replyTweetUrl: normalizeWhitespace(entry?.replyTweetUrl || ''),
    replyCreatedAt: Number.isFinite(entry?.replyCreatedAt) ? entry.replyCreatedAt : 0,
    replyText,
    autoText: normalizeWhitespace(entry?.autoText || ''),
    edited: Boolean(entry?.edited),
    strategyType: normalizeWhitespace(entry?.strategyType || ''),
    baseTone: normalizeWhitespace(entry?.baseTone || ''),
    replyType,
    modelLabel: normalizeWhitespace(entry?.modelLabel || ''),
    ownerUsername: normalizeHandle(entry?.ownerUsername || ''),
    sentAt,
    metricsLatest: null,
    metricsSnapshots: [],
    sync: {
      status: 'pending',
      lastAttemptAt: 0,
      nextAttemptAt: sentAt + METRIC_SYNC_OFFSETS_MS[0],
      error: ''
    }
  };
}

function buildMetricsSnapshot(tweet, capturedAt = Date.now(), source = 'x-api-v2') {
  const publicMetrics = tweet?.public_metrics || {};
  const nonPublicMetrics = tweet?.non_public_metrics || {};
  const organicMetrics = tweet?.organic_metrics || {};
  const impressions = normalizeMetricNumber(
    nonPublicMetrics.impression_count ??
    organicMetrics.impression_count ??
    publicMetrics.impression_count
  );
  const profileClicks = normalizeMetricNumber(
    nonPublicMetrics.user_profile_clicks ??
    organicMetrics.user_profile_clicks
  );
  const likes = normalizeMetricNumber(organicMetrics.like_count ?? publicMetrics.like_count);
  const replies = normalizeMetricNumber(organicMetrics.reply_count ?? publicMetrics.reply_count);
  const reposts = normalizeMetricNumber(organicMetrics.retweet_count ?? publicMetrics.retweet_count);
  const quotes = normalizeMetricNumber(publicMetrics.quote_count);
  const bookmarks = normalizeMetricNumber(publicMetrics.bookmark_count);
  const engagements = normalizeMetricNumber(nonPublicMetrics.engagements);

  return {
    capturedAt,
    source,
    tweetId: normalizeWhitespace(tweet?.id || ''),
    impressions,
    profileClicks,
    profileIntent: impressions && profileClicks !== null ? profileClicks / impressions : null,
    likes,
    replies,
    reposts,
    quotes,
    bookmarks,
    engagements,
    hasPrivateMetrics: profileClicks !== null || engagements !== null || Boolean(tweet?.non_public_metrics)
  };
}

function getNextMetricSyncAt(event) {
  if (!Number.isFinite(event?.sentAt)) return null;
  const snapshots = Array.isArray(event?.metricsSnapshots) ? event.metricsSnapshots : [];
  const nextOffset = METRIC_SYNC_OFFSETS_MS.find((offset) => {
    const targetTime = event.sentAt + offset;
    return !snapshots.some((snapshot) => Number.isFinite(snapshot?.capturedAt) && snapshot.capturedAt >= targetTime);
  });
  return nextOffset ? event.sentAt + nextOffset : null;
}

function appendMetricsSnapshot(event, snapshot) {
  const snapshots = [
    ...(Array.isArray(event?.metricsSnapshots) ? event.metricsSnapshots : []),
    snapshot
  ].sort((a, b) => (a.capturedAt || 0) - (b.capturedAt || 0));
  const nextAttemptAt = getNextMetricSyncAt({ ...event, metricsSnapshots: snapshots });

  return {
    ...event,
    metricsLatest: snapshots[snapshots.length - 1] || null,
    metricsSnapshots: snapshots,
    sync: {
      ...(event?.sync || {}),
      status: nextAttemptAt ? 'pending' : 'complete',
      lastAttemptAt: snapshot.capturedAt || Date.now(),
      nextAttemptAt,
      error: ''
    }
  };
}

function markAnalyticsSyncError(event, error, now = Date.now()) {
  return {
    ...event,
    sync: {
      ...(event?.sync || {}),
      status: 'failed',
      lastAttemptAt: now,
      nextAttemptAt: now + HOUR_MS,
      error: error?.message || String(error || 'Metric sync failed')
    }
  };
}

function isEventDueForMetricSync(event, now = Date.now(), force = false) {
  if (!event?.replyPostId) return false;
  if (force) return true;
  const nextAttemptAt = Number.isFinite(event?.sync?.nextAttemptAt)
    ? event.sync.nextAttemptAt
    : getNextMetricSyncAt(event);
  return Number.isFinite(nextAttemptAt) && nextAttemptAt <= now;
}

function getDayKey(timestamp, timeZone) {
  const date = new Date(timestamp);
  if (!timeZone) return date.toISOString().slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function getTimingWindow(minutes) {
  if (!Number.isFinite(minutes)) return 'unknown';
  if (minutes < 5) return '0-5m';
  if (minutes < 15) return '5-15m';
  if (minutes < 30) return '15-30m';
  if (minutes < 60) return '30-60m';
  return '60-120m';
}

function createEmptyStats(key, label) {
  return {
    key,
    label,
    replies: 0,
    impressions: 0,
    profileClicks: 0,
    profileIntent: null
  };
}

function addEventToStats(stats, event) {
  const metrics = event.metricsLatest || {};
  stats.replies += 1;
  stats.impressions += metrics.impressions || 0;
  stats.profileClicks += metrics.profileClicks || 0;
  stats.profileIntent = stats.impressions > 0 ? stats.profileClicks / stats.impressions : null;
}

function sortedStats(map) {
  return Array.from(map.values()).sort((a, b) => {
    if ((b.profileIntent || 0) !== (a.profileIntent || 0)) return (b.profileIntent || 0) - (a.profileIntent || 0);
    if (b.impressions !== a.impressions) return b.impressions - a.impressions;
    return b.replies - a.replies;
  });
}

function summarizeAnalytics(events = [], options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const days = Number.isFinite(options.days) ? options.days : 14;
  const timeZone = options.timeZone || undefined;
  const since = now - days * DAY_MS;
  const windowEvents = events
    .filter((event) => Number.isFinite(event?.sentAt) && event.sentAt >= since && event.sentAt <= now)
    .sort((a, b) => b.sentAt - a.sentAt);

  const todayKey = getDayKey(now, timeZone);
  const daily = new Map();
  const byReplyType = new Map();
  const byTargetCategory = new Map();
  const byTimingWindow = new Map();
  const totals = createEmptyStats('total', 'Total');

  for (let index = days - 1; index >= 0; index -= 1) {
    const key = getDayKey(now - index * DAY_MS, timeZone);
    daily.set(key, createEmptyStats(key, key));
  }

  for (const event of windowEvents) {
    addEventToStats(totals, event);

    const dayKey = getDayKey(event.sentAt, timeZone);
    if (!daily.has(dayKey)) daily.set(dayKey, createEmptyStats(dayKey, dayKey));
    addEventToStats(daily.get(dayKey), event);

    const replyType = event.replyType || getReplyType(event.strategyType, event.baseTone, event.replyText);
    if (!byReplyType.has(replyType)) byReplyType.set(replyType, createEmptyStats(replyType, getReplyTypeLabel(replyType)));
    addEventToStats(byReplyType.get(replyType), event);

    const category = event.targetCategory || 'discussion';
    if (!byTargetCategory.has(category)) byTargetCategory.set(category, createEmptyStats(category, getTargetCategoryLabel(category)));
    addEventToStats(byTargetCategory.get(category), event);

    const timingWindow = getTimingWindow(event.targetAgeMinutesAtReply);
    if (!byTimingWindow.has(timingWindow)) byTimingWindow.set(timingWindow, createEmptyStats(timingWindow, timingWindow));
    addEventToStats(byTimingWindow.get(timingWindow), event);
  }

  return {
    generatedAt: now,
    days,
    totalReplies: totals.replies,
    todayReplies: windowEvents.filter((event) => getDayKey(event.sentAt, timeZone) === todayKey).length,
    totalImpressions: totals.impressions,
    totalProfileClicks: totals.profileClicks,
    profileIntent: totals.profileIntent,
    pendingMetrics: events.filter((event) => !event.metricsLatest).length,
    unresolvedReplyIds: events.filter((event) => !event.replyPostId).length,
    daily: Array.from(daily.values()),
    byReplyType: sortedStats(byReplyType),
    byTargetCategory: sortedStats(byTargetCategory),
    byTimingWindow: sortedStats(byTimingWindow),
    recentReplies: windowEvents.slice(0, 80)
  };
}

export {
  DAY_MS,
  HOUR_MS,
  METRIC_SYNC_OFFSETS_MS,
  appendMetricsSnapshot,
  buildMetricsSnapshot,
  classifyTargetCategory,
  createReplyAnalyticsRecord,
  getNextMetricSyncAt,
  getReplyType,
  getReplyTypeLabel,
  getTargetCategoryLabel,
  getTimingWindow,
  isEventDueForMetricSync,
  markAnalyticsSyncError,
  summarizeAnalytics
};
