# Storage And State

The extension uses Chrome local storage for settings, handoffs, sent-post dedupe, and style-learning examples. The content script also keeps transient in-memory draft state.

## Chrome Storage Keys

### `settings`

Saved by the popup and read by popup, background, and content scripts.

Fields:

- `anthropicApiKey`
- `moonshotApiKey`
- `geminiApiKey`
- `activeModel`
- `username`
- `autoDraftsEnabled`
- `onboardingCompleted`
- `voiceProfile`

`voiceProfile` contains:

- `displayName`
- `identity`
- `viewpoints`
- `toneRules`
- `avoid`
- `writingSamples`
- `systemPrompt`
- `choiceSelections`

`utils/storage.js` and `background.js` both merge saved settings with defaults so missing nested fields do not break older installs.

### `prompt_auto`

Owned by `background.js`. Stores:

```js
{
  comparisons: [
    {
      originalPost,
      aiGenerated,
      userFinal,
      strategyType,
      baseTone,
      timestamp
    }
  ]
}
```

Only the latest 25 comparisons are kept. Full regeneration uses recent comparisons as style references.

### `tone_*`

Legacy tone storage for `supportive`, `question`, `smart`, and `funny`. `background.js` can migrate recent legacy comparisons into `prompt_auto` when no `prompt_auto` key exists.

### `xga_draft_handoffs`

Owned by `content.js`. Used when opening a post detail tab from a feed card or auto-sending offscreen posts.

Each value stores:

- status,
- strategy/base tone,
- `autoText` and `editedText`,
- model label and error,
- poster handle, post text, tweet URL, created time,
- `savedAt`,
- `autoSend`.

The receiving content script applies the handoff to the matching draft record and then deletes the handoff key.

### `xga_sent_posts`

Owned by `content.js`. Used to avoid drafting or sending the same post repeatedly across page refreshes and tabs.

Each value stores:

- tweet URL,
- poster handle,
- original post text,
- final draft text,
- created time,
- sent time.

The registry is capped at 500 entries.

## Content Script State

`content.js` keeps a singleton `state` object:

- `drafts`: `Map<postId, record>`
- `visibleIds`
- `priorityIds`
- `overlayRoot`
- `drawerRoot`
- `activeGenerationCount`
- `inFlightPostIds`
- `expandedDeckCardId`
- `sentHistory`
- `sentCount`
- `persistedSentPosts`
- `draftHandoffs`
- `refreshScheduled`
- `ownUsername`

This state is transient. It is rebuilt from the DOM, settings, sent registry, and handoff storage after page load.

## Draft Record Statuses

- `idle`: tracked but not queued.
- `queued`: ready for generation.
- `generating`: provider request in flight.
- `ready`: draft is editable and sendable.
- `failed`: generation or send failed; user can regenerate or open/send when applicable.
- `skipped`: skipped by rule, model, or user.
- `sending`: send flow is in progress.
- `sent`: send completed in the current session.

## Cache Invalidation

`background.js` caches settings, legacy tone data, and `prompt_auto`. `chrome.storage.onChanged` clears affected caches.

`content.js` watches `settings` and `xga_sent_posts`. Settings changes update `ownUsername` and remove own drafts. Sent-post changes rebuild the sent registry and remove persisted sent drafts.
