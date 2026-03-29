# X Growth Assistant

Chrome extension that generates tone-matched replies on X (Twitter) using Claude, Kimi, or Gemini. It learns from your edits over time to match your personal writing style.

## Features

- **5 reply tones**: Supportive, Question, Smart, Enhance, Funny
- **Triple model support**: Claude Haiku 3.5 (Anthropic), Kimi K2.5 (Moonshot), and Gemini 3.1 Flash-Lite Preview (Google)
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
│   └── api.js             # API layer — Claude, Kimi, and Gemini calls with web search
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

4. **Use**
   - Go to X.com and open any reply composer
   - Tone buttons appear above the toolbar — click one to generate a reply
   - Edit the reply if needed; the extension captures your edits to learn your style
