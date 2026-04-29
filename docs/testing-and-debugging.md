# Testing And Debugging

## Commands

Run the full test suite:

```sh
npm test
```

Syntax-check individual scripts:

```sh
node --check content.js
node --check background.js
node --check bridge/gemini-cli-bridge.js
node --check bridge/claude-code-bridge.js
```

Check whitespace in diffs:

```sh
git diff --check
```

## Test Coverage

Current tests cover:

- prompt builders and adaptive draft parsing,
- skip rules,
- provider call helpers,
- token usage extraction and CSV formatting,
- local bridge request payloads,
- Gemini CLI output parsing and runtime slot path isolation,
- Claude Code output/auth parsing and bridge invocation shape.

## Local Bridge Checks

Start Gemini CLI bridge:

```sh
npm run bridge
```

Check health:

```sh
curl -sS http://127.0.0.1:43117/health
```

Start Claude Code bridge:

```sh
npm run bridge:claude
```

Check health:

```sh
curl -sS http://127.0.0.1:43118/health
```

## Log Files

- Gemini bridge trace: `/tmp/xga-gemini-bridge.log`
- Claude bridge trace: `/tmp/xga-claude-code-bridge.log`
- token CSV: `/tmp/xga-token-usage.csv`

Useful commands:

```sh
tail -n 120 /tmp/xga-gemini-bridge.log
tail -n 120 /tmp/xga-claude-code-bridge.log
tail -n 40 /tmp/xga-token-usage.csv
```

## Common Failure Modes

### `Gemini CLI is not reachable`

The extension could not reach `http://127.0.0.1:43117`. Start `npm run bridge` and reload the extension/X tab.

### `Gemini CLI timed out while generating a reply`

The bridge killed a local `gemini` process after the request timeout. Check `/tmp/xga-gemini-bridge.log` for whether stdout/stderr stopped after `Loaded cached credentials.`. The Gemini bridge now uses isolated runtime slots to reduce shared cache stalls.

### `Claude Code is not authenticated`

Run `claude auth login` locally, then restart `npm run bridge:claude`.

### Post sends fail from the feed

If X unmounts a feed article, `content.js` should save a draft handoff and open the post URL in a new tab for auto-send. If that does not happen, inspect `xga_draft_handoffs` in Chrome local storage and watch the X tab console for `[XGA]` logs.

### Ready deck closes while editing

Deck textareas stop keyboard event propagation. If this regresses, inspect `isInteractiveCardTarget()` and `keepTextInputKeyEventsLocal()` in `content.js`.

### Duplicate drafts after sending

Check `xga_sent_posts` in Chrome local storage. Sent posts are persisted there and removed from future candidate scans.

## Chrome Extension Reload

After changing extension source files:

1. Open `chrome://extensions`.
2. Reload the unpacked extension.
3. Refresh the X tab.
4. Restart local bridge processes when bridge files changed.
