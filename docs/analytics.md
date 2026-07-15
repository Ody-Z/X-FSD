# Analytics

The analytics subsystem records sent replies locally, syncs X API v2 metrics when configured, and renders a full dashboard in an extension page.

## Data Flow

1. `content.js` calls `RECORD_ANALYTICS_REPLY` after `sendDraft()` succeeds.
2. `background.js` normalizes the event with `createReplyAnalyticsRecord()` and stores it in IndexedDB through `lib/analytics-db.js`.
3. If an X API user access token is configured, `background.js` tries to resolve the owned reply post id by reading the configured user's recent posts.
4. Automatic sync runs after sends, when the dashboard opens, every five minutes while the dashboard stays open, and through the hourly background alarm.
5. `lib/x-api.js` fetches X API v2 metrics for owned reply posts.
6. Metric snapshots are appended to the local reply event and shown in `analytics/analytics.html`.

## X API Scope

Enterprise Engagement API is intentionally out of scope. The dashboard does not use `user_follows`, so it does not report follower conversion.

The configured X app should use OAuth 2.0 user context with:

- `tweet.read`
- `users.read`
- `offline.access`

The popup Analytics tab shows the extension redirect URL. Add that exact URL to the X app's Callback URI / Redirect URL, paste the OAuth 2.0 Client ID into the popup, then click Connect X.
The Connect X flow uses OAuth 2.0 PKCE, verifies the returned token with `GET /2/users/me`, and only stores the token after that check succeeds. X API v2 requests try `api.x.com` first and retry `api.twitter.com` when the newer host rejects an otherwise scoped user token with 401. If X rejects the token on both hosts, the popup shows the failing OAuth step plus the X API status/body summary instead of saving a token that would fail later in the dashboard.

Recommended X Developer Console settings:

- App permissions: Read.
- Type of App: Native App.
- Callback URI / Redirect URL: the URL shown in the popup.
- Website URL: any real HTTPS project, profile, or repository URL.
- Do not request email from users.

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

- reply value move, normally `case_data`, `first_hand`, or `boundary_condition`, derived from `strategyType` with legacy labels retained for older events;
- target category, derived from target text and extracted context;
- target age at reply time.

Metric snapshots are scheduled around 1h, 6h, 24h, 72h, and 7d after sending.

## Dashboard

The popup Analytics tab stores the X API OAuth Client ID, starts the Connect X flow, disconnects stored tokens, and opens the dashboard. The full dashboard lives at:

```text
analytics/analytics.html
```

The page reads IndexedDB directly and calls the background worker for metric syncs.
