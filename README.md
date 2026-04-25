# X Growth Assistant

Chrome extension that generates voice-matched replies on X (Twitter) using Claude, Kimi, Gemini API, a local Gemini CLI bridge, or a local Claude Code Haiku bridge. It learns from your edits over time to match your personal writing style.

## Features

- **Auto reply strategy**: The model decides whether to skip a post, then picks the best reply strategy automatically
- **Voice onboarding**: Pick identity, interest, voice, and sample-reply chips; the extension builds the system prompt
- **Five model paths**: Claude Haiku 3.5 (Anthropic), Claude Code Haiku Local (macOS bridge), Kimi K2.5 (Moonshot), Gemini 3.1 Flash-Lite Preview (Google API), and Gemini CLI Local (macOS bridge)
- **Web search**: All models can search for current context before replying
- **Style learning**: Tracks how you edit AI-generated replies and adapts the auto prompt over time

## File Structure

```
X-FSD/
├── manifest.json          # Chrome extension manifest (MV3)
├── background.js          # Service worker — routes messages, manages prompt data
├── content.js             # Content script — detects feed posts, renders auto draft cards, sends replies
├── content.css            # Styles for injected auto draft UI
├── lib/
│   └── api.js             # Shared prompt builders + Claude/Kimi/Gemini API calls
├── bridge/
│   ├── gemini-cli-bridge.js # Localhost bridge that shells out to Gemini CLI
│   └── claude-code-bridge.js # Localhost bridge that shells out to Claude Code
├── popup/
│   ├── popup.html         # Extension popup UI
│   ├── popup.js           # Popup logic — settings and voice onboarding
│   └── popup.css          # Popup styles
├── utils/
│   └── storage.js         # Chrome storage helper (getSettings / saveSettings)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Setup

1. **Get API keys**
   - Anthropic: https://console.anthropic.com
   - Moonshot: https://platform.moonshot.ai
   - Gemini: https://aistudio.google.com/apikey

2. **Load the extension**
   - Open `chrome://extensions`
   - Enable **Developer mode**
   - Click **Load unpacked** and select the `X-FSD/` folder

3. **Configure**
   - Click the extension icon to open the popup
   - Complete **Onboarding** by choosing the chips and sample replies that fit your voice
   - Enter your API key(s), choose a model, and set your X username
   - Click **Save Settings**

## How Auto Works

Auto is the only user-facing reply mode. For each candidate post, the content script queues a draft request. The background service worker:

1. Skips posts with no usable text, low-signal repost shells, link-only posts, own posts, or sensitive topics.
2. Builds a system prompt from your saved voice profile and always injects the dash hard rule.
3. Sends the post context to the selected model and asks it to return one JSON object.
4. The JSON must include `status`, `strategyType`, `baseTone`, `reply`, and `reason`.
5. If the draft is ready, the UI shows it for edit/send. If you edit and send it, the final text is saved as an example for future full-quality regenerations.

The internal strategies are `humor`, `deep_share`, `hot_take`, `news`, and `personal`. Users do not manually switch them; the model chooses one based on the post.

## Local Gemini CLI Mode (macOS)

Use this mode if you want X Growth Assistant to call your locally installed Gemini CLI instead of the Gemini HTTP API.

1. Make sure `gemini` is installed and authenticated locally.
2. Start the bridge:
   - `npm run bridge`
3. Reload the extension in `chrome://extensions`.
4. In the popup, set **Active Model** to **Gemini CLI Local (macOS)**.
5. Click **Save Settings**.

Notes:
- The bridge listens on `http://127.0.0.1:43117` by default.
- `Gemini API Key` is ignored in local CLI mode.
- If reply generation says the bridge is unavailable, start it with `npm run bridge`.
- Token usage is logged in the bridge trace and appended to `/tmp/xga-token-usage.csv` by default.
- Optional overrides:
  - `XGA_GEMINI_BRIDGE_PORT`
  - `XGA_GEMINI_CLI_TIMEOUT_MS`
  - `XGA_GEMINI_CLI_BIN`
  - `XGA_GEMINI_BRIDGE_CONCURRENCY`
  - `XGA_TOKEN_USAGE_CSV` or `XGA_GEMINI_TOKEN_USAGE_CSV`

## Local Claude Code Haiku Mode (macOS)

Use this mode if you want X Growth Assistant to call your locally installed Claude Code login instead of the Anthropic HTTP API.

Notes:
- Anthropic's Agent SDK docs are API-key and cloud-auth oriented. This repo uses the supported `claude -p` CLI print mode locally instead of trying to reuse Agent SDK auth inside the extension.
- The bridge targets `claude-haiku-4-5-20251001` by default.

1. Make sure `claude` is installed and authenticated locally.
2. Start the bridge:
   - `npm run bridge:claude`
3. Reload the extension in `chrome://extensions`.
4. In the popup, set **Active Model** to **Claude Code Haiku Local (macOS)**.
5. Click **Save Settings**.

Notes:
- The bridge listens on `http://127.0.0.1:43118` by default.
- `Anthropic API Key` is ignored in local Claude Code mode.
- If reply generation says the bridge is unavailable, start it with `npm run bridge:claude`.
- Token usage is logged in the bridge trace and appended to `/tmp/xga-token-usage.csv` by default.
- Optional overrides:
  - `XGA_CLAUDE_BRIDGE_PORT`
  - `XGA_CLAUDE_CLI_TIMEOUT_MS`
  - `XGA_CLAUDE_CODE_MODEL`
  - `XGA_CLAUDE_BIN`
  - `XGA_TOKEN_USAGE_CSV` or `XGA_CLAUDE_TOKEN_USAGE_CSV`

4. **Use**
   - Go to the X.com home feed
   - Auto draft cards appear beside eligible posts
   - Edit the reply if needed; the extension captures your edits to learn your style
