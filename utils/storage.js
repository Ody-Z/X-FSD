const StorageHelper = {
  DEFAULT_SETTINGS: {
    anthropicApiKey: '',
    moonshotApiKey: '',
    activeModel: 'claude-haiku',
    username: ''
  },

  async getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return { ...this.DEFAULT_SETTINGS, ...settings };
  },

  async saveSettings(settings) {
    const current = await this.getSettings();
    await chrome.storage.local.set({ settings: { ...current, ...settings } });
  },

};

if (typeof module !== 'undefined') {
  module.exports = StorageHelper;
}
