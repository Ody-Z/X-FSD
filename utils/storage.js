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
      displayName: '',
      identity: '',
      viewpoints: '',
      toneRules: '',
      avoid: [
        'Never use --.',
        'Never use em dashes or en dashes.',
        'Do not use dash-style asides.'
      ].join('\n'),
      writingSamples: '',
      systemPrompt: '',
      choiceSelections: {
        identity: [],
        interests: [],
        voice: [],
        samples: [],
        identityOther: '',
        interestsOther: '',
        voiceOther: '',
        samplesOther: ''
      }
    }
  },

  async getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return {
      ...this.DEFAULT_SETTINGS,
      ...settings,
      voiceProfile: {
        ...this.DEFAULT_SETTINGS.voiceProfile,
        ...(settings?.voiceProfile || {}),
        choiceSelections: {
          ...this.DEFAULT_SETTINGS.voiceProfile.choiceSelections,
          ...(settings?.voiceProfile?.choiceSelections || {})
        }
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
