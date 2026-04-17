(function () {
  'use strict';

  const TONES = [
    { key: 'supportive', label: 'Supportive', icon: '👍' },
    { key: 'question', label: 'Question', icon: '❓' },
    { key: 'smart', label: 'Smart', icon: '🧠' },
    { key: 'enhance', label: 'Enhance', icon: '✨' },
    { key: 'funny', label: 'Funny', icon: '😂' }
  ];

  const state = {
    currentTone: null,
    aiGeneratedText: null,
    originalPostText: null,
    activeComposer: null
  };

  const LOG_PREFIX = '[XGA]';

  // --- Composer Detection (multiple strategies) ---
  function findComposers() {
    const selectors = [
      '[data-testid="tweetTextarea_0"]',
      '[data-testid="tweetTextarea_0_label"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[data-contents="true"]',
      '.DraftEditor-root',
      '.public-DraftEditor-content'
    ];

    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        console.log(LOG_PREFIX, `Found composers via: ${sel}`, els.length);
        return els;
      }
    }

    const textboxes = document.querySelectorAll('[role="textbox"]');
    if (textboxes.length > 0) {
      console.log(LOG_PREFIX, 'Found composers via role=textbox', textboxes.length);
      return textboxes;
    }

    return [];
  }

  function getComposerRoot(textarea) {
    const buttonSelectors = [
      '[data-testid="tweetButtonInline"]',
      '[data-testid="tweetButton"]',
      'button[data-testid*="tweet"]',
      'button[data-testid*="Reply"]',
      'button[data-testid*="reply"]'
    ];

    let el = textarea;
    for (let i = 0; i < 25; i++) {
      if (!el.parentElement) break;
      el = el.parentElement;
      for (const sel of buttonSelectors) {
        if (el.querySelector(sel)) {
          console.log(LOG_PREFIX, 'Found composer root via button:', sel, 'at depth', i);
          return el;
        }
      }
    }

    // Fallback: look for the nearest dialog/modal/layer
    const dialog = textarea.closest('[role="dialog"]') ||
                   textarea.closest('[aria-modal="true"]') ||
                   textarea.closest('[data-testid="mask"]')?.parentElement;
    if (dialog) {
      console.log(LOG_PREFIX, 'Found composer root via dialog/modal');
      return dialog;
    }

    // Fallback: walk up to a reasonable container
    el = textarea;
    for (let i = 0; i < 15; i++) {
      if (!el.parentElement) break;
      el = el.parentElement;
      const groups = el.querySelectorAll('[role="group"]');
      if (groups.length > 0) {
        console.log(LOG_PREFIX, 'Found composer root via role=group at depth', i);
        return el;
      }
    }

    console.log(LOG_PREFIX, 'Using fallback composer root');
    return textarea.parentElement?.parentElement?.parentElement?.parentElement?.parentElement || null;
  }

  function getTweetTextAboveComposer(composerRoot) {
    if (!composerRoot) return '';

    const selectors = [
      '[data-testid="tweetText"]',
      'article [lang]',
      'article div[dir="auto"]'
    ];

    for (const sel of selectors) {
      const el = composerRoot.querySelector(sel);
      if (el && el.innerText.trim()) return el.innerText.trim();
    }

    // Walk up to find tweet text
    let el = composerRoot;
    for (let i = 0; i < 15; i++) {
      el = el.parentElement;
      if (!el) break;
      for (const sel of selectors) {
        const tweet = el.querySelector(sel);
        if (tweet && tweet.innerText.trim()) return tweet.innerText.trim();
      }
    }

    // Last resort: find any tweet text on the page
    const allTweetTexts = document.querySelectorAll('[data-testid="tweetText"]');
    if (allTweetTexts.length > 0) {
      return allTweetTexts[0].innerText.trim();
    }
    return '';
  }

  function findToolbarOrInsertionPoint(composerRoot) {
    if (!composerRoot) return null;

    const selectors = [
      '[role="toolbar"]',
      '[data-testid="toolBar"]',
      '[data-testid="Toolbar"]'
    ];

    for (const sel of selectors) {
      const el = composerRoot.querySelector(sel);
      if (el) {
        console.log(LOG_PREFIX, 'Found toolbar via:', sel);
        return el;
      }
    }

    // Look for role="group" which X uses for the button toolbar
    const groups = composerRoot.querySelectorAll('[role="group"]');
    if (groups.length > 0) {
      console.log(LOG_PREFIX, 'Found toolbar via role=group, count:', groups.length);
      return groups[groups.length - 1];
    }

    // Look for the row containing media buttons (img, gif, poll icons)
    const svgButtons = composerRoot.querySelectorAll('button svg');
    if (svgButtons.length >= 3) {
      const toolbarRow = svgButtons[0].closest('div[class]');
      if (toolbarRow) {
        const parent = toolbarRow.parentElement;
        if (parent && parent.children.length >= 3) {
          console.log(LOG_PREFIX, 'Found toolbar via svg button heuristic');
          return parent;
        }
      }
    }

    console.log(LOG_PREFIX, 'No toolbar found in composer root');
    return null;
  }

  function getThreadContext(composerRoot) {
    const context = { threadTweets: [], posterHandle: '' };
    if (!composerRoot) return context;

    let container = composerRoot;
    for (let i = 0; i < 20; i++) {
      if (!container.parentElement) break;
      container = container.parentElement;
      if (container.querySelectorAll('article').length > 0) break;
    }

    const articles = container.querySelectorAll('article');
    for (const article of articles) {
      if (composerRoot.contains(article)) continue;
      const textEl = article.querySelector('[data-testid="tweetText"]');
      if (textEl?.innerText?.trim()) context.threadTweets.push(textEl.innerText.trim());
    }

    const lastArticle = articles.length > 0 ? articles[articles.length - 1] : null;
    if (lastArticle && !composerRoot.contains(lastArticle)) {
      const userNameEl = lastArticle.querySelector('[data-testid="User-Name"]');
      if (userNameEl) {
        const handleLink = userNameEl.querySelector('a[href^="/"]');
        if (handleLink) {
          const href = handleLink.getAttribute('href');
          context.posterHandle = '@' + href.replace(/^\//, '').split('/')[0];
        }
      }
    }

    return context;
  }

  // --- Text Insertion ---
  function insertTextIntoComposer(textarea, text) {
    const editable = textarea.closest('[contenteditable="true"]') ||
                     textarea.querySelector('[contenteditable="true"]') ||
                     (textarea.getAttribute('contenteditable') === 'true' ? textarea : null) ||
                     textarea;

    console.log(LOG_PREFIX, 'Inserting text into:', editable.tagName, editable.className?.substring(0, 50));
    editable.focus();

    // Strategy 1: use execCommand (most compatible with React)
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editable);
    selection.removeAllRanges();
    selection.addRange(range);

    document.execCommand('insertText', false, text);

    // Verify it worked
    setTimeout(() => {
      const current = editable.innerText?.trim();
      if (current !== text.trim()) {
        console.log(LOG_PREFIX, 'execCommand did not work, trying fallback');
        // Strategy 2: direct DOM manipulation + events
        const spans = editable.querySelectorAll('[data-text="true"]');
        if (spans.length > 0) {
          spans.forEach(s => s.textContent = '');
          spans[0].textContent = text;
        } else {
          editable.textContent = text;
        }
        editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        editable.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, 100);
  }

  function getComposerText(textarea) {
    const editable = textarea.closest('[contenteditable="true"]') ||
                     textarea.querySelector('[contenteditable="true"]') ||
                     (textarea.getAttribute('contenteditable') === 'true' ? textarea : null) ||
                     textarea;
    return editable.innerText?.trim() || '';
  }

  // --- UI Injection ---
  function injectToneButtons(textarea) {
    // Skip if already injected nearby
    const nearbyRow = textarea.closest('[role="dialog"]')?.querySelector('.xga-tone-row') ||
                      textarea.parentElement?.parentElement?.parentElement?.querySelector('.xga-tone-row');
    if (nearbyRow) return;

    const composerRoot = getComposerRoot(textarea);
    if (!composerRoot) {
      console.log(LOG_PREFIX, 'No composer root found, skipping');
      return;
    }
    if (composerRoot.querySelector('.xga-tone-row')) return;

    const toolbar = findToolbarOrInsertionPoint(composerRoot);

    const row = document.createElement('div');
    row.className = 'xga-tone-row';

    TONES.forEach(tone => {
      row.appendChild(createToneButton(tone, textarea, composerRoot));
    });

    if (toolbar && toolbar.parentElement) {
      toolbar.parentElement.insertBefore(row, toolbar);
      console.log(LOG_PREFIX, 'Injected tone row before toolbar');
    } else {
      // Fallback: append after the textbox area
      let insertTarget = textarea;
      for (let i = 0; i < 5; i++) {
        if (insertTarget.parentElement && insertTarget.parentElement !== composerRoot) {
          insertTarget = insertTarget.parentElement;
        }
      }
      insertTarget.parentElement?.appendChild(row);
      console.log(LOG_PREFIX, 'Injected tone row via fallback append');
    }

    state.activeComposer = textarea;
  }

  function createToneButton(tone, textarea, composerRoot) {
    const btn = document.createElement('button');
    btn.className = 'xga-tone-btn';
    btn.dataset.tone = tone.key;
    btn.innerHTML = `<span>${tone.icon}</span><span>${tone.label}</span>`;

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const row = btn.closest('.xga-tone-row');
      row.querySelectorAll('.xga-tone-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active', 'loading');
      btn.innerHTML = `<span class="xga-spinner"></span><span>${tone.label}</span>`;

      try {
        const tweetText = getTweetTextAboveComposer(composerRoot);
        const context = getThreadContext(composerRoot);
        console.log(LOG_PREFIX, 'Generating reply for tone:', tone.key, 'tweet:', tweetText.substring(0, 50), 'thread:', context.threadTweets.length);
        state.originalPostText = tweetText;
        state.currentTone = tone.key;

        const response = await chrome.runtime.sendMessage({
          type: 'GENERATE_REPLY',
          tweetText,
          tone: tone.key,
          context
        });

        if (response.error) throw new Error(response.error);

        console.log(LOG_PREFIX, 'Generated reply:', response.text.substring(0, 50));
        state.aiGeneratedText = response.text;
        insertTextIntoComposer(textarea, response.text);
      } catch (e) {
        console.error(LOG_PREFIX, 'Generation failed:', e.message);
        state.aiGeneratedText = null;
      }

      btn.classList.remove('loading');
      btn.innerHTML = `<span>${tone.icon}</span><span>${tone.label}</span>`;
    });

    return btn;
  }


  // --- Reply Interception for Tone Learning ---
  function interceptReplyButton() {
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-testid="tweetButtonInline"], [data-testid="tweetButton"], button[data-testid*="tweet"], button[data-testid*="reply"]');
      if (!btn) return;
      if (!state.aiGeneratedText || !state.currentTone) return;

      const composer = state.activeComposer;
      if (!composer) return;

      const userFinalText = getComposerText(composer);
      if (!userFinalText) return;

      console.log(LOG_PREFIX, 'Capturing comparison for tone:', state.currentTone);

      chrome.runtime.sendMessage({
        type: 'SAVE_COMPARISON',
        tone: state.currentTone,
        entry: {
          originalPost: state.originalPostText || '',
          aiGenerated: state.aiGeneratedText,
          userFinal: userFinalText,
          timestamp: Date.now()
        }
      });

      state.aiGeneratedText = null;
      state.currentTone = null;
      state.originalPostText = null;
      state.activeComposer = null;
    }, true);
  }

  // --- Observer ---
  function observeComposers() {
    let debounceTimer = null;
    const scan = () => {
      const composers = findComposers();
      composers.forEach(textarea => injectToneButtons(textarea));
    };

    const observer = new MutationObserver(() => {
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        scan();
      }, 300);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Initial scan + delayed retry (X loads content progressively)
    scan();
    setTimeout(scan, 1000);
    setTimeout(scan, 3000);
    console.log(LOG_PREFIX, 'Observer started');
  }

  // --- Init ---
  function init() {
    console.log(LOG_PREFIX, 'Content script initialized on', window.location.href);
    observeComposers();
    interceptReplyButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
