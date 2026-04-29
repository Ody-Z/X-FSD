# Onboarding

Onboarding lives in the popup and builds the voice profile used by every draft prompt.

## User Workflow

1. Open the extension popup.
2. If `settings.onboardingCompleted` is false, the popup switches to the Onboarding tab.
3. Choose chips for identity, interests, voice, and sample replies, or enter custom text.
4. Optionally inspect or edit the advanced system prompt.
5. Click Save Voice Profile.

## Implementation

- `popup/popup.html` defines the Settings and Onboarding tabs.
- `popup/popup.js` owns tab navigation, choice state, prompt generation, settings loading, and persistence.
- `utils/storage.js` provides popup-side defaults and merges saved settings with nested `voiceProfile.choiceSelections`.
- `lib/api.js` provides the shared `DEFAULT_VOICE_PROFILE` and injects the saved profile into model prompts through `buildVoiceGuideSection()`.

## Choice Groups

`popup/popup.js` defines four `CHOICE_GROUPS`:

- `identity`: builder, founder, engineer, creator, and related roles.
- `interests`: AI products, startups, growth, design taste, developer tools, and related topics.
- `voice`: short, casual, sharp, warm, skeptical, funny, direct, and related style rules.
- `samples`: reusable example replies.

The popup stores both selected chips and free-form "other" text in `voiceProfile.choiceSelections` so older saved profiles can be reconstructed in the UI.

## Generated Prompt Behavior

`buildVoiceSystemPrompt()` in `popup/popup.js` creates a prompt with:

- display name,
- identity bullets,
- interests and viewpoints,
- voice rules,
- reference replies,
- hard dash rules.

The advanced prompt textarea auto-syncs while it still matches the generated snapshot. If the user manually edits the textarea, `canAutoSyncPrompt` is disabled and the custom prompt is preserved on save.

`lib/api.js` always appends the dash hard rules unless a custom prompt already includes `Never use --.`. This keeps custom prompts from accidentally losing the strict punctuation rule.

## Settings Workflow

The Settings tab saves:

- `username`,
- `activeModel`,
- `autoDraftsEnabled`,
- `anthropicApiKey`,
- `moonshotApiKey`,
- `geminiApiKey`,
- `moonshotEndpoint`.

Changing the active model immediately saves the selection and updates which API key fields are visible. Local Gemini CLI ignores the Gemini API key. Local Claude Code ignores the Anthropic API key.

## Storage

Onboarding data is stored under:

- `settings.voiceProfile`,
- `settings.onboardingCompleted`.

See [Storage And State](storage-and-state.md) for the full storage schema.
