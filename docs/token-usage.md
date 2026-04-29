# Token Usage

Token usage is normalized for API providers and local CLI bridges. When exact usage is unavailable, the project writes an estimate based on roughly four characters per token.

## Normalization

`lib/token-usage.js` defines the shared token shape:

```js
{
  inputTokens,
  outputTokens,
  totalTokens,
  cacheCreationInputTokens,
  cacheReadInputTokens,
  estimated,
  source
}
```

Provider extractors:

- `extractAnthropicTokenUsage()` reads Anthropic `usage`.
- `extractOpenAiTokenUsage()` reads OpenAI-compatible `usage`, used by Kimi.
- `extractGeminiTokenUsage()` reads Gemini `usageMetadata`.
- `extractGeminiCliStatsTokenUsage()` reads nested Gemini CLI `stats.models.*.tokens`.
- `extractGenericTokenUsage()` searches nested provider payloads for token-like keys.

`createEstimatedTokenUsage()` is the fallback for providers or tests without usage metadata.

## CSV Logging

`bridge/token-usage-csv.js` appends rows to a CSV file and writes the header if the file is empty.

Default path:

```sh
/tmp/xga-token-usage.csv
```

CSV columns include:

- timestamp,
- request id,
- provider,
- model,
- mode,
- phase,
- status,
- strategy type,
- base tone,
- token counts,
- estimated/source,
- prompt/reply character counts,
- duration,
- error.

## Where Rows Are Written

- Gemini CLI bridge writes rows for successful local Gemini replies.
- Claude Code bridge writes rows for successful local Claude replies.
- Provider HTTP calls return token usage to `background.js`, but browser-side CSV writing is not implemented. Browser-side usage is still included in logs and response objects.

## Logs

Bridge trace logs include token usage payloads:

- `/tmp/xga-gemini-bridge.log`
- `/tmp/xga-claude-code-bridge.log`

The trace log is useful when a UI card only shows a high-level provider error.
