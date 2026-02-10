(function () {
  'use strict';

  const TONES_PRIMARY = [
    { key: 'supportive', label: 'Supportive', icon: '👍' },
    { key: 'question', label: 'Question', icon: '❓' },
    { key: 'smart', label: 'Smart', icon: '🧠' },
    { key: 'enhance', label: 'Enhance', icon: '✨' }
  ];

  const TONES_MORE = [
    { key: 'funny', label: 'Funny', icon: '😂' }
  ];

  const state = {
    currentTone: null,
    aiGeneratedText: null,
    originalPostText: null,
    activeComposer: null
  };

  // --- Composer Detection ---
  function findComposers() {
    return document.querySelectorAll('[data-testid="tweetTextarea_0"]');
  }

  function getComposerRoot(textarea) {
    let el = textarea;
    for (let i = 0; i < 20; i++) {
      if (!el.parentElement) break;
      el = el.parentElement;
      if (el.querySelector('[data-testid="tweetButtonInline"]') ||
          el.querySelector('[data-testid="tweetButton"]')) {
        return el;
      }
    }
    return textarea.closest('[class]')?.parentElement?.parentElement?.parentElement?.parentElement || null;
  }

  function getTweetTextAboveComposer(composerRoot) {
    if (!composerRoot) return '';

    const tweetTextEl = composerRoot.querySelector('[data-testid="tweetText"]');
    if (tweetTextEl) return tweetTextEl.innerText.trim();

    let el = composerRoot;
    for (let i = 0; i < 10; i++) {
      el = el.parentElement;
      if (!el) break;
      const tweet = el.querySelector('[data-testid="tweetText"]');
      if (tweet) return tweet.innerText.trim();
    }

    const allTweetTexts = document.querySelectorAll('[data-testid="tweetText"]');
    if (allTweetTexts.length > 0) {
      return allTweetTexts[allTweetTexts.length - 1].innerText.trim();
    }
    return '';
  }

  function findToolbar(composerRoot) {
    if (!composerRoot) return null;
    const toolbar = composerRoot.querySelector('[role="toolbar"]');
    if (toolbar) return toolbar;
    const groups = composerRoot.querySelectorAll('[role="group"]');
    return groups.length > 0 ? groups[groups.length - 1] : null;
  }

  // --- Text Insertion ---
  function insertTextIntoComposer(textarea, text) {
    const editableDiv = textarea.closest('[contenteditable="true"]') ||
                        textarea.querySelector('[contenteditable="true"]') ||
                        textarea;

    const rootEditable = editableDiv.closest('[data-testid="tweetTextarea_0"]') || editableDiv;

    rootEditable.focus();

    const spans = rootEditable.querySelectorAll('[data-text="true"]');
    if (spans.length > 0) {
      spans.forEach(s => s.textContent = '');
      spans[0].textContent = text;
    } else {
      const placeholder = rootEditable.querySelector('[data-offset-key]');
      if (placeholder) {
        let textNode = placeholder.querySelector('[data-text="true"]');
        if (textNode) {
          textNode.textContent = text;
        } else {
          placeholder.textContent = text;
        }
      } else {
        rootEditable.textContent = text;
      }
    }

    rootEditable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    rootEditable.dispatchEvent(new Event('change', { bubbles: true }));

    setTimeout(() => {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    }, 50);
  }

  function getComposerText(textarea) {
    const root = textarea.closest('[data-testid="tweetTextarea_0"]') || textarea;
    return root.innerText?.trim() || '';
  }

  // --- UI Injection ---
  function injectToneButtons(textarea) {
    const composerRoot = getComposerRoot(textarea);
    if (!composerRoot) return;
    if (composerRoot.querySelector('.xga-tone-row')) return;

    const toolbar = findToolbar(composerRoot);
    if (!toolbar) return;

    const row = document.createElement('div');
    row.className = 'xga-tone-row';

    TONES_PRIMARY.forEach(tone => {
      row.appendChild(createToneButton(tone, textarea, composerRoot));
    });

    const moreBtn = document.createElement('button');
    moreBtn.className = 'xga-tone-btn';
    moreBtn.innerHTML = `<span>More</span> <span style="font-size:10px">▾</span>`;
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMoreMenu(moreBtn, textarea, composerRoot);
    });
    row.appendChild(moreBtn);

    toolbar.parentElement.insertBefore(row, toolbar);
    state.activeComposer = textarea;
  }

  function createToneButton(tone, textarea, composerRoot) {
    const btn = document.createElement('button');
    btn.className = 'xga-tone-btn';
    btn.dataset.tone = tone.key;
    btn.innerHTML = `<span>${tone.icon}</span><span>${tone.label}</span>`;

    btn.addEventListener('click', async () => {
      const row = btn.closest('.xga-tone-row');
      row.querySelectorAll('.xga-tone-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active', 'loading');
      btn.innerHTML = `<span class="xga-spinner"></span><span>${tone.label}</span>`;

      try {
        const tweetText = getTweetTextAboveComposer(composerRoot);
        state.originalPostText = tweetText;
        state.currentTone = tone.key;

        const response = await chrome.runtime.sendMessage({
          type: 'GENERATE_REPLY',
          tweetText,
          tone: tone.key
        });

        if (response.error) throw new Error(response.error);

        state.aiGeneratedText = response.text;
        insertTextIntoComposer(textarea, response.text);
      } catch (e) {
        console.error('XGA: Generation failed:', e);
        state.aiGeneratedText = null;
      }

      btn.classList.remove('loading');
      btn.innerHTML = `<span>${tone.icon}</span><span>${tone.label}</span>`;
    });

    return btn;
  }

  async function triggerToneGeneration(tone, textarea, composerRoot) {
    const row = composerRoot.querySelector('.xga-tone-row');
    if (row) row.querySelectorAll('.xga-tone-btn').forEach(b => b.classList.remove('active'));

    try {
      const tweetText = getTweetTextAboveComposer(composerRoot);
      state.originalPostText = tweetText;
      state.currentTone = tone.key;
      state.activeComposer = textarea;

      const response = await chrome.runtime.sendMessage({
        type: 'GENERATE_REPLY',
        tweetText,
        tone: tone.key
      });

      if (response.error) throw new Error(response.error);

      state.aiGeneratedText = response.text;
      insertTextIntoComposer(textarea, response.text);
    } catch (e) {
      console.error('XGA: Generation failed:', e);
      state.aiGeneratedText = null;
    }
  }

  function toggleMoreMenu(moreBtn, textarea, composerRoot) {
    const existing = document.querySelector('.xga-more-menu');
    if (existing) { existing.remove(); return; }

    const menu = document.createElement('div');
    menu.className = 'xga-more-menu';

    TONES_MORE.forEach(tone => {
      const item = document.createElement('button');
      item.className = 'xga-more-item';
      item.textContent = `${tone.icon} ${tone.label}`;
      item.addEventListener('click', () => {
        menu.remove();
        triggerToneGeneration(tone, textarea, composerRoot);
      });
      menu.appendChild(item);
    });

    const rect = moreBtn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    document.body.appendChild(menu);

    const closeMenu = (e) => {
      if (!menu.contains(e.target) && e.target !== moreBtn) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 10);
  }

  // --- Reply Interception for Tone Learning ---
  function interceptReplyButton() {
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]');
      if (!btn) return;
      if (!state.aiGeneratedText || !state.currentTone) return;

      const composer = state.activeComposer;
      if (!composer) return;

      const userFinalText = getComposerText(composer);
      if (!userFinalText) return;

      const comparisonEntry = {
        originalPost: state.originalPostText || '',
        aiGenerated: state.aiGeneratedText,
        userFinal: userFinalText,
        timestamp: Date.now()
      };

      chrome.runtime.sendMessage({
        type: 'SAVE_COMPARISON',
        tone: state.currentTone,
        entry: comparisonEntry
      });

      state.aiGeneratedText = null;
      state.currentTone = null;
      state.originalPostText = null;
      state.activeComposer = null;
    }, true);
  }

  // --- Scheduled Post Auto-Fill & Auto-Post ---
  async function handleScheduledPost() {
    const postData = await StorageHelper.getScheduledPostToPublish();
    if (!postData) return;

    const isComposePage = window.location.href.includes('/compose/post') ||
                          window.location.href.includes('/compose/tweet');
    if (!isComposePage) return;

    const waitForComposer = () => new Promise((resolve) => {
      const check = () => {
        const textarea = document.querySelector('[data-testid="tweetTextarea_0"]');
        if (textarea) return resolve(textarea);
        setTimeout(check, 300);
      };
      check();
    });

    const textarea = await waitForComposer();
    await new Promise(r => setTimeout(r, 500));

    insertTextIntoComposer(textarea, postData.text);
    await new Promise(r => setTimeout(r, 1000));

    const postBtn = document.querySelector('[data-testid="tweetButton"]');
    if (postBtn) {
      postBtn.click();
      await StorageHelper.clearScheduledPostToPublish();

      chrome.runtime.sendMessage({
        type: 'POST_PUBLISHED',
        postId: postData.id
      });
    }
  }

  // --- Observer ---
  function observeComposers() {
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        findComposers().forEach(textarea => injectToneButtons(textarea));
      }, 200);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    findComposers().forEach(textarea => injectToneButtons(textarea));
  }

  // --- Init ---
  function init() {
    observeComposers();
    interceptReplyButton();
    handleScheduledPost();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
