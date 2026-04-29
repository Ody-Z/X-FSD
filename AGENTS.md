# X Growth Assistant Documentation

This file is the directory page for agents and maintainers. Keep implementation detail in focused files under `docs/`, and update this page when a new workflow or subsystem is added.

## Start Here

- [Architecture](docs/architecture.md) - extension process model, data flow, source-map by responsibility.
- [Onboarding](docs/onboarding.md) - popup voice setup, settings workflow, generated prompt behavior.
- [Auto Drafts](docs/auto-drafts.md) - feed detection, context extraction, queueing, inline/deck UI, send/open-post flows.
- [Model Providers](docs/model-providers.md) - background routing, prompt phases, skip rules, provider-specific behavior.
- [Local Bridges](docs/local-bridges.md) - Gemini CLI and Claude Code localhost bridges, runtime isolation, health, traces.
- [Storage And State](docs/storage-and-state.md) - Chrome storage keys, in-memory state, handoff records, sent registry.
- [Token Usage](docs/token-usage.md) - provider usage extraction, CSV logging, estimated usage fallback.
- [Testing And Debugging](docs/testing-and-debugging.md) - test suite, local commands, bridge logs, common failure modes.

## Current Feature Map

- Popup settings for username, active model, API keys, region, and auto-draft enablement.
- Voice onboarding that builds and persists a voice profile and system prompt.
- X home-feed candidate detection with own-post, promoted-post, stale-post, sensitive-post, and low-signal filters.
- Context extraction for post text, poster handle, created time, quoted posts, quoted/post images, and linked article previews.
- Feed-native auto draft queue with quick generation, full-quality regeneration, edit controls, skip, open post, and send.
- Offscreen ready/processing/sent decks, inline cards beside visible posts, and drawer mode on narrow layouts.
- Auto-send handoff from feed to post detail tab when a post is no longer mounted in the feed.
- Style learning from sent edited drafts into `prompt_auto`.
- Provider routing across Gemini CLI Local, Claude Code Local, Gemini HTTP, Kimi, and Claude API.
- Local bridge health endpoints, trace logs, structured errors, and token usage CSV output.

## Maintenance Rules

- If a change alters a user workflow, update the matching workflow doc.
- If a change adds or renames a Chrome storage key, update [Storage And State](docs/storage-and-state.md).
- If a change touches prompt contracts, model routing, or provider behavior, update [Model Providers](docs/model-providers.md).
- If a change touches `bridge/`, update [Local Bridges](docs/local-bridges.md) and [Token Usage](docs/token-usage.md) if logging changes.
- Run `npm test` after implementation changes. For syntax-only doc-adjacent code checks, also run `node --check <file>`.
