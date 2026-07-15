# Model Providers

`background.js` is the provider router. `lib/api.js` owns prompt building, skip rules, provider HTTP calls, image attachment handling, and draft result parsing.

## Active Models

The popup supports:

- `gemini-cli-local`: local Gemini CLI bridge, default setting.
- `claude-code-haiku-local`: local Claude Code bridge.
- `gemini-3.1-flash-lite-preview`: Gemini HTTP API.
- `kimi-k2.5`: Moonshot Kimi OpenAI-compatible endpoint.
- `claude-haiku`: Anthropic Claude Haiku HTTP API.

`resolveDraftModel()` also allows explicit request providers:

- `provider: 'gemini-local'` forces Gemini CLI local.
- `provider: 'claude-local'` forces Claude Code local.

## Prompt Phases

Auto generation has two phases:

- `quick`: used for first drafts. It optimizes speed, keeps replies under 220 characters, prefers one short line, and does not include style-learning examples.
- `full`: used by Regenerate. It allows up to 280 characters and includes recent style-learning examples from `prompt_auto`.

Timeouts from `background.js`:

- quick: 90 seconds,
- full: 120 seconds.

## Strategy Contract

Auto prompts require the model to return one JSON object:

```json
{
  "status": "ready|skipped",
  "strategyType": "case_data|first_hand|boundary_condition|null",
  "baseTone": "supportive|smart|null",
  "reply": "string",
  "reason": "string"
}
```

`parseAdaptiveDraftResult()` extracts the first JSON object, validates status, strategy, base tone, and non-empty reply, then normalizes it for `content.js`.

Strategies are defined in `AUTO_STRATEGY_CONFIG`:

- `case_data` -> `smart`: add a specific case, counterexample, or number supported by supplied context or verified by an available search tool in the current run,
- `first_hand` -> `supportive`: add a real experience found in the saved voice material or prompt context,
- `boundary_condition` -> `smart`: identify the precise condition or missing variable that limits the original claim.

Voice remains the top-level constraint for wording and style. The prompt rejects generic praise, paraphrase, empty questions, and unsupported facts or first-person stories. If none of the three value moves can be supported, the model must skip the post.

## Skip Rules

`detectAutoDraftSkipReason()` blocks before a provider call when:

- the post is older than two hours,
- there is no usable text or media context,
- text is too short and has no media context,
- the post is only a repost shell,
- the post is mostly links without article/quote/media context,
- the post is a short one-line link teaser or CTA with only a linked article preview,
- the post is an X subscribe-card prompt such as `Click to Subscribe to ...`,
- the content matches sensitive-event terms such as condolences, shootings, massacres, or memorials.

`content.js` separately filters own posts, stale posts, promoted posts, unsupported pages, and posts without reply buttons.

## Context Included In Prompts

`buildUserMessage()` can include:

- up to three earlier thread tweets,
- quoted post text, poster, and URL,
- post and quoted image references,
- linked article card title, excerpt, and URL,
- reply target poster handle and truncated post text.

Image attachment support:

- Gemini HTTP and Claude API fetch images, convert them to base64, and attach up to four supported images.
- Gemini CLI bridge downloads image files into the slot workdir and references them in the CLI prompt.
- Kimi currently receives text context only.

Linked article previews are treated as X-card previews. The prompt explicitly says not to claim the full article was read unless full text is provided.

## Provider Behavior

### Gemini HTTP

`callGeminiResult()` calls `v1beta/models/gemini-3.1-flash-lite-preview:generateContent`, includes `system_instruction`, user parts, inline images, `google_search`, and `maxOutputTokens: 300`.

### Kimi

`callKimiResult()` calls the configured Moonshot endpoint, defaults to `https://api.moonshot.cn/v1`, uses model `kimi-k2.5`, disables thinking, and uses OpenAI-compatible chat completions.

### Claude API

`callClaudeResult()` calls Anthropic Messages API with model `claude-3-5-haiku-20241022`, `max_tokens: 300`, system prompt, user content, and optional image blocks.

### Local Bridges

Local providers are called through `lib/local-cli.js`:

- Gemini CLI: `http://127.0.0.1:43117/generate-reply`
- Claude Code: `http://127.0.0.1:43118/generate-reply`

Bridge responses include text and token usage when available. Network failures are rewritten to "start the bridge" guidance, and transient Gemini CLI stream/rate-limit failures are returned as structured `gemini_transient` errors.

## Style Learning

After send, `content.js` sends `SAVE_COMPARISON` with:

- original post,
- AI-generated draft,
- user final reply,
- strategy type,
- base tone,
- timestamp.

`background.js` appends the entry to `prompt_auto.comparisons`, keeping the last 25. Full regeneration reads those comparisons for voice adaptation.
