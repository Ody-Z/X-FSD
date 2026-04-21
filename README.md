# X Growth Assistant

Chrome extension that generates tone-matched replies on X (Twitter) using Claude, Kimi, Gemini API, a local Gemini CLI bridge, or a local Claude Code Haiku bridge. It learns from your edits over time to match your personal writing style.

## Features

- **5 reply tones**: Supportive, Question, Smart, Enhance, Funny
- **Five model paths**: Claude Haiku 3.5 (Anthropic), Claude Code Haiku Local (macOS bridge), Kimi K2.5 (Moonshot), Gemini 3.1 Flash-Lite Preview (Google API), and Gemini CLI Local (macOS bridge)
- **Web search**: All models can search for current context before replying
- **Style learning**: Tracks how you edit AI-generated replies and adapts over time (up to 15 comparisons per tone)
- **Tone file sync**: Tone prompts and comparison data persist to local JSON files via the File System Access API

## File Structure

```
X-FSD/
├── manifest.json          # Chrome extension manifest (MV3)
├── background.js          # Service worker — routes messages, manages tone data
├── content.js             # Content script — detects composers, injects tone buttons, inserts replies
├── content.css            # Styles for injected tone buttons
├── lib/
│   └── api.js             # Shared prompt builders + Claude/Kimi/Gemini API calls
├── bridge/
│   ├── gemini-cli-bridge.js # Localhost bridge that shells out to Gemini CLI
│   └── claude-code-bridge.js # Localhost bridge that shells out to Claude Code
├── popup/
│   ├── popup.html         # Extension popup UI
│   ├── popup.js           # Popup logic — settings, tone file management, sync
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
   - Enter your API key(s), choose a model, and set your X username
   - Pick a local folder for tone file storage (optional but recommended)
   - Click **Save Settings**

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
- Optional overrides:
  - `XGA_GEMINI_BRIDGE_PORT`
  - `XGA_GEMINI_CLI_TIMEOUT_MS`
  - `XGA_GEMINI_CLI_BIN`

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
- Optional overrides:
  - `XGA_CLAUDE_BRIDGE_PORT`
  - `XGA_CLAUDE_CLI_TIMEOUT_MS`
  - `XGA_CLAUDE_CODE_MODEL`
  - `XGA_CLAUDE_BIN`

4. **Use**
   - Go to X.com and open any reply composer
   - Tone buttons appear above the toolbar — click one to generate a reply
   - Edit the reply if needed; the extension captures your edits to learn your style
