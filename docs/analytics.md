# Analytics

The analytics subsystem records sent replies locally, syncs X API v2 metrics when configured, and renders a full dashboard in an extension page.

## Data Flow

1. `content.js` calls `RECORD_ANALYTICS_REPLY` after `sendDraft()` succeeds.
2. `background.js` normalizes the event with `createReplyAnalyticsRecord()` and stores it in IndexedDB through `lib/analytics-db.js`.
3. If an X API user access token is configured, `background.js` tries to resolve the owned reply post id by reading the configured user's recent posts.
4. Manual dashboard sync or the hourly alarm calls `SYNC_ANALYTICS_METRICS`.
5. `lib/x-api.js` fetches X API v2 metrics for owned reply posts.
6. Metric snapshots are appended to the local reply event and shown in `analytics/analytics.html`.

## X API Scope

Enterprise Engagement API is intentionally out of scope. The dashboard does not use `user_follows`, so it does not report follower conversion.

The configured X API token should be a user-context OAuth 2.0 token with:

- `tweet.read`
- `users.read`

For owned reply posts, X API v2 can return:

- `public_metrics.impression_count`
- public likes, replies, reposts, quotes, and bookmarks
- `non_public_metrics.user_profile_clicks`
- `non_public_metrics.engagements`
- `organic_metrics`

If private metrics are unavailable, the sync falls back to public metrics only. In that case impressions still work, but profile intent cannot be calculated.

## Metrics

Primary metrics:

- Reply count by day.
- Reply impressions.
- Profile clicks.
- Profile intent: `profileClicks / impressions`.

Segmentation:

- reply type, derived from `strategyType` and `baseTone`;
- target category, derived from target text and extracted context;
- target age at reply time.

Metric snapshots are scheduled around 1h, 6h, 24h, 72h, and 7d after sending.

## Dashboard

The popup Analytics tab only stores the X API user access token and opens the dashboard. The full dashboard lives at:

```text
analytics/analytics.html
```

The page reads IndexedDB directly and calls the background worker for metric syncs.
