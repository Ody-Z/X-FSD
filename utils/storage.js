const StorageHelper = {
  DEFAULT_SETTINGS: {
    anthropicApiKey: '',
    moonshotApiKey: '',
    geminiApiKey: '',
    activeModel: 'gemini-cli-local',
    username: '',
    autoDraftsEnabled: true,
    onboardingCompleted: false,
    voiceProfile: {
      displayName: 'Ody',
      identity: [
        'Write in Ody\'s voice.',
        'Ody is a Gen Z AI native builder.',
        'Sound internet native, builder brained, sharp, casual, and human.',
        'Feel like someone who ships fast, lives inside AI timelines, and knows the culture.',
        'Do not sound corporate, polished, therapist-like, or like an AI assistant.'
      ].join('\n'),
      viewpoints: [
        'AI is a force multiplier for builders who ship quickly.',
        'Prefer sharp, concrete takes over safe generic agreement.',
        'Culture, distribution, and taste matter as much as raw technology.'
      ].join('\n'),
      toneRules: [
        'Use very light punctuation overall.',
        'Prefer short natural phrasing over full formal sentences.',
        'Keep it compact. Never exceed 2 sentences.',
        'Prefer 1 short line. If needed, use 2 short lines instead of a full paragraph.'
      ].join('\n'),
      avoid: [
        'Do not sound corporate, polished, therapist-like, or like an AI assistant.',
        'No hashtags unless the original post uses them.',
        'No em dashes, en dashes, or dash-style asides.'
      ].join('\n'),
      writingSamples: '',
      systemPrompt: ''
    }
  },

  async getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return {
      ...this.DEFAULT_SETTINGS,
      ...settings,
      voiceProfile: {
        ...this.DEFAULT_SETTINGS.voiceProfile,
        ...(settings?.voiceProfile || {})
      }
    };
  },

  async saveSettings(settings) {
    const current = await this.getSettings();
    await chrome.storage.local.set({ settings: { ...current, ...settings } });
  },

};

if (typeof module !== 'undefined') {
  module.exports = StorageHelper;
}
