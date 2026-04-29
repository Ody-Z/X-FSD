# Auto Drafts

Auto drafts are the main user-facing workflow. The content script scans the X home feed, queues drafts for good candidates, renders the reply UI, and sends replies.

## Candidate Discovery

`content.js` collects `article` nodes from X and keeps only valid reply targets:

- promoted posts are filtered by placement tracking and ad/promoted badges,
- posts must have an enabled reply button,
- post id and URL are extracted from `/status/` links,
- created time is read from `time[datetime]`,
- stale posts older than two hours are ignored or marked skipped,
- own posts are skipped using the saved username,
- posts need usable text, quoted-post context, image context, or linked article preview context.

The collector extracts:

- main post text from `[data-testid="tweetText"]`,
- poster handle from `[data-testid="User-Name"]`,
- quoted tweet text, poster, URL, and media,
- post and quoted image URLs from `pbs.twimg.com`,
- linked article card title, excerpt, and URL.

Only `home-feed` pages queue new auto drafts. `status-detail` pages are used for handoff sending.

## Draft Record Lifecycle

Each tracked post is stored in `state.drafts` with fields such as:

- `postId`, `article`, `text`, `tweetUrl`, `createdAt`, `posterHandle`, `context`,
- `status`: `idle`, `queued`, `generating`, `ready`, `failed`, `skipped`, `sending`, or `sent`,
- `strategyType`, `baseTone`, `autoText`, `editedText`, `modelLabel`, `error`,
- `autoSendRequested`, `autoSendOffloaded`.

`MAX_TRACKED_POSTS` is 48. Old offscreen records are pruned when the map grows too large.

## Queueing

`computePriority()` ranks:

- the centered visible post,
- visible posts from top to bottom,
- a small lookahead below the viewport.

Idle priority records become `queued` on the home feed. `processQueue()` starts up to `AUTO_DRAFT_CONCURRENCY` active generations. The current value is 3.

Quick generation sends:

```js
{
  type: 'GENERATE_DRAFT',
  mode: 'auto',
  phase: 'quick',
  tweetText,
  context,
  requestId
}
```

Regeneration uses `phase: 'full'`, passes the current draft, and enables style references in the background prompt.

## Rendering

The content script creates two roots:

- `.xga-overlay-root` for inline cards beside visible feed posts,
- `.xga-drawer-root` for drawer/deck layouts.

Large layouts show up to two inline cards beside visible posts plus deck rail sections for offscreen records. Narrow layouts or layouts without horizontal room use drawer mode.

Deck sections:

- Ready: offscreen `ready` or `failed` records.
- Processing: offscreen `queued` or `generating` records.
- Sent: session sent history.

Ready cards can be expanded. Textareas stop `keydown` and `keyup` propagation so space/Enter editing does not collapse cards or trigger X shortcuts.

## User Actions

- Send: sends the current edited text.
- Open Post: scrolls to the mounted article if available, otherwise saves a handoff and opens the post URL in a new tab.
- Regenerate: runs a full-quality pass with current draft/style context.
- Skip: marks the record as `skipped`.
- Edit: updates `record.editedText` live in the textarea.

## Sending

`sendDraft()` resolves the post article, checks freshness, opens X's reply composer, inserts text, waits for an enabled send button, clicks it, and waits for the dialog to close.

Text insertion uses `document.execCommand('insertText')` first, then falls back to direct contenteditable text mutation and `input`/`change` events.

After successful send:

- the record becomes `sent`,
- sent history is updated for this session,
- the persistent sent registry is updated,
- a `RECORD_ANALYTICS_REPLY` message records the local analytics event,
- a `SAVE_COMPARISON` message records original post, AI draft, user final text, strategy, base tone, and timestamp.

## Open-Post Auto-Send Handoff

X virtualizes the feed, so a ready post can disappear from the mounted DOM before send. If the article cannot be resolved, or if opening the inline composer fails outside the target post detail page, `sendDraftFromPostTab()`:

1. Saves `xga_draft_handoffs[postId]` with `autoSend: true`.
2. Marks the feed record as `sending` and `autoSendOffloaded`.
3. Opens the post URL in a new active tab through `OPEN_POST_TAB`.
4. The content script on the post detail tab applies the handoff, sees `autoSendRequested`, and calls `sendDraft()` there.

This implements "Open Post + Send" for offscreen or unmounted posts.

## Refresh Loop

`MutationObserver`, scroll, and resize call `scheduleRefresh()`. `refresh()`:

1. collects candidates,
2. syncs records,
3. removes own/sent/stale drafts,
4. computes priority,
5. renders unless a card textarea is active,
6. processes handoff auto-send requests,
7. processes the generation queue.
