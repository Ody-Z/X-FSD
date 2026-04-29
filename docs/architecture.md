# Architecture

X Growth Assistant is a Chrome MV3 extension for generating and sending voice-matched replies on X. The runtime is split across a popup, a content script, a background service worker, shared prompt/model libraries, and optional localhost bridges.

## Runtime Pieces

- `manifest.json` declares the MV3 extension, X host permissions, provider API host permissions, localhost bridge access, the background service worker, popup, and content script injection.
- `popup/popup.html`, `popup/popup.js`, and `popup/popup.css` implement settings and onboarding.
- `analytics/analytics.html`, `analytics/analytics.js`, and `analytics/analytics.css` implement the full reply analytics dashboard.
- `content.js` runs on `https://*.x.com/*`, observes the feed, extracts candidate post context, renders injected UI, generates drafts through the background worker, and sends replies through X's DOM.
- `content.css` styles injected inline cards, drawer cards, and offscreen decks.
- `background.js` handles extension messages, reads cached settings, builds prompts, routes provider calls, saves style-learning comparisons, opens post tabs, stores analytics events, and syncs X API metrics.
- `lib/api.js` contains prompt builders, context normalization, skip-rule helpers, provider API callers, and adaptive draft result parsing.
- `lib/analytics.js`, `lib/analytics-db.js`, and `lib/x-api.js` normalize analytics events, manage IndexedDB, and call X API v2.
- `lib/local-cli.js` calls localhost bridge HTTP endpoints from the extension context.
- `bridge/gemini-cli-bridge.js` and `bridge/claude-code-bridge.js` run as local Node servers and shell out to local CLIs.
- `lib/token-usage.js` and `bridge/token-usage-csv.js` normalize token usage and append CSV rows.
- `utils/storage.js` defines popup-side default settings and merge behavior.

## Main Flow

1. The user completes popup settings and onboarding. Settings are stored under the `settings` Chrome storage key.
2. `content.js` initializes on X, loads settings-derived local state, creates overlay roots, and starts a `MutationObserver`.
3. Each refresh collects candidate `article` nodes, dedupes them by post id, computes visible/priority ids, and queues eligible idle records.
4. Queued records call `chrome.runtime.sendMessage({ type: 'GENERATE_DRAFT' })`.
5. `background.js` builds a quick or full prompt, applies skip rules, calls the selected model path, parses the result, and returns a normalized draft response.
6. `content.js` updates the draft record, renders inline cards or decks, and lets the user edit, regenerate, skip, open, or send.
7. Sending opens X's reply composer, inserts the final text, clicks the send button, stores sent metadata, records a local analytics event, and saves an edit comparison for future full-quality prompts.
8. The analytics dashboard reads local IndexedDB events and asks `background.js` to sync X API v2 metrics for owned reply posts when requested.

## Message Contracts

- `GENERATE_DRAFT`: sent by `content.js`; handled by `background.js`; returns `ready`, `skipped`, or `failed` plus strategy, base tone, text, reason, token usage, and model label.
- `SAVE_COMPARISON`: sent after a successful edited send; handled by `background.js`; appends an entry to `prompt_auto`.
- `OPEN_POST_TAB`: sent by `content.js`; handled by `background.js`; opens an allowed `https://*.x.com/...` URL in a new active tab.
- `OPEN_ANALYTICS_DASHBOARD`: sent by the popup; handled by `background.js`; opens the extension dashboard page.
- `RECORD_ANALYTICS_REPLY`: sent by `content.js` after a successful send; handled by `background.js`; stores the sent reply event in IndexedDB and tries to resolve the owned reply id.
- `SYNC_ANALYTICS_METRICS`: sent by the popup, dashboard, or alarm; handled by `background.js`; syncs X API v2 metrics into local snapshots.
- `GET_TONE_DATA` and `SYNC_TONE_TO_STORAGE`: legacy tone-data helpers still exposed by `background.js`.

## Design Constraints

- Auto drafts are only queued on the X home feed. Post detail pages can consume handoffs and send, but they do not scan arbitrary unsupported pages.
- Draft targets are limited to posts newer than two hours.
- Own posts are skipped using the saved username.
- The content script avoids re-rendering while a draft textarea is focused so user edits are not lost.
- Local bridge calls are CORS-enabled localhost HTTP calls, not direct extension subprocess execution.
