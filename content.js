(function () {
  'use strict';

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
  const SENT_HISTORY_LIMIT = 18;
  const MAX_REPLY_POST_AGE_MS = 2 * 60 * 60 * 1000;
  const DRAFT_HANDOFFS_KEY = 'xga_draft_handoffs';
  const SENT_POSTS_KEY = 'xga_sent_posts';
  const MAX_SENT_POSTS = 500;
  const STALE_POST_SKIP_REASON = 'Skipped because the post is older than 2 hours.';
  const LOG_PREFIX = '[XGA]';

  const state = {
    drafts: new Map(),
    visibleIds: [],
    priorityIds: [],
    overlayRoot: null,
    drawerRoot: null,
    activeGenerationCount: 0,
    inFlightPostIds: new Set(),
    expandedDeckCardId: '',
    sentHistory: [],
    sentCount: 0,
    persistedSentPosts: new Map(),
    draftHandoffs: new Map(),
    refreshScheduled: false,
    ownUsername: ''
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

  function normalizeHandleIdentifier(handle) {
    return normalizeWhitespace(handle)
      .replace(/^@/, '')
      .toLowerCase();
  }

  function isOwnPosterHandle(posterHandle) {
    const ownUsername = normalizeHandleIdentifier(state.ownUsername);
    return Boolean(ownUsername && normalizeHandleIdentifier(posterHandle) === ownUsername);
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

  function findTweetUrl(article) {
    const timeLink = article.querySelector('a[href*="/status/"] time')?.closest('a[href*="/status/"]');
    const fallback = timeLink || article.querySelector('a[href*="/status/"]');
    const href = fallback?.getAttribute('href') || '';
    if (!href) return '';

    try {
      return new URL(href, window.location.origin).toString();
    } catch {
      return '';
    }
  }

  function findTweetCreatedAt(article) {
    const time = article.querySelector('a[href*="/status/"] time[datetime]');
    const timestamp = Date.parse(time?.getAttribute('datetime') || '');
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function isFreshReplyTarget(createdAt, now = Date.now()) {
    return Number.isFinite(createdAt) && createdAt > 0 && now - createdAt <= MAX_REPLY_POST_AGE_MS;
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
    const candidate = article.querySelector('button[data-testid="reply"]') ||
      article.querySelector('[data-testid="reply"]');
    if (!candidate) return null;
    return candidate.closest('button, [role="button"]') || candidate;
  }

  function isElementDisabled(element) {
    if (!element) return true;
    if (typeof element.matches === 'function' && element.matches(':disabled')) return true;
    if (element.getAttribute?.('disabled') !== null) return true;
    if (element.getAttribute?.('aria-disabled') === 'true') return true;

    const disabledAncestor = element.closest?.(':disabled, [disabled], [aria-disabled="true"]');
    if (disabledAncestor) return true;

    const computed = window.getComputedStyle(element);
    if (computed.pointerEvents === 'none') return true;

    return false;
  }

  function canReplyToArticle(article) {
    const replyButton = findReplyButton(article);
    if (!replyButton) return false;
    return !isElementDisabled(replyButton);
  }

  function isPromotedArticle(article) {
    if (article.closest('div[data-testid="placementTracking"]')) return true;
    if (article.querySelector('div[data-testid="placementTracking"]')) return true;

    const articleRect = article.getBoundingClientRect();
    const adBadge = Array.from(article.querySelectorAll('span, div, a'))
      .find((element) => {
        const text = normalizeWhitespace(element.textContent || '');
        if (!/^(ad|promoted|promoted by)$/i.test(text)) return false;

        const rect = element.getBoundingClientRect();
        const withinHeaderBand = rect.top >= articleRect.top - 8 && rect.bottom <= articleRect.top + 72;
        const nearRightEdge = rect.right >= articleRect.right - 140;
        return withinHeaderBand && nearRightEdge;
      });

    return Boolean(adBadge);
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
    if (canReplyToArticle(item.article)) score += 2;
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
        if (isPromotedArticle(article) || !canReplyToArticle(article)) return null;

        const postId = findTweetId(article);
        if (!postId || isPersistedSentPost(postId)) return null;

        const createdAt = findTweetCreatedAt(article);
        if (!isFreshReplyTarget(createdAt)) return null;

        const text = findTweetText(article);
        const quotedTweet = findQuotedTweet(article);
        if (!text && !quotedTweet?.text) return null;

        const rect = article.getBoundingClientRect();
        const posterHandle = findPosterHandle(article);
        if (isOwnPosterHandle(posterHandle)) return null;
        return {
          postId,
          article,
          text,
          tweetUrl: findTweetUrl(article),
          createdAt,
          rect,
          posterHandle,
          context: {
            createdAt,
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
      document.body.appendChild(overlay);
      state.overlayRoot = overlay;
    }

    if (!state.drawerRoot) {
      const drawer = document.createElement('div');
      drawer.className = 'xga-drawer-root';
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
    return Boolean(active && active.closest('.xga-card-textarea, .xga-deck-card-textarea'));
  }

  function createDraftRecord(item) {
    return {
      postId: item.postId,
      article: item.article,
      text: item.text,
      tweetUrl: item.tweetUrl,
      createdAt: item.createdAt,
      posterHandle: item.posterHandle,
      context: item.context,
      status: 'idle',
      strategyType: null,
      baseTone: null,
      autoText: '',
      editedText: '',
      modelLabel: '',
      error: '',
      lastSeenAt: Date.now()
    };
  }

  function isLockedDraftStatus(status) {
    return ['sending', 'sent'].includes(status);
  }

  function updateDraftRecord(record, item) {
    record.article = item.article;
    record.tweetUrl = item.tweetUrl;
    record.createdAt = item.createdAt;
    record.posterHandle = item.posterHandle;
    record.context = item.context;
    record.lastSeenAt = Date.now();
    record.text = item.text;
  }

  function createDraftHandoff(record) {
    return {
      status: record.status === 'sending' ? 'ready' : record.status,
      strategyType: record.strategyType || null,
      baseTone: record.baseTone || null,
      autoText: record.autoText || '',
      editedText: record.editedText || '',
      modelLabel: record.modelLabel || '',
      error: record.error || '',
      posterHandle: record.posterHandle || '',
      text: record.text || '',
      tweetUrl: record.tweetUrl || '',
      createdAt: record.createdAt || 0,
      savedAt: Date.now()
    };
  }

  function createPersistedSentPost(record, finalText) {
    return {
      tweetUrl: record.tweetUrl || '',
      posterHandle: record.posterHandle || '',
      text: record.text || '',
      draftText: finalText || '',
      createdAt: record.createdAt || 0,
      sentAt: Date.now()
    };
  }

  async function persistDraftHandoffs() {
    await chrome.storage.local.set({
      [DRAFT_HANDOFFS_KEY]: Object.fromEntries(state.draftHandoffs.entries())
    });
  }

  async function persistSentPosts() {
    await chrome.storage.local.set({
      [SENT_POSTS_KEY]: Object.fromEntries(state.persistedSentPosts.entries())
    });
  }

  async function loadDraftHandoffs() {
    try {
      const result = await chrome.storage.local.get(DRAFT_HANDOFFS_KEY);
      const handoffs = result?.[DRAFT_HANDOFFS_KEY];
      state.draftHandoffs = handoffs && typeof handoffs === 'object'
        ? new Map(Object.entries(handoffs))
        : new Map();
    } catch (error) {
      console.warn(LOG_PREFIX, 'Could not load draft handoffs', error);
      state.draftHandoffs = new Map();
    }
  }

  async function loadSentPosts() {
    try {
      const result = await chrome.storage.local.get(SENT_POSTS_KEY);
      const sentPosts = result?.[SENT_POSTS_KEY];
      state.persistedSentPosts = sentPosts && typeof sentPosts === 'object'
        ? new Map(Object.entries(sentPosts))
        : new Map();
    } catch (error) {
      console.warn(LOG_PREFIX, 'Could not load sent posts', error);
      state.persistedSentPosts = new Map();
    }
  }

  function applyDraftHandoff(record) {
    const handoff = state.draftHandoffs.get(record.postId);
    if (!handoff) return;

    if (typeof handoff.posterHandle === 'string' && handoff.posterHandle) {
      record.posterHandle = handoff.posterHandle;
    }
    if (typeof handoff.text === 'string' && handoff.text) {
      record.text = handoff.text;
    }
    if (typeof handoff.tweetUrl === 'string' && handoff.tweetUrl) {
      record.tweetUrl = handoff.tweetUrl;
    }
    if (Number.isFinite(handoff.createdAt) && handoff.createdAt > 0) {
      record.createdAt = handoff.createdAt;
    }

    record.status = typeof handoff.status === 'string' ? handoff.status : record.status;
    record.strategyType = handoff.strategyType || null;
    record.baseTone = handoff.baseTone || null;
    record.autoText = handoff.autoText || '';
    record.editedText = handoff.editedText || '';
    record.modelLabel = handoff.modelLabel || '';
    record.error = handoff.error || '';
    record.lastSeenAt = typeof handoff.savedAt === 'number' ? handoff.savedAt : record.lastSeenAt;

    state.draftHandoffs.delete(record.postId);
    void persistDraftHandoffs().catch((error) => {
      console.warn(LOG_PREFIX, 'Could not clear used draft handoff', error);
    });
  }

  function isPersistedSentPost(postId) {
    return state.persistedSentPosts.has(postId);
  }

  function markPersistedSentPost(record, finalText) {
    state.persistedSentPosts.set(record.postId, createPersistedSentPost(record, finalText));
    state.persistedSentPosts = new Map(
      Array.from(state.persistedSentPosts.entries())
        .sort((a, b) => (b[1]?.sentAt || 0) - (a[1]?.sentAt || 0))
        .slice(0, MAX_SENT_POSTS)
    );
    void persistSentPosts().catch((error) => {
      console.warn(LOG_PREFIX, 'Could not persist sent post registry', error);
    });
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
        applyDraftHandoff(record);
      } else {
        const nextRecord = createDraftRecord(item);
        applyDraftHandoff(nextRecord);
        state.drafts.set(item.postId, nextRecord);
      }
    }
    pruneDrafts();
  }

  function removeOwnDrafts() {
    for (const [postId, record] of state.drafts.entries()) {
      if (!isOwnPosterHandle(record.posterHandle) || record.status === 'sending') continue;
      state.drafts.delete(postId);
      state.inFlightPostIds.delete(postId);
    }

    state.visibleIds = state.visibleIds.filter((postId) => state.drafts.has(postId));
    state.priorityIds = state.priorityIds.filter((postId) => state.drafts.has(postId));
    if (state.expandedDeckCardId && !state.drafts.has(state.expandedDeckCardId)) {
      state.expandedDeckCardId = '';
    }
  }

  function removePersistedSentDrafts() {
    for (const [postId, record] of state.drafts.entries()) {
      if (!isPersistedSentPost(postId) || record.status === 'sending') continue;
      state.drafts.delete(postId);
      state.inFlightPostIds.delete(postId);
    }

    state.visibleIds = state.visibleIds.filter((postId) => state.drafts.has(postId));
    state.priorityIds = state.priorityIds.filter((postId) => state.drafts.has(postId));
    if (state.expandedDeckCardId && !state.drafts.has(state.expandedDeckCardId)) {
      state.expandedDeckCardId = '';
    }
  }

  function refreshDraftCreatedAt(record) {
    const article = resolveArticle(record.postId, record.article);
    if (!article) return;

    const createdAt = findTweetCreatedAt(article);
    if (!createdAt) return;

    record.article = article;
    record.createdAt = createdAt;
  }

  function isFreshDraftRecord(record) {
    refreshDraftCreatedAt(record);
    return isFreshReplyTarget(record.createdAt);
  }

  function markStaleDraft(record) {
    record.status = 'skipped';
    record.error = STALE_POST_SKIP_REASON;
    record.autoText = '';
    record.editedText = '';
  }

  function removeStaleDrafts() {
    for (const [postId, record] of state.drafts.entries()) {
      if (record.status === 'sending') continue;
      if (isFreshDraftRecord(record)) continue;

      state.drafts.delete(postId);
      state.inFlightPostIds.delete(postId);
    }

    state.visibleIds = state.visibleIds.filter((postId) => state.drafts.has(postId));
    state.priorityIds = state.priorityIds.filter((postId) => state.drafts.has(postId));
    if (state.expandedDeckCardId && !state.drafts.has(state.expandedDeckCardId)) {
      state.expandedDeckCardId = '';
    }
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

  function createModelBadge(modelLabel) {
    const label = normalizeWhitespace(modelLabel).toLowerCase();
    if (!label) return null;

    const badge = document.createElement('span');
    badge.className = 'xga-card-model-badge';
    badge.textContent = label;
    return badge;
  }

  function buildCard(record, compact = false) {
    const card = document.createElement('section');
    card.className = `xga-card${compact ? ' compact' : ''}`;

    const header = document.createElement('div');
    header.className = 'xga-card-header';

    const titleRow = document.createElement('div');
    titleRow.className = 'xga-card-title-row';

    const title = document.createElement('div');
    title.className = 'xga-card-title';
    title.textContent = getStrategyLabel(record);
    titleRow.appendChild(title);

    const modelBadge = createModelBadge(record.modelLabel);
    if (modelBadge) titleRow.appendChild(modelBadge);

    const badge = document.createElement('span');
    badge.className = `xga-card-badge ${record.status}`;
    badge.textContent = getStatusLabel(record);

    header.appendChild(titleRow);
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
      () => regenerateDraft(record.postId),
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

  function getInlineLayout(items) {
    const visibleItems = items.filter((item) => state.visibleIds.includes(item.postId));
    const visibleMap = new Map(visibleItems.map((item) => [item.postId, item]));

    const ranked = [];
    for (const postId of state.priorityIds) {
      const item = visibleMap.get(postId);
      if (!item || ranked.some((entry) => entry.postId === postId)) continue;
      ranked.push(item);
    }

    return {
      mainItems: ranked
        .slice(0, INLINE_MAIN_CARD_COUNT)
        .sort((a, b) => a.rect.top - b.rect.top)
    };
  }

  function computeInlineCardOpacity(rect) {
    if (rect.bottom <= 72) return 0;
    if (rect.top >= 72) return 1;
    return Math.max(0, Math.min(1, (rect.bottom - 72) / 120));
  }

  function getOffscreenDistance(postId, itemMap) {
    const item = itemMap.get(postId);
    if (!item) return Number.MAX_SAFE_INTEGER;

    if (item.rect.top >= window.innerHeight - 24) {
      return item.rect.top - (window.innerHeight - 24);
    }
    if (item.rect.bottom <= 24) {
      return 24 - item.rect.bottom;
    }
    return 0;
  }

  function compareDeckRecords(a, b, itemMap) {
    const distanceDelta = getOffscreenDistance(a.postId, itemMap) - getOffscreenDistance(b.postId, itemMap);
    if (distanceDelta !== 0) return distanceDelta;
    return b.lastSeenAt - a.lastSeenAt;
  }

  function getDeckState(items) {
    const itemMap = new Map(items.map((item) => [item.postId, item]));
    const visibleSet = new Set(state.visibleIds);
    const offscreenRecords = Array.from(state.drafts.values())
      .filter((record) => !visibleSet.has(record.postId));

    const ready = offscreenRecords
      .filter((record) => ['ready', 'failed'].includes(record.status))
      .sort((a, b) => compareDeckRecords(a, b, itemMap));
    const processing = offscreenRecords
      .filter((record) => ['queued', 'generating'].includes(record.status))
      .sort((a, b) => compareDeckRecords(a, b, itemMap));
    const sent = state.sentHistory
      .filter((entry) => !visibleSet.has(entry.postId))
      .sort((a, b) => b.sentAt - a.sentAt);

    const deckIds = new Set([
      ...ready.map((record) => record.postId),
      ...processing.map((record) => record.postId),
      ...sent.map((entry) => entry.postId)
    ]);
    if (state.expandedDeckCardId && !deckIds.has(state.expandedDeckCardId)) {
      state.expandedDeckCardId = '';
    }

    return { ready, processing, sent };
  }

  function toggleDeckCard(postId) {
    state.expandedDeckCardId = state.expandedDeckCardId === postId ? '' : postId;
    render(collectCandidateArticles());
  }

  function flashArticle(article) {
    if (!article) return;
    article.classList.remove('xga-post-highlight');
    requestAnimationFrame(() => {
      article.classList.add('xga-post-highlight');
      window.setTimeout(() => article.classList.remove('xga-post-highlight'), 1800);
    });
  }

  function resolveArticle(postId, fallbackArticle = null) {
    if (fallbackArticle?.isConnected) return fallbackArticle;
    return document.querySelector(`a[href*="/status/${postId}"]`)?.closest('article') || null;
  }

  async function openPost(postId) {
    const record = state.drafts.get(postId);
    const article = resolveArticle(postId, record?.article || null);
    if (article) {
      if (record) record.article = article;
      article.scrollIntoView({ behavior: 'smooth', block: 'center' });
      flashArticle(article);
      return;
    }

    const sentEntry = state.sentHistory.find((entry) => entry.postId === postId);
    const tweetUrl = record?.tweetUrl || sentEntry?.tweetUrl || '';
    if (!tweetUrl) return;

    if (record) {
      state.draftHandoffs.set(postId, createDraftHandoff(record));
      try {
        await persistDraftHandoffs();
      } catch (error) {
        console.warn(LOG_PREFIX, 'Could not persist draft handoff', error);
      }
    }

    window.location.assign(tweetUrl);
  }

  function rememberSentDraft(record, finalText) {
    state.sentCount += 1;
    state.sentHistory = [
      {
        postId: record.postId,
        posterHandle: record.posterHandle,
        text: record.text,
        tweetUrl: record.tweetUrl,
        draftText: finalText,
        modelLabel: record.modelLabel,
        sentAt: Date.now()
      },
      ...state.sentHistory.filter((entry) => entry.postId !== record.postId)
    ].slice(0, SENT_HISTORY_LIMIT);
  }

  function buildDeckCard(recordOrEntry, deckKind, depth = 0) {
    const postId = recordOrEntry.postId;
    const expanded = state.expandedDeckCardId === postId;
    const status = deckKind === 'sent' ? 'sent' : recordOrEntry.status;
    const visualDepth = Math.min(depth, 4);

    const card = document.createElement('article');
    card.className = `xga-deck-card${expanded ? ' is-expanded' : ''}`;
    card.style.setProperty('--xga-depth', String(visualDepth));
    card.tabIndex = 0;
    card.addEventListener('click', (event) => {
      if (event.target.closest('button, textarea, select, option, a')) return;
      toggleDeckCard(postId);
    });
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleDeckCard(postId);
    });

    const header = document.createElement('div');
    header.className = 'xga-deck-card-header';

    const titleRow = document.createElement('div');
    titleRow.className = 'xga-deck-card-title-row';

    const title = document.createElement('div');
    title.className = 'xga-deck-card-title';
    title.textContent = recordOrEntry.posterHandle || 'Post draft';
    titleRow.appendChild(title);

    const modelBadge = createModelBadge(recordOrEntry.modelLabel);
    if (modelBadge) titleRow.appendChild(modelBadge);

    const badge = document.createElement('span');
    badge.className = `xga-card-badge ${status}`;
    badge.textContent = getStatusLabel({ status });

    header.appendChild(titleRow);
    header.appendChild(badge);
    card.appendChild(header);

    const preview = document.createElement('div');
    preview.className = 'xga-deck-card-preview';
    preview.textContent = recordOrEntry.text || 'No post text available.';
    card.appendChild(preview);

    const meta = document.createElement('div');
    meta.className = 'xga-deck-card-meta';
    if (deckKind === 'sent') {
      meta.textContent = 'Already sent. Expand this card if you want to revisit the reply.';
    } else if (status === 'ready') {
      meta.textContent = 'Ready to send. Expand to edit or ship it.';
    } else if (status === 'failed') {
      meta.textContent = recordOrEntry.error || 'Needs attention before it can be sent.';
    } else if (status === 'generating') {
      meta.textContent = 'Generating in the background.';
    } else {
      meta.textContent = 'Queued in the background.';
    }
    card.appendChild(meta);

    const details = document.createElement('div');
    details.className = 'xga-deck-card-details';

    if (expanded) {
      if (deckKind === 'ready') {
        if (recordOrEntry.error && recordOrEntry.status === 'failed') {
          const reason = document.createElement('div');
          reason.className = 'xga-card-reason';
          reason.textContent = recordOrEntry.error;
          details.appendChild(reason);
        }

        const textarea = document.createElement('textarea');
        textarea.className = 'xga-deck-card-textarea';
        textarea.value = recordOrEntry.editedText || recordOrEntry.autoText || '';
        textarea.placeholder = 'Draft will appear here';
        textarea.disabled = recordOrEntry.status === 'sending';
        textarea.addEventListener('input', (event) => {
          recordOrEntry.editedText = event.target.value;
        });
        details.appendChild(textarea);

        const controls = document.createElement('div');
        controls.className = 'xga-deck-card-controls';

        const primaryActions = document.createElement('div');
        primaryActions.className = 'xga-deck-card-actions primary-row';
        primaryActions.appendChild(createButton(
          'Send',
          'xga-card-btn primary',
          () => sendDraft(recordOrEntry.postId),
          recordOrEntry.status !== 'ready' || !normalizeWhitespace(recordOrEntry.editedText || recordOrEntry.autoText)
        ));
        primaryActions.appendChild(createButton(
          'Open Post',
          'xga-card-btn',
          () => openPost(recordOrEntry.postId)
        ));
        controls.appendChild(primaryActions);

        const secondaryActions = document.createElement('div');
        secondaryActions.className = 'xga-deck-card-actions';
        secondaryActions.appendChild(createButton(
          'Regenerate',
          'xga-card-btn',
          () => regenerateDraft(recordOrEntry.postId),
          recordOrEntry.status === 'sending'
        ));
        secondaryActions.appendChild(createButton(
          'Skip',
          'xga-card-btn danger',
          () => skipDraft(recordOrEntry.postId),
          recordOrEntry.status === 'sending'
        ));
        controls.appendChild(secondaryActions);
        details.appendChild(controls);
      } else if (deckKind === 'processing') {
        const statusLine = document.createElement('div');
        statusLine.className = 'xga-card-statusline';
        statusLine.textContent = recordOrEntry.status === 'generating'
          ? 'Preparing the draft right now.'
          : 'Queued and waiting for a concurrency slot.';
        details.appendChild(statusLine);

        const actions = document.createElement('div');
        actions.className = 'xga-deck-card-actions single-row';
        actions.appendChild(createButton(
          'Open Post',
          'xga-card-btn',
          () => openPost(recordOrEntry.postId)
        ));
        actions.appendChild(createButton(
          'Skip',
          'xga-card-btn danger',
          () => skipDraft(recordOrEntry.postId)
        ));
        details.appendChild(actions);
      } else {
        const sentDraft = document.createElement('div');
        sentDraft.className = 'xga-deck-card-sent';
        sentDraft.textContent = recordOrEntry.draftText || 'Reply sent.';
        details.appendChild(sentDraft);

        const actions = document.createElement('div');
        actions.className = 'xga-deck-card-actions single-row';
        actions.appendChild(createButton(
          'Open Post',
          'xga-card-btn',
          () => openPost(recordOrEntry.postId)
        ));
        details.appendChild(actions);
      }
    }

    card.appendChild(details);
    return card;
  }

  function buildDeck(kind, title, subtitle, items, totalCount = items.length) {
    const deck = document.createElement('section');
    deck.className = `xga-deck ${kind}`;
    if (items.some((item) => item.postId === state.expandedDeckCardId)) {
      deck.classList.add('has-expanded');
    }

    const header = document.createElement('div');
    header.className = 'xga-deck-header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'xga-deck-title-group';

    const heading = document.createElement('div');
    heading.className = 'xga-deck-title';
    heading.textContent = title;

    const hint = document.createElement('div');
    hint.className = 'xga-deck-hint';
    hint.textContent = subtitle;

    titleGroup.appendChild(heading);
    titleGroup.appendChild(hint);

    const count = document.createElement('span');
    count.className = 'xga-deck-count';
    count.textContent = String(totalCount);

    header.appendChild(titleGroup);
    header.appendChild(count);
    deck.appendChild(header);

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'xga-deck-empty';
      empty.textContent = kind === 'sent'
        ? `Sent ${totalCount} repl${totalCount === 1 ? 'y' : 'ies'} this session.`
        : 'No offscreen cards right now.';
      deck.appendChild(empty);
      return deck;
    }

    const pile = document.createElement('div');
    pile.className = 'xga-deck-pile';
    items.forEach((item, index) => {
      pile.appendChild(buildDeckCard(item, kind, index));
    });
    deck.appendChild(pile);
    return deck;
  }

  function buildDeckRail(items) {
    const { ready, processing, sent } = getDeckState(items);
    const rail = document.createElement('div');
    rail.className = 'xga-deck-rail';

    if (ready.length > 0) {
      rail.appendChild(buildDeck(
        'ready',
        'Ready',
        'Offscreen drafts you can send right now.',
        ready
      ));
    }

    if (processing.length > 0) {
      rail.appendChild(buildDeck(
        'processing',
        'Processing',
        'Queued or generating while you keep scrolling.',
        processing
      ));
    }

    if (sent.length > 0 || state.sentCount > 0) {
      rail.appendChild(buildDeck(
        'sent',
        'Sent',
        'Replies already sent in this session.',
        sent,
        state.sentCount
      ));
    }

    return rail.childElementCount > 0 ? rail : null;
  }

  function renderDeckRail(items) {
    state.drawerRoot.innerHTML = '';
    const rail = buildDeckRail(items);
    if (!rail) {
      state.drawerRoot.classList.remove('active', 'drawer-mode');
      return;
    }

    state.drawerRoot.classList.add('active');
    state.drawerRoot.classList.remove('drawer-mode');
    state.drawerRoot.appendChild(rail);
  }

  function renderInlineCards(items) {
    state.overlayRoot.innerHTML = '';
    state.overlayRoot.classList.add('active');
    const { mainItems } = getInlineLayout(items);
    let previousBottom = Number.NEGATIVE_INFINITY;

    for (const item of mainItems) {
      const record = state.drafts.get(item.postId);
      if (!record) continue;

      const card = buildCard(record, false);
      const opacity = computeInlineCardOpacity(item.rect);
      if (opacity <= 0.02) continue;

      const anchoredTop = item.rect.top;
      const left = Math.min(window.innerWidth - CARD_WIDTH - 20, item.rect.right + 20);
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

    renderDeckRail(items);
  }

  function renderDrawer(items) {
    state.overlayRoot.innerHTML = '';
    state.overlayRoot.classList.remove('active');
    state.drawerRoot.innerHTML = '';
    state.drawerRoot.classList.add('active', 'drawer-mode');

    const list = document.createElement('div');
    list.className = 'xga-drawer-list';

    for (const item of items.filter((entry) => state.visibleIds.includes(entry.postId))) {
      const record = state.drafts.get(item.postId);
      if (!record) continue;
      list.appendChild(buildCard(record, true));
    }

    state.drawerRoot.appendChild(list);

    const rail = buildDeckRail(items);
    if (rail) {
      state.drawerRoot.appendChild(rail);
    }
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
    if (isOwnPosterHandle(record.posterHandle)) {
      record.status = 'skipped';
      record.error = 'Skipped own post.';
      return;
    }
    if (!isFreshDraftRecord(record)) {
      markStaleDraft(record);
      return;
    }

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
        record.modelLabel = response.modelLabel || record.modelLabel;
        record.error = '';
      } else if (response.status === 'skipped') {
        record.status = 'skipped';
        record.modelLabel = response.modelLabel || record.modelLabel;
        record.error = response.reason || 'Skipped';
      } else {
        record.status = 'failed';
        record.modelLabel = response.modelLabel || record.modelLabel;
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
    if (state.expandedDeckCardId === postId) state.expandedDeckCardId = '';
    record.status = 'skipped';
    record.error = 'Skipped manually.';
    render(collectCandidateArticles());
  }

  async function regenerateDraft(postId) {
    const record = state.drafts.get(postId);
    if (!record || isLockedDraftStatus(record.status)) return;
    if (isOwnPosterHandle(record.posterHandle)) {
      record.status = 'skipped';
      record.error = 'Skipped own post.';
      render(collectCandidateArticles());
      return;
    }
    if (!isFreshDraftRecord(record)) {
      markStaleDraft(record);
      render(collectCandidateArticles());
      return;
    }

    record.status = 'generating';
    record.error = '';
    const requestedText = record.text;
    const requestedContext = record.context;
    const currentDraft = record.editedText || record.autoText;
    const baseToneHint = record.baseTone;
    const strategyTypeHint = record.strategyType;
    render(collectCandidateArticles());

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GENERATE_DRAFT',
        mode: 'auto',
        phase: 'full',
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
        record.modelLabel = response.modelLabel || record.modelLabel;
        record.error = '';
      } else if (response.status === 'skipped') {
        record.status = 'skipped';
        record.modelLabel = response.modelLabel || record.modelLabel;
        record.error = response.reason || 'Skipped';
      } else {
        record.status = 'failed';
        record.modelLabel = response.modelLabel || record.modelLabel;
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

  function clickElement(element) {
    if (!element) return;
    if (typeof element.click === 'function') {
      element.click();
      return;
    }

    element.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window
    }));
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
    clickElement(replyButton);

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
    if (!record) return;

    const finalText = normalizeWhitespace(record.editedText || record.autoText);
    if (!finalText) return;

    const article = resolveArticle(postId, record.article);
    if (!article) {
      record.status = 'failed';
      record.error = 'This post is no longer mounted in the feed. Use Open Post first.';
      render(collectCandidateArticles());
      return;
    }
    record.article = article;
    refreshDraftCreatedAt(record);
    if (!isFreshDraftRecord(record)) {
      markStaleDraft(record);
      render(collectCandidateArticles());
      return;
    }

    record.status = 'sending';
    record.error = '';
    render(collectCandidateArticles());

    try {
      const composer = await openReplyComposer(record.article);
      insertTextIntoComposer(composer.textarea, finalText);
      await waitFor(() => normalizeWhitespace(composer.textarea.innerText || composer.textarea.textContent || '') === finalText, 2500).catch(() => true);
      const sendButton = await waitFor(() => {
        const nextButton = findSendButton(composer.dialog);
        return nextButton && !isElementDisabled(nextButton) ? nextButton : null;
      }, 5000);
      clickElement(sendButton);
      await waitFor(() => !composer.dialog.isConnected, 8000);

      record.status = 'sent';
      record.error = '';
      rememberSentDraft(record, finalText);
      markPersistedSentPost(record, finalText);

      if (record.baseTone && record.autoText) {
        chrome.runtime.sendMessage({
          type: 'SAVE_COMPARISON',
          tone: 'auto',
          entry: {
            originalPost: record.text,
            aiGenerated: record.autoText,
            userFinal: finalText,
            strategyType: record.strategyType || null,
            baseTone: record.baseTone || null,
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
    removeOwnDrafts();
    removePersistedSentDrafts();
    removeStaleDrafts();
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

  async function loadContentSettings() {
    try {
      const { settings } = await chrome.storage.local.get('settings');
      state.ownUsername = settings?.username || '';
    } catch (error) {
      console.warn(LOG_PREFIX, 'Could not load settings', error);
      state.ownUsername = '';
    }
  }

  function observeSettings() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;

      if (changes.settings) {
        state.ownUsername = changes.settings.newValue?.username || '';
        removeOwnDrafts();
      }

      if (changes[SENT_POSTS_KEY]) {
        const sentPosts = changes[SENT_POSTS_KEY].newValue;
        state.persistedSentPosts = sentPosts && typeof sentPosts === 'object'
          ? new Map(Object.entries(sentPosts))
          : new Map();
        removePersistedSentDrafts();
      }

      if (changes.settings || changes[SENT_POSTS_KEY]) {
        scheduleRefresh();
      }
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

  async function init() {
    console.log(LOG_PREFIX, 'Content script initialized on', window.location.href);
    await loadContentSettings();
    await loadSentPosts();
    await loadDraftHandoffs();
    observeSettings();
    ensureUiRoots();
    observeFeed();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
