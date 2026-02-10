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

  async getScheduledPosts() {
    const { scheduledPosts } = await chrome.storage.local.get('scheduledPosts');
    return scheduledPosts || [];
  },

  async addScheduledPost(post) {
    const posts = await this.getScheduledPosts();
    posts.push({ ...post, id: crypto.randomUUID(), status: 'pending' });
    await chrome.storage.local.set({ scheduledPosts: posts });
    return posts;
  },

  async updateScheduledPost(id, updates) {
    const posts = await this.getScheduledPosts();
    const idx = posts.findIndex(p => p.id === id);
    if (idx !== -1) {
      posts[idx] = { ...posts[idx], ...updates };
      await chrome.storage.local.set({ scheduledPosts: posts });
    }
    return posts;
  },

  async deleteScheduledPost(id) {
    let posts = await this.getScheduledPosts();
    posts = posts.filter(p => p.id !== id);
    await chrome.storage.local.set({ scheduledPosts: posts });
    return posts;
  },

  async getPendingGeneration() {
    const { pendingGeneration } = await chrome.storage.local.get('pendingGeneration');
    return pendingGeneration || null;
  },

  async setPendingGeneration(data) {
    await chrome.storage.local.set({ pendingGeneration: data });
  },

  async clearPendingGeneration() {
    await chrome.storage.local.remove('pendingGeneration');
  },

  async getScheduledPostToPublish() {
    const { postToPublish } = await chrome.storage.local.get('postToPublish');
    return postToPublish || null;
  },

  async setScheduledPostToPublish(data) {
    await chrome.storage.local.set({ postToPublish: data });
  },

  async clearScheduledPostToPublish() {
    await chrome.storage.local.remove('postToPublish');
  }
};

if (typeof module !== 'undefined') {
  module.exports = StorageHelper;
}
