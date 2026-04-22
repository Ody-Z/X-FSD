(function () {
  'use strict';

  const TONES = [
    { key: 'supportive', label: 'Supportive' },
    { key: 'question', label: 'Question' },
    { key: 'smart', label: 'Smart' },
    { key: 'funny', label: 'Funny' },
    { key: 'enhance', label: 'Enhance' }
  ];
  const STRATEGY_LABELS = {
    humor: 'Humor',
    deep_share: 'Deep Share',
    hot_take: 'Hot Take',
    news: 'News',
    personal: 'Personal'
  };
  const AUTO_DRAFT_CONCURRENCY = 3;
  const INLINE_MAIN_CARD_COUNT = 2;
  const CARD_WIDTH = 320;
  const INLINE_CARD_GAP = 12;
  const LOOKAHEAD_COUNT = 6;
  const MAX_TRACKED_POSTS = 48;
  const LOG_PREFIX = '[XGA]';

  const state = {
    drafts: new Map(),
    visibleIds: [],
    priorityIds: [],
    overlayRoot: null,
    drawerRoot: null,
    activeGenerationCount: 0,
    inFlightPostIds: new Set(),
    focusedPostId: '',
    refreshScheduled: false,
    interactionLockedUntil: 0
  };

  function createRequestId() {
    return `xga-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function formatGenerationError(error) {
    const message = error?.message || String(error || 'Unknown error');
    if (/Extension context invalidated/i.test(message)) {
      return 'Extension was reloaded. Refresh this X tab, then try again.';
    }
    return message;
  }

  function normalizeWhitespace(text) {
    return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  }

  function isVisibleRect(rect) {
    return rect.bottom > 24 && rect.top < window.innerHeight - 24;
  }

  function findTweetId(article) {
    const timeLink = article.querySelector('a[href*="/status/"] time')?.closest('a[href*="/status/"]');
    const fallback = timeLink || article.querySelector('a[href*="/status/"]');
    const href = fallback?.getAttribute('href') || '';
    const match = href.match(/\/status\/(\d+)/);
    return match ? match[1] : '';
  }

  function findUserNameHandle(userName) {
    const links = Array.from(userName.querySelectorAll('a[href^="/"]'));
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (!href || href.includes('/status/')) continue;
      const handle = href.replace(/^\//, '').split('/')[0];
      if (handle) return `@${handle}`;
    }
    return '';
  }

  function findTweetTextEntries(article) {
    const entries = [];
    const seenTexts = new Set();
    const nodes = Array.from(article.querySelectorAll('[data-testid="tweetText"]'));

    if (nodes.length === 0) {
      const fallback = article.querySelector('[lang]') || article.querySelector('div[dir="auto"]');
      const text = normalizeWhitespace(fallback?.innerText || '');
      if (text) entries.push({ text, element: fallback });
      return entries;
    }

    for (const node of nodes) {
      const text = normalizeWhitespace(node.innerText || '');
      if (!text || seenTexts.has(text)) continue;
      seenTexts.add(text);
      entries.push({ text, element: node });
    }

    return entries;
  }

  function findPosterHandles(article) {
    return Array.from(article.querySelectorAll('[data-testid="User-Name"]'))
      .map((userName) => findUserNameHandle(userName))
      .filter(Boolean);
  }

  function findTweetText(article) {
    return findTweetTextEntries(article)[0]?.text || '';
  }

  function findPosterHandle(article) {
    return findPosterHandles(article)[0] || '';
  }

  function findQuotedTweet(article) {
    const textEntries = findTweetTextEntries(article);
    if (textEntries.length < 2) return null;

    const handles = findPosterHandles(article);
    for (let index = 1; index < textEntries.length; index += 1) {
      const text = textEntries[index]?.text;
      if (!text) continue;
      return {
        text,
        posterHandle: handles[index] || ''
      };
    }

    return null;
  }

  function findReplyButton(article) {
    return article.querySelector('button[data-testid="reply"]') ||
      article.querySelector('[data-testid="reply"]');
  }

  function getPageContext() {
    const pathname = window.location.pathname || '';
    const statusMatch = pathname.match(/\/status\/(\d+)/);
    if (statusMatch) {
      return {
        kind: 'status-detail',
        postId: statusMatch[1]
      };
    }

    if (/^\/home\/?$/.test(pathname)) {
      return {
        kind: 'home-feed',
        postId: ''
      };
    }

    return {
      kind: 'unsupported',
      postId: ''
    };
  }

  function isAutoDraftView(pageContext = getPageContext()) {
    return pageContext.kind === 'home-feed';
  }

  function getCandidatePreferenceScore(item) {
    let score = 0;
    if (item.article.closest('[role="dialog"]')) score += 4;
    if (findReplyButton(item.article)) score += 2;
    if (isVisibleRect(item.rect)) score += 1;
    return score;
  }

  function dedupeCandidateArticles(items) {
    const deduped = new Map();

    for (const item of items) {
      const existing = deduped.get(item.postId);
      if (!existing) {
        deduped.set(item.postId, item);
        continue;
      }

      const existingScore = getCandidatePreferenceScore(existing);
      const nextScore = getCandidatePreferenceScore(item);
      if (nextScore > existingScore || (nextScore === existingScore && item.rect.top < existing.rect.top)) {
        deduped.set(item.postId, item);
      }
    }

    return Array.from(deduped.values()).sort((a, b) => a.rect.top - b.rect.top);
  }

  function collectCandidateArticles() {
    const pageContext = getPageContext();
    const items = Array.from(document.querySelectorAll('article'))
      .map((article) => {
        const postId = findTweetId(article);
        const text = findTweetText(article);
        const quotedTweet = findQuotedTweet(article);
        if (!postId || (!text && !quotedTweet?.text)) return null;

        const rect = article.getBoundingClientRect();
        const posterHandle = findPosterHandle(article);
        return {
          postId,
          article,
          text,
          rect,
          posterHandle,
          context: {
            posterHandle,
            quotedTweet,
            threadTweets: [text]
          }
        };
      })
      .filter(Boolean);

    if (pageContext.kind === 'status-detail') {
      return dedupeCandidateArticles(items.filter((item) => item.postId === pageContext.postId));
    }

    if (pageContext.kind === 'home-feed') {
      return dedupeCandidateArticles(items);
    }

    return [];
  }

  function ensureUiRoots() {
    if (!state.overlayRoot) {
      const overlay = document.createElement('div');
      overlay.className = 'xga-overlay-root';
      overlay.addEventListener('pointerdown', () => {
        state.interactionLockedUntil = Date.now() + 1500;
      }, true);
      overlay.addEventListener('focusin', () => {
        state.interactionLockedUntil = Date.now() + 5000;
      }, true);
      overlay.addEventListener('input', () => {
        state.interactionLockedUntil = Date.now() + 5000;
      }, true);
      document.body.appendChild(overlay);
      state.overlayRoot = overlay;
    }

    if (!state.drawerRoot) {
      const drawer = document.createElement('div');
      drawer.className = 'xga-drawer-root';
      drawer.addEventListener('pointerdown', () => {
        state.interactionLockedUntil = Date.now() + 1500;
      }, true);
      drawer.addEventListener('focusin', () => {
        state.interactionLockedUntil = Date.now() + 5000;
      }, true);
      drawer.addEventListener('input', () => {
        state.interactionLockedUntil = Date.now() + 5000;
      }, true);
      document.body.appendChild(drawer);
      state.drawerRoot = drawer;
    }
  }

  function isExtensionUiNode(node) {
    if (!(node instanceof Node)) return false;
    return Boolean(
      (state.overlayRoot && (node === state.overlayRoot || state.overlayRoot.contains(node))) ||
      (state.drawerRoot && (node === state.drawerRoot || state.drawerRoot.contains(node)))
    );
  }

  function shouldIgnoreMutations(mutations) {
    return mutations.every((mutation) => isExtensionUiNode(mutation.target));
  }

  function isUserInteractingWithCard() {
    const active = document.activeElement;
    return Date.now() < state.interactionLockedUntil || Boolean(active && active.closest('.xga-card, .xga-stack-card'));
  }

  function createDraftRecord(item) {
    return {
      postId: item.postId,
      article: item.article,
      text: item.text,
      posterHandle: item.posterHandle,
      context: item.context,
      status: 'idle',
      strategyType: null,
      baseTone: null,
      selectedMode: 'auto',
      autoText: '',
      editedText: '',
      error: '',
      lastSeenAt: Date.now()
    };
  }

  function isLockedDraftStatus(status) {
    return ['sending', 'sent'].includes(status);
  }

  function updateDraftRecord(record, item) {
    record.article = item.article;
    record.posterHandle = item.posterHandle;
    record.context = item.context;
    record.lastSeenAt = Date.now();
    record.text = item.text;
  }

  function pruneDrafts() {
    if (state.drafts.size <= MAX_TRACKED_POSTS) return;

    const removable = Array.from(state.drafts.values())
      .filter((record) => !state.visibleIds.includes(record.postId) && !state.priorityIds.includes(record.postId) && !['sending'].includes(record.status))
      .sort((a, b) => a.lastSeenAt - b.lastSeenAt);

    while (state.drafts.size > MAX_TRACKED_POSTS && removable.length > 0) {
      const next = removable.shift();
      state.drafts.delete(next.postId);
    }
  }

  function syncDraftsWithFeed(items) {
    for (const item of items) {
      const record = state.drafts.get(item.postId);
      if (record) {
        updateDraftRecord(record, item);
      } else {
        state.drafts.set(item.postId, createDraftRecord(item));
      }
    }
    pruneDrafts();
  }

  function computePriority(items) {
    const canAutoQueue = isAutoDraftView();
    const viewportMid = window.innerHeight / 2;
    const visible = items.filter((item) => isVisibleRect(item.rect));
    const lookahead = items
      .filter((item) => item.rect.top >= window.innerHeight - 24)
      .slice(0, LOOKAHEAD_COUNT);

    const visibleSorted = [...visible].sort((a, b) => a.rect.top - b.rect.top);
    const centered = [...visible].sort((a, b) => {
      const aDistance = Math.abs((a.rect.top + a.rect.bottom) / 2 - viewportMid);
      const bDistance = Math.abs((b.rect.top + b.rect.bottom) / 2 - viewportMid);
      return aDistance - bDistance;
    })[0];

    const priority = [];
    if (centered) priority.push(centered.postId);
    for (const item of visibleSorted) {
      if (!priority.includes(item.postId)) priority.push(item.postId);
    }
    for (const item of lookahead) {
      if (!priority.includes(item.postId)) priority.push(item.postId);
    }

    state.visibleIds = visibleSorted.map((item) => item.postId);
    state.priorityIds = priority;

    for (const postId of priority) {
      const record = state.drafts.get(postId);
      if (!record) continue;
      if (canAutoQueue) {
        if (record.status === 'idle') record.status = 'queued';
      } else if (record.status === 'queued') {
        record.status = 'idle';
      }
    }
  }

  function shouldUseDrawer(items) {
    const anchor = items.find((item) => state.visibleIds.includes(item.postId));
    if (!anchor) return window.innerWidth < 1400;
    return window.innerWidth - anchor.rect.right < CARD_WIDTH + 24;
  }

  function getStrategyLabel(record) {
    return STRATEGY_LABELS[record.strategyType] || 'Auto Draft';
  }

  function getStatusLabel(record) {
    switch (record.status) {
      case 'queued':
        return 'Queued';
      case 'generating':
        return 'Generating';
      case 'ready':
        return 'Ready';
      case 'skipped':
        return 'Skipped';
      case 'failed':
        return 'Failed';
      case 'sending':
        return 'Sending';
      case 'sent':
        return 'Sent';
      default:
        return 'Idle';
    }
  }

  function createModeSelect(record) {
    const select = document.createElement('select');
    select.className = 'xga-card-select';

    const autoOption = document.createElement('option');
    autoOption.value = 'auto';
    autoOption.textContent = 'Auto';
    select.appendChild(autoOption);

    for (const tone of TONES) {
      const option = document.createElement('option');
      option.value = tone.key;
      option.textContent = tone.label;
      select.appendChild(option);
    }

    select.value = record.selectedMode || 'auto';
    select.addEventListener('change', (event) => {
      record.selectedMode = event.target.value;
    });
    return select;
  }

  function createButton(label, className, onClick, disabled = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function focusDraft(postId) {
    state.focusedPostId = postId;
    state.interactionLockedUntil = Date.now() + 5000;
    render(collectCandidateArticles());
  }

  function buildCard(record, compact = false) {
    const card = document.createElement('section');
    card.className = `xga-card${compact ? ' compact' : ''}`;

    const header = document.createElement('div');
    header.className = 'xga-card-header';

    const title = document.createElement('div');
    title.className = 'xga-card-title';
    title.textContent = getStrategyLabel(record);

    const badge = document.createElement('span');
    badge.className = `xga-card-badge ${record.status}`;
    badge.textContent = getStatusLabel(record);

    header.appendChild(title);
    header.appendChild(badge);
    card.appendChild(header);

    const preview = document.createElement('div');
    preview.className = 'xga-card-preview';
    preview.textContent = record.posterHandle ? `${record.posterHandle} · ${record.text}` : record.text;
    card.appendChild(preview);

    if (record.error && ['failed', 'skipped'].includes(record.status)) {
      const reason = document.createElement('div');
      reason.className = 'xga-card-reason';
      reason.textContent = record.error;
      card.appendChild(reason);
    }

    if (['ready', 'failed', 'sending', 'sent'].includes(record.status)) {
      const textarea = document.createElement('textarea');
      textarea.className = 'xga-card-textarea';
      textarea.value = record.editedText || record.autoText || '';
      textarea.placeholder = 'Draft will appear here';
      textarea.disabled = record.status === 'sending';
      textarea.addEventListener('input', (event) => {
        record.editedText = event.target.value;
      });
      card.appendChild(textarea);
    } else {
      const status = document.createElement('div');
      status.className = 'xga-card-statusline';
      status.textContent = record.status === 'generating'
        ? 'Preparing draft...'
        : record.status === 'queued'
          ? 'Waiting in queue...'
          : 'No draft yet.';
      card.appendChild(status);
    }

    const controls = document.createElement('div');
    controls.className = 'xga-card-controls';
    controls.appendChild(createModeSelect(record));

    const actions = document.createElement('div');
    actions.className = 'xga-card-actions';

    actions.appendChild(createButton(
      'Send',
      'xga-card-btn primary',
      () => sendDraft(record.postId),
      !['ready', 'failed'].includes(record.status) || !normalizeWhitespace(record.editedText || record.autoText)
    ));

    actions.appendChild(createButton(
      'Regenerate',
      'xga-card-btn',
      () => regenerateDraft(record.postId, 'gemini-local'),
      record.status === 'sending'
    ));

    actions.appendChild(createButton(
      'Claude',
      'xga-card-btn subtle',
      () => regenerateDraft(record.postId, 'claude-local'),
      record.status === 'sending'
    ));

    actions.appendChild(createButton(
      'Skip',
      'xga-card-btn danger',
      () => skipDraft(record.postId),
      record.status === 'sending'
    ));

    controls.appendChild(actions);
    card.appendChild(controls);

    return card;
  }

  function buildOverflowStackCard(record) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'xga-stack-card';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      focusDraft(record.postId);
    });

    const header = document.createElement('div');
    header.className = 'xga-stack-card-header';

    const title = document.createElement('div');
    title.className = 'xga-stack-card-title';
    title.textContent = record.posterHandle || 'Post draft';

    const badge = document.createElement('span');
    badge.className = `xga-card-badge ${record.status}`;
    badge.textContent = getStatusLabel(record);

    header.appendChild(title);
    header.appendChild(badge);
    button.appendChild(header);

    const preview = document.createElement('div');
    preview.className = 'xga-stack-card-preview';
    preview.textContent = record.text || 'No post text available.';
    button.appendChild(preview);

    const meta = document.createElement('div');
    meta.className = 'xga-stack-card-meta';
    if (record.status === 'ready') {
      meta.textContent = `${getStrategyLabel(record)} draft ready`;
    } else if (record.status === 'generating') {
      meta.textContent = 'Generating draft...';
    } else if (record.error) {
      meta.textContent = record.error;
    } else if (record.status === 'queued') {
      meta.textContent = 'Waiting in queue...';
    } else {
      meta.textContent = 'Tap to open this draft.';
    }
    button.appendChild(meta);

    return button;
  }

  function getInlineLayout(items) {
    const visibleItems = items.filter((item) => state.visibleIds.includes(item.postId));
    const visibleMap = new Map(visibleItems.map((item) => [item.postId, item]));

    if (state.focusedPostId && !visibleMap.has(state.focusedPostId)) {
      state.focusedPostId = '';
    }

    const ranked = [];
    if (state.focusedPostId) {
      const focusedItem = visibleMap.get(state.focusedPostId);
      if (focusedItem) ranked.push(focusedItem);
    }

    for (const postId of state.priorityIds) {
      const item = visibleMap.get(postId);
      if (!item || ranked.some((entry) => entry.postId === postId)) continue;
      ranked.push(item);
    }

    const mainItems = ranked
      .slice(0, INLINE_MAIN_CARD_COUNT)
      .sort((a, b) => a.rect.top - b.rect.top);
    const mainIds = new Set(mainItems.map((item) => item.postId));
    const overflowItems = visibleItems.filter((item) => !mainIds.has(item.postId));

    return {
      mainItems,
      overflowItems
    };
  }

  function computeInlineCardOpacity(rect) {
    if (rect.bottom <= 72) return 0;
    if (rect.top >= 72) return 1;
    return Math.max(0, Math.min(1, (rect.bottom - 72) / 120));
  }

  function renderOverflowStack(items) {
    state.drawerRoot.innerHTML = '';
    if (items.length === 0) {
      state.drawerRoot.classList.remove('active', 'overflow-active');
      return;
    }

    state.drawerRoot.classList.add('active', 'overflow-active');

    const stack = document.createElement('section');
    stack.className = 'xga-overflow-stack';

    const header = document.createElement('div');
    header.className = 'xga-overflow-header';

    const title = document.createElement('div');
    title.className = 'xga-overflow-title';
    title.textContent = `More Drafts (${items.length})`;

    const hint = document.createElement('div');
    hint.className = 'xga-overflow-hint';
    hint.textContent = 'Tap to swap into the main card area.';

    header.appendChild(title);
    header.appendChild(hint);
    stack.appendChild(header);

    const list = document.createElement('div');
    list.className = 'xga-overflow-list';

    for (const item of items) {
      const record = state.drafts.get(item.postId);
      if (!record) continue;
      list.appendChild(buildOverflowStackCard(record));
    }

    stack.appendChild(list);
    state.drawerRoot.appendChild(stack);
  }

  function renderInlineCards(items) {
    state.overlayRoot.innerHTML = '';
    state.overlayRoot.classList.add('active');
    const { mainItems, overflowItems } = getInlineLayout(items);
    let previousBottom = Number.NEGATIVE_INFINITY;

    for (const item of mainItems) {
      const record = state.drafts.get(item.postId);
      if (!record) continue;

      const card = buildCard(record, false);
      const opacity = computeInlineCardOpacity(item.rect);
      if (opacity <= 0.02) continue;

      const anchoredTop = item.rect.top;
      const left = Math.min(window.innerWidth - CARD_WIDTH - 20, item.rect.right + 20);
      card.addEventListener('pointerdown', () => {
        state.focusedPostId = record.postId;
      }, true);
      card.addEventListener('focusin', () => {
        state.focusedPostId = record.postId;
      }, true);
      card.style.left = `${left}px`;
      card.style.top = `${anchoredTop}px`;
      card.style.opacity = `${opacity}`;
      card.style.pointerEvents = opacity < 0.35 ? 'none' : 'auto';
      state.overlayRoot.appendChild(card);

      const resolvedTop = Math.max(anchoredTop, previousBottom + INLINE_CARD_GAP);
      if (resolvedTop !== anchoredTop) {
        card.style.top = `${resolvedTop}px`;
      }
      previousBottom = resolvedTop + card.offsetHeight;
    }

    renderOverflowStack(overflowItems);
  }

  function renderDrawer(items) {
    state.overlayRoot.innerHTML = '';
    state.overlayRoot.classList.remove('active');
    state.drawerRoot.innerHTML = '';
    state.drawerRoot.classList.remove('overflow-active');
    state.drawerRoot.classList.add('active');

    const list = document.createElement('div');
    list.className = 'xga-drawer-list';

    for (const item of items.filter((entry) => state.visibleIds.includes(entry.postId))) {
      const record = state.drafts.get(item.postId);
      if (!record) continue;
      list.appendChild(buildCard(record, true));
    }

    state.drawerRoot.appendChild(list);
  }

  function render(items) {
    ensureUiRoots();
    if (shouldUseDrawer(items)) {
      renderDrawer(items);
      return;
    }
    renderInlineCards(items);
  }

  function getQueuedRecords(limit = AUTO_DRAFT_CONCURRENCY - state.activeGenerationCount) {
    if (limit <= 0 || !isAutoDraftView()) return [];

    const records = [];
    for (const postId of state.priorityIds) {
      const record = state.drafts.get(postId);
      if (!record || record.status !== 'queued' || state.inFlightPostIds.has(postId)) continue;
      records.push(record);
      if (records.length >= limit) break;
    }
    return records;
  }

  async function generateQueuedDraft(record) {
    state.activeGenerationCount += 1;
    state.inFlightPostIds.add(record.postId);
    record.status = 'generating';
    const requestedText = record.text;
    const requestedContext = record.context;
    render(collectCandidateArticles());

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GENERATE_DRAFT',
        mode: 'auto',
        phase: 'quick',
        provider: 'gemini-local',
        tweetText: requestedText,
        context: requestedContext,
        requestId: createRequestId()
      });

      if (response.status === 'ready') {
        record.status = 'ready';
        record.strategyType = response.strategyType;
        record.baseTone = response.baseTone;
        record.autoText = response.text;
        record.editedText = response.text;
        record.error = '';
      } else if (response.status === 'skipped') {
        record.status = 'skipped';
        record.error = response.reason || 'Skipped';
      } else {
        record.status = 'failed';
        record.error = response.reason || 'Draft generation failed';
      }
    } catch (error) {
      record.status = 'failed';
      record.error = formatGenerationError(error);
    } finally {
      state.inFlightPostIds.delete(record.postId);
      state.activeGenerationCount = Math.max(0, state.activeGenerationCount - 1);
      const items = collectCandidateArticles();
      syncDraftsWithFeed(items);
      computePriority(items);
      render(items);
      processQueue();
    }
  }

  function processQueue() {
    const records = getQueuedRecords();
    if (records.length === 0) return;

    for (const record of records) {
      void generateQueuedDraft(record);
    }
  }

  function skipDraft(postId) {
    const record = state.drafts.get(postId);
    if (!record || record.status === 'sending') return;
    if (state.focusedPostId === postId) state.focusedPostId = '';
    record.status = 'skipped';
    record.error = 'Skipped manually.';
    render(collectCandidateArticles());
  }

  async function regenerateDraft(postId, provider) {
    const record = state.drafts.get(postId);
    if (!record || isLockedDraftStatus(record.status)) return;

    state.focusedPostId = postId;
    record.status = 'generating';
    record.error = '';
    const requestedText = record.text;
    const requestedContext = record.context;
    const currentDraft = record.editedText || record.autoText;
    const baseToneHint = record.baseTone;
    const strategyTypeHint = record.strategyType;
    render(collectCandidateArticles());

    try {
      const mode = record.selectedMode || 'auto';
      const response = await chrome.runtime.sendMessage({
        type: 'GENERATE_DRAFT',
        mode: mode === 'auto' ? 'auto' : 'tone',
        tone: mode === 'auto' ? null : mode,
        phase: 'full',
        provider,
        tweetText: requestedText,
        context: requestedContext,
        currentDraft,
        baseToneHint,
        strategyTypeHint,
        requestId: createRequestId()
      });

      if (response.status === 'ready') {
        record.status = 'ready';
        record.strategyType = response.strategyType || record.strategyType;
        record.baseTone = response.baseTone || record.baseTone;
        record.autoText = response.text;
        record.editedText = response.text;
        record.error = '';
      } else if (response.status === 'skipped') {
        record.status = 'skipped';
        record.error = response.reason || 'Skipped';
      } else {
        record.status = 'failed';
        record.error = response.reason || 'Draft generation failed';
      }
    } catch (error) {
      record.status = 'failed';
      record.error = formatGenerationError(error);
    }

    render(collectCandidateArticles());
  }

  function findComposerTextarea(root = document) {
    const selectors = [
      '[data-testid="tweetTextarea_0"]',
      '[data-testid="tweetTextarea_0_label"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[data-contents="true"]'
    ];

    for (const selector of selectors) {
      const el = root.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function findSendButton(root) {
    return root.querySelector('[data-testid="tweetButton"]') ||
      root.querySelector('[data-testid="tweetButtonInline"]') ||
      root.querySelector('button[data-testid*="tweet"]');
  }

  function insertTextIntoComposer(textarea, text) {
    const editable = textarea.closest('[contenteditable="true"]') ||
      textarea.querySelector('[contenteditable="true"]') ||
      (textarea.getAttribute('contenteditable') === 'true' ? textarea : null) ||
      textarea;

    editable.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editable);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, text);

    setTimeout(() => {
      const current = normalizeWhitespace(editable.innerText);
      if (current === normalizeWhitespace(text)) return;

      const spans = editable.querySelectorAll('[data-text="true"]');
      if (spans.length > 0) {
        spans.forEach((span) => { span.textContent = ''; });
        spans[0].textContent = text;
      } else {
        editable.textContent = text;
      }
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      editable.dispatchEvent(new Event('change', { bubbles: true }));
    }, 100);
  }

  function waitFor(condition, timeoutMs = 6000) {
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      function tick() {
        const result = condition();
        if (result) {
          resolve(result);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error('Timed out waiting for X reply composer'));
          return;
        }
        setTimeout(tick, 80);
      }
      tick();
    });
  }

  async function openReplyComposer(article) {
    const replyButton = findReplyButton(article);
    if (!replyButton) {
      throw new Error('Could not find the reply button for this post.');
    }

    const knownDialogs = new Set(Array.from(document.querySelectorAll('[role="dialog"]')));
    replyButton.click();

    return waitFor(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      const dialog = dialogs.find((node) => !knownDialogs.has(node) && findComposerTextarea(node)) ||
        dialogs.find((node) => findComposerTextarea(node));
      if (!dialog) return null;

      const textarea = findComposerTextarea(dialog);
      const sendButton = findSendButton(dialog);
      if (!textarea || !sendButton) return null;

      return { dialog, textarea, sendButton };
    });
  }

  async function sendDraft(postId) {
    const record = state.drafts.get(postId);
    if (!record || !record.article) return;

    state.focusedPostId = postId;
    const finalText = normalizeWhitespace(record.editedText || record.autoText);
    if (!finalText) return;

    record.status = 'sending';
    record.error = '';
    render(collectCandidateArticles());

    try {
      const composer = await openReplyComposer(record.article);
      insertTextIntoComposer(composer.textarea, finalText);
      await waitFor(() => normalizeWhitespace(composer.textarea.innerText || composer.textarea.textContent || '') === finalText, 2500).catch(() => true);
      composer.sendButton.click();
      await waitFor(() => !composer.dialog.isConnected, 8000);

      record.status = 'sent';
      record.error = '';

      if (record.baseTone && record.autoText) {
        chrome.runtime.sendMessage({
          type: 'SAVE_COMPARISON',
          tone: record.baseTone,
          entry: {
            originalPost: record.text,
            aiGenerated: record.autoText,
            userFinal: finalText,
            timestamp: Date.now()
          }
        });
      }
    } catch (error) {
      record.status = 'failed';
      record.error = formatGenerationError(error);
      console.error(LOG_PREFIX, 'Send failed', error);
    }

    render(collectCandidateArticles());
  }

  function refresh() {
    const items = collectCandidateArticles();
    syncDraftsWithFeed(items);
    computePriority(items);
    if (!isUserInteractingWithCard()) {
      render(items);
    }
    processQueue();
  }

  function scheduleRefresh() {
    if (state.refreshScheduled) return;
    state.refreshScheduled = true;
    requestAnimationFrame(() => {
      state.refreshScheduled = false;
      refresh();
    });
  }

  function observeFeed() {
    const observer = new MutationObserver((mutations) => {
      if (shouldIgnoreMutations(mutations)) return;
      scheduleRefresh();
    });

    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('scroll', scheduleRefresh, { passive: true });
    window.addEventListener('resize', scheduleRefresh);

    refresh();
    setTimeout(refresh, 1000);
    setTimeout(refresh, 3000);
    console.log(LOG_PREFIX, 'Feed observer started');
  }

  function init() {
    console.log(LOG_PREFIX, 'Content script initialized on', window.location.href);
    ensureUiRoots();
    observeFeed();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
