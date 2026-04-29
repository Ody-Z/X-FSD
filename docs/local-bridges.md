# Local Bridges

Local bridge scripts are optional Node servers that let the Chrome extension call local CLI logins. They expose localhost HTTP APIs because Chrome extensions cannot spawn local processes directly.

## Shared HTTP Shape

Both bridges expose:

- `GET /health`: returns install/auth status and configured model.
- `POST /trace`: accepts background/client trace entries and writes them to a log file.
- `POST /generate-reply`: accepts `systemPrompt`, `userPrompt` or `tweetText`, optional `context`, `model`, `requestId`, `timeoutMs`, `mode`, and `phase`.

Responses are JSON:

```json
{ "text": "reply text", "tokenUsage": {} }
```

Structured bridge errors include `error` and `code`.

## Gemini CLI Bridge

File: `bridge/gemini-cli-bridge.js`

Start command:

```sh
npm run bridge
```

Defaults:

- port: `43117`,
- model: `flash-lite`,
- timeout env default: `XGA_GEMINI_CLI_TIMEOUT_MS` or 60 seconds when no request timeout is provided,
- runtime timeout from extension: 90 seconds for quick, 120 seconds for full,
- concurrency: 3 isolated slots.

### Runtime Isolation

The bridge prepares one runtime per concurrency slot:

- `/tmp/xga-gemini-cli-bridge/slot-0/home`
- `/tmp/xga-gemini-cli-bridge/slot-1/home`
- `/tmp/xga-gemini-cli-bridge/slot-2/home`

Each slot has its own:

- `HOME`,
- `GEMINI_CLI_HOME`,
- workdir,
- `system.md`,
- copied `.gemini` auth files and minimal settings.

This keeps parallel CLI calls from sharing the same cache/runtime files. The source auth files are copied from the user's `~/.gemini` directory. The minimal settings disable hooks, skills, todos, and context discovery.

### Invocation

`buildGeminiExecInvocation()` runs:

```sh
gemini --model <model> --prompt <prompt> --sandbox=false --output-format json
```

The bridge:

- queues requests onto free runtime slots,
- downloads up to four prompt images into the slot workdir,
- references images as relative file paths in the prompt,
- rejects timed-out calls immediately and kills their process groups in the background,
- retries one timeout once,
- parses the first JSON object from stdout,
- maps common failures to structured bridge errors.

### Env Overrides

- `XGA_GEMINI_BRIDGE_PORT`
- `XGA_GEMINI_CLI_TIMEOUT_MS`
- `XGA_GEMINI_CLI_BIN`
- `XGA_GEMINI_CLI_MODEL`
- `XGA_GEMINI_BRIDGE_CONCURRENCY`
- `XGA_GEMINI_TRACE_LOG`
- `XGA_GEMINI_TRACE_RESET=1`
- `XGA_GEMINI_TOKEN_USAGE_CSV` or `XGA_TOKEN_USAGE_CSV`

## Claude Code Bridge

File: `bridge/claude-code-bridge.js`

Start command:

```sh
npm run bridge:claude
```

Defaults:

- port: `43118`,
- model: `claude-haiku-4-5-20251001`,
- default bridge timeout: 25 seconds when no request timeout is provided,
- runtime timeout from extension: 90 seconds for quick, 120 seconds for full,
- workdir: `/tmp/xga-claude-code-bridge/workdir`.

### Invocation

`buildClaudeExecInvocation()` runs Claude Code print mode:

```sh
claude -p <userPrompt> --model <model> --output-format json --max-turns 1
```

Important flags:

- `--no-session-persistence`
- `--setting-sources local`
- `--settings {"disableAllHooks":true}`
- `--effort low`
- `--disable-slash-commands`
- `--tools ""`
- `--system-prompt <systemPrompt>`

The bridge deletes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child environment so it uses the local Claude Code login rather than cloud API env vars.

### Env Overrides

- `XGA_CLAUDE_BRIDGE_PORT`
- `XGA_CLAUDE_CLI_TIMEOUT_MS`
- `XGA_CLAUDE_CODE_MODEL`
- `XGA_CLAUDE_BIN`
- `XGA_CLAUDE_TRACE_LOG`
- `XGA_CLAUDE_PROMPT_DUMP`
- `XGA_CLAUDE_TOKEN_USAGE_CSV` or `XGA_TOKEN_USAGE_CSV`

## Logs

Default logs:

- Gemini trace: `/tmp/xga-gemini-bridge.log`
- Claude trace: `/tmp/xga-claude-code-bridge.log`
- token CSV: `/tmp/xga-token-usage.csv`

The background service worker also forwards trace messages to the Gemini trace endpoint by default through `reportLocalBridgeTrace()`.
