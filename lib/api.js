import {
  createEstimatedTokenUsage,
  extractAnthropicTokenUsage,
  extractGeminiTokenUsage,
  extractOpenAiTokenUsage
} from './token-usage.js';

const TONE_DEFAULTS = {
  supportive: 'Write a warm, encouraging reply that shows genuine interest. Keep it concise and authentic.',
  question: 'Ask a thoughtful, engaging follow-up question about the topic. Be genuinely curious.',
  smart: 'Write an insightful reply that adds value or a fresh perspective. Be concise and sharp.',
  enhance: 'Rewrite/improve the draft reply to sound more polished, engaging, and natural.',
  funny: 'Write a witty, humorous reply that is light-hearted. Avoid being offensive or try-hard.'
};
const DASH_HARD_RULES = [
  'Never use --.',
  'Never use em dashes or en dashes.',
  'Do not use dash-style asides.'
];
const DEFAULT_VOICE_PROFILE = {
  displayName: '',
  identity: '',
  viewpoints: '',
  toneRules: '',
  avoid: DASH_HARD_RULES.join('\n'),
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
};

const GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';
const GEMINI_CLI_MODEL = 'flash-lite';
const GEMINI_CLI_LOCAL_MODEL = 'gemini-cli-local';
const CLAUDE_CODE_HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const CLAUDE_CODE_LOCAL_MODEL = 'claude-code-haiku-local';
const DRAFT_PHASE_QUICK = 'quick';
const DRAFT_PHASE_FULL = 'full';
const AUTO_STRATEGY_CONFIG = {
  humor: {
    label: 'Humor',
    baseTone: 'funny',
    instruction: 'Continue the joke. Build on the post\'s rhythm. Light sarcasm is allowed, but do not explain the joke or sound mean for no reason.'
  },
  deep_share: {
    label: 'Deep Share',
    baseTone: 'smart',
    instruction: 'Reply with a dialectical angle, sharper framing, or a pointed follow-up question that shows you actually engaged with the idea.'
  },
  hot_take: {
    label: 'Hot Take',
    baseTone: 'smart',
    instruction: 'Add concise nuance. Partial agreement or disagreement is good. Avoid generic praise or bland summaries.'
  },
  news: {
    label: 'News',
    baseTone: 'question',
    instruction: 'Reply with an implication, second-order effect, or pointed question. Stay concise and relevant.'
  },
  personal: {
    label: 'Personal',
    baseTone: 'supportive',
    instruction: 'Reply warmly and conversationally. Sound human, grounded, and casually interested.'
  }
};
const AUTO_STRATEGY_KEYS = Object.keys(AUTO_STRATEGY_CONFIG);
const MAX_COMPARISON_EXAMPLES = 4;
const MAX_COMPARISON_TEXT_LENGTH = 220;
const MAX_VOICE_PROFILE_FIELD_LENGTH = 1600;
const MAX_THREAD_CONTEXT_TWEETS = 3;
const MAX_THREAD_TWEET_LENGTH = 280;
const MAX_POST_TEXT_LENGTH = 560;
const MAX_DRAFT_TEXT_LENGTH = 280;
const MAX_AUTO_REPLY_POST_AGE_MS = 2 * 60 * 60 * 1000;

function truncateText(text, maxLength) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength).trimEnd()}...`;
}

function extractFirstJsonObject(text) {
  const source = typeof text === 'string' ? text : '';
  const start = source.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const char = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  return null;
}

function buildComparisonSection(comparisons) {
  if (!Array.isArray(comparisons) || comparisons.length === 0) return '';

  let section = '\n\nHere are examples of how the user edits AI-generated replies. Learn from the differences between "AI Generated" and "User Final" to match their style:\n';
  for (const entry of comparisons.slice(-MAX_COMPARISON_EXAMPLES)) {
    section += `\nOriginal post: ${truncateText(entry.originalPost, MAX_COMPARISON_TEXT_LENGTH)}\nAI Generated: ${truncateText(entry.aiGenerated, MAX_COMPARISON_TEXT_LENGTH)}\nUser Final: ${truncateText(entry.userFinal, MAX_COMPARISON_TEXT_LENGTH)}\n---`;
  }
  return section;
}

function normalizeMultilineText(text) {
  return typeof text === 'string' ? text.replace(/\r\n/g, '\n').trim() : '';
}

function splitProfileLines(text) {
  return normalizeMultilineText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => truncateText(line, MAX_VOICE_PROFILE_FIELD_LENGTH));
}

function buildProfileBlock(label, text) {
  const lines = splitProfileLines(text);
  if (lines.length === 0) return '';
  return `${label}:\n${lines.map((line) => `- ${line}`).join('\n')}`;
}

function buildVoiceGuideSection(voiceProfile = null) {
  const profile = { ...DEFAULT_VOICE_PROFILE, ...(voiceProfile || {}) };
  const customSystemPrompt = truncateText(profile.systemPrompt, MAX_VOICE_PROFILE_FIELD_LENGTH);
  const hardRulesBlock = buildProfileBlock('Hard rules', DASH_HARD_RULES.join('\n'));
  if (customSystemPrompt) {
    return [
      'Voice guide:',
      customSystemPrompt,
      customSystemPrompt.includes('Never use --.') ? '' : hardRulesBlock
    ].filter(Boolean).join('\n');
  }

  const displayName = normalizeWhitespace(profile.displayName) || 'the user';
  const blocks = [
    `Voice guide for ${displayName}:`,
    buildProfileBlock('Identity', profile.identity),
    buildProfileBlock('Viewpoints', profile.viewpoints),
    buildProfileBlock('Tone rules', profile.toneRules),
    buildProfileBlock('Writing samples', profile.writingSamples),
    hardRulesBlock
  ].filter(Boolean);

  return blocks.join('\n\n');
}

function buildSystemPrompt(tone, toneData, options = {}) {
  const prompt = toneData?.prompt || TONE_DEFAULTS[tone] || TONE_DEFAULTS.supportive;
  const comparisons = Array.isArray(toneData?.comparisons) ? toneData.comparisons : [];

  let system = `You generate X (Twitter) replies in the user's voice.\n\n${buildVoiceGuideSection(options.voiceProfile)}\n\nTone instruction:\n${prompt}\n\nRules:\n- Use line breaks generously when it helps.\n- Sound genuine and human, not polished or robotic. Imperfect is good.\n- Write something people want to reply to: a take, a question, or a reaction that invites conversation.\n- When a quoted post is provided, use it as core context before replying.\n- No hashtags unless the original post uses them.\n- Match the casualness level of the original post.`;
  system += buildComparisonSection(comparisons);
  return system;
}

function buildAdaptiveComparisonSection(comparisonSource) {
  if (!comparisonSource || typeof comparisonSource !== 'object') return '';

  let examples = '';

  if (Array.isArray(comparisonSource.comparisons)) {
    for (const sample of comparisonSource.comparisons.slice(-MAX_COMPARISON_EXAMPLES)) {
      const strategyLabel = sample.strategyType || sample.baseTone || 'auto';
      examples += `\nStrategy: ${strategyLabel}\nOriginal post: ${truncateText(sample.originalPost, MAX_COMPARISON_TEXT_LENGTH)}\nAI Generated: ${truncateText(sample.aiGenerated, MAX_COMPARISON_TEXT_LENGTH)}\nUser Final: ${truncateText(sample.userFinal, MAX_COMPARISON_TEXT_LENGTH)}\n---`;
    }
    return examples
      ? `\n\nStyle references from the user's past edits. Use them only to match voice once you choose a strategy:${examples}`
      : '';
  }

  const toneOrder = ['funny', 'smart', 'question', 'supportive'];
  for (const tone of toneOrder) {
    const comparisons = comparisonSource[tone]?.comparisons || [];
    if (comparisons.length === 0) continue;
    const sample = comparisons[comparisons.length - 1];
    examples += `\nBase tone: ${tone}\nOriginal post: ${truncateText(sample.originalPost, MAX_COMPARISON_TEXT_LENGTH)}\nAI Generated: ${truncateText(sample.aiGenerated, MAX_COMPARISON_TEXT_LENGTH)}\nUser Final: ${truncateText(sample.userFinal, MAX_COMPARISON_TEXT_LENGTH)}\n---`;
  }

  return examples
    ? `\n\nStyle references from the user's past edits. Use them only to match voice once you choose a strategy:${examples}`
    : '';
}

function buildAdaptiveSystemPrompt({
  phase = DRAFT_PHASE_QUICK,
  toneDataByTone = null,
  autoPromptData = null,
  voiceProfile = null
} = {}) {
  const quickMode = phase !== DRAFT_PHASE_FULL;
  const strategySummary = AUTO_STRATEGY_KEYS
    .map((key) => `${key}=${AUTO_STRATEGY_CONFIG[key].instruction}`)
    .join(' ');
  const phaseRule = quickMode
    ? 'Optimize for speed. Return a usable first draft, not a perfect one. Keep the reply under 220 characters. Prefer 1 short line. Never exceed 2 sentences.'
    : 'This is a quality pass. Be sharper and more polished than the quick draft. Keep the reply under 280 characters. Use the style references when they help. Still keep it compact and never exceed 2 sentences.';

  let system = [
    'Write X reply drafts.',
    buildVoiceGuideSection(voiceProfile),
    'First decide whether to skip the post. If not skipped, pick exactly one strategy type and write the reply in the same pass.',
    `Strategies: ${strategySummary}`,
    'Skip low-signal repost shells, posts that are too thin to react to, or risky/sensitive posts where an auto-reply feels wrong.',
    'When a quoted post is provided, use it as core context before deciding whether to skip.',
    'Return exactly one JSON object and nothing else.',
    '{"status":"ready|skipped","strategyType":"humor|deep_share|hot_take|news|personal|null","baseTone":"supportive|question|smart|funny|null","reply":"string","reason":"string"}',
    'If skipped: empty reply and a brief reason. If ready: choose one strategyType, set the matching baseTone, write the reply, and leave reason empty.',
    'Sound casual and human. No hashtags unless the original post uses them.',
    phaseRule
  ].join('\n');

  if (phase === DRAFT_PHASE_FULL) {
    system += buildAdaptiveComparisonSection(autoPromptData || toneDataByTone);
  }

  return system;
}

function normalizeWhitespace(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

function getQuotedTweetContext(context) {
  const text = normalizeWhitespace(context?.quotedTweet?.text || '');
  if (!text) return null;

  return {
    text,
    posterHandle: normalizeWhitespace(context?.quotedTweet?.posterHandle || '')
  };
}

function parseTimestampMs(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value !== 'string') return 0;

  const trimmed = value.trim();
  if (!trimmed) return 0;

  const timestamp = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function detectPostAgeSkipReason(context) {
  const createdAt = parseTimestampMs(context?.createdAt ?? context?.createdAtMs ?? context?.postCreatedAt);
  if (!createdAt) return '';
  if (Date.now() - createdAt <= MAX_AUTO_REPLY_POST_AGE_MS) return '';
  return 'Post is older than 2 hours; auto-reply skipped.';
}

function buildUserMessage(tweetText, context) {
  let msg = '';
  const threadTweets = Array.isArray(context?.threadTweets)
    ? context.threadTweets.map((tweet) => truncateText(tweet, MAX_THREAD_TWEET_LENGTH)).filter(Boolean)
    : [];
  const quotedTweet = getQuotedTweetContext(context);

  if (threadTweets.length > 1) {
    msg += 'Thread context (earlier tweets in conversation):\n';
    threadTweets.slice(-(MAX_THREAD_CONTEXT_TWEETS + 1), -1).forEach((tweet, index) => {
      msg += `[${index + 1}] ${tweet}\n`;
    });
    msg += '\n';
  }

  if (quotedTweet) {
    const quotedPoster = quotedTweet.posterHandle ? ` by ${quotedTweet.posterHandle}` : '';
    msg += `Quoted post${quotedPoster}:\n\n${truncateText(quotedTweet.text, MAX_POST_TEXT_LENGTH)}\n\n`;
  }

  const poster = context?.posterHandle ? ` by ${context.posterHandle}` : '';
  msg += `Reply to this post${poster}:\n\n${truncateText(tweetText, MAX_POST_TEXT_LENGTH)}`;
  return msg;
}

function buildReplyPrompt(tweetText, tone, toneData, context, options = {}) {
  return {
    systemPrompt: buildSystemPrompt(tone, toneData, options),
    userMessage: buildUserMessage(tweetText, context)
  };
}

function buildAdaptiveDraftPrompt({
  tweetText,
  context,
  phase = DRAFT_PHASE_QUICK,
  toneDataByTone = null,
  autoPromptData = null,
  voiceProfile = null
} = {}) {
  return {
    systemPrompt: buildAdaptiveSystemPrompt({ phase, toneDataByTone, autoPromptData, voiceProfile }),
    userMessage: buildUserMessage(tweetText, context)
  };
}

function buildEnhanceUserMessage(tweetText, context, draftText) {
  return [
    buildUserMessage(tweetText, context),
    '',
    'Current draft to improve:',
    truncateText(draftText, MAX_DRAFT_TEXT_LENGTH)
  ].join('\n');
}

function buildManualDraftPrompt({
  tweetText,
  tone,
  toneData,
  context,
  currentDraft = '',
  baseToneHint = 'smart',
  voiceProfile = null
} = {}) {
  if (tone === 'enhance') {
    const systemPrompt = buildSystemPrompt('enhance', toneData, { voiceProfile });
    return {
      systemPrompt,
      userMessage: buildEnhanceUserMessage(tweetText, context, currentDraft),
      baseTone: baseToneHint || 'smart'
    };
  }

  const { systemPrompt, userMessage } = buildReplyPrompt(tweetText, tone, toneData, context, { voiceProfile });
  return {
    systemPrompt,
    userMessage,
    baseTone: tone
  };
}

function normalizeStrategyType(strategyType) {
  return typeof strategyType === 'string' && AUTO_STRATEGY_CONFIG[strategyType]
    ? strategyType
    : null;
}

function getBaseToneForStrategy(strategyType) {
  return AUTO_STRATEGY_CONFIG[strategyType]?.baseTone || null;
}

function guessStrategyForTone(tone, fallback = 'personal') {
  switch (tone) {
    case 'funny':
      return 'humor';
    case 'question':
      return 'news';
    case 'smart':
      return 'deep_share';
    case 'supportive':
      return 'personal';
    case 'enhance':
      return AUTO_STRATEGY_CONFIG[fallback] ? fallback : 'deep_share';
    default:
      return 'personal';
  }
}

function normalizeAdaptiveDraftResult(payload) {
  const status = payload?.status === 'skipped' ? 'skipped' : payload?.status === 'ready' ? 'ready' : null;
  if (!status) {
    throw new Error('Model returned invalid draft status');
  }

  if (status === 'skipped') {
    return {
      status: 'skipped',
      strategyType: null,
      baseTone: null,
      text: '',
      reason: normalizeWhitespace(payload?.reason) || 'Skipped by model'
    };
  }

  const strategyType = normalizeStrategyType(payload?.strategyType);
  if (!strategyType) {
    throw new Error('Model returned invalid strategy type');
  }

  const baseTone = payload?.baseTone === getBaseToneForStrategy(strategyType)
    ? payload.baseTone
    : getBaseToneForStrategy(strategyType);
  const reply = typeof payload?.reply === 'string' ? payload.reply.trim() : '';

  if (!reply) {
    throw new Error('Model returned an empty draft');
  }

  return {
    status: 'ready',
    strategyType,
    baseTone,
    text: reply,
    reason: ''
  };
}

function parseAdaptiveDraftResult(rawText) {
  const jsonText = extractFirstJsonObject(rawText);
  if (!jsonText) {
    throw new Error('Model returned invalid draft JSON');
  }

  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    throw new Error('Model returned invalid draft JSON');
  }

  return normalizeAdaptiveDraftResult(payload);
}

function detectAutoDraftSkipReason(tweetText, context = null) {
  const ageReason = detectPostAgeSkipReason(context);
  if (ageReason) return ageReason;

  const text = normalizeWhitespace(tweetText);
  const quotedText = getQuotedTweetContext(context)?.text || '';
  const combinedText = [text, quotedText].filter(Boolean).join(' ').trim();
  if (!combinedText) return 'Post has no usable text.';

  const linkless = combinedText.replace(/https?:\/\/\S+/gi, '').trim();
  const alnum = linkless.replace(/[^\p{L}\p{N}]+/gu, '');
  if (alnum.length < 12) return 'Post is too low-signal for an auto-reply.';

  if (/^(rt\s+@|repost\b|quote tweet\b)/i.test(text) && !quotedText) {
    return 'Repost shell without enough original content.';
  }

  if (/^(https?:\/\/\S+\s*)+$/i.test(text) && !quotedText) {
    return 'Post is mostly links without enough context.';
  }

  if (/(rip|rest in peace|passed away|condolences|earthquake|shooting|bombing|massacre|victims?|obituary|memorial)/i.test(combinedText)) {
    return 'Sensitive post skipped by rule.';
  }

  return '';
}

async function callClaudeResult(apiKey, systemPrompt, userMessage) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });
  if (!res.ok) throw new Error(`Claude API error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const text = data.content.filter((block) => block.type === 'text').map((block) => block.text).join('').trim();
  return {
    text,
    tokenUsage: extractAnthropicTokenUsage(data) || createEstimatedTokenUsage({
      systemPrompt,
      userPrompt: userMessage,
      outputText: text
    })
  };
}

async function callClaude(apiKey, systemPrompt, userMessage) {
  return (await callClaudeResult(apiKey, systemPrompt, userMessage)).text;
}

async function callKimiResult(apiKey, systemPrompt, userMessage, endpoint) {
  const baseUrl = endpoint || 'https://api.moonshot.cn/v1';
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'kimi-k2.5',
      max_tokens: 300,
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    })
  });
  if (!res.ok) throw new Error(`Kimi API error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const text = data.choices[0].message.content.trim();
  return {
    text,
    tokenUsage: extractOpenAiTokenUsage(data, 'kimi') || createEstimatedTokenUsage({
      systemPrompt,
      userPrompt: userMessage,
      outputText: text
    })
  };
}

async function callKimi(apiKey, systemPrompt, userMessage, endpoint) {
  return (await callKimiResult(apiKey, systemPrompt, userMessage, endpoint)).text;
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((part) => typeof part.text === 'string').map((part) => part.text).join('').trim();

  if (text) return text;

  const blockReason = data?.promptFeedback?.blockReason;
  if (blockReason) throw new Error(`Gemini blocked the request: ${blockReason}`);

  throw new Error('Gemini returned no text response');
}

async function callGeminiResult(apiKey, systemPrompt, userMessage) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: userMessage }]
        }
      ],
      tools: [
        {
          google_search: {}
        }
      ],
      generationConfig: {
        maxOutputTokens: 300
      }
    })
  });

  if (!res.ok) throw new Error(`Gemini API error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const text = extractGeminiText(data).trim();
  return {
    text,
    tokenUsage: extractGeminiTokenUsage(data) || createEstimatedTokenUsage({
      systemPrompt,
      userPrompt: userMessage,
      outputText: text
    })
  };
}

async function callGemini(apiKey, systemPrompt, userMessage) {
  return (await callGeminiResult(apiKey, systemPrompt, userMessage)).text;
}

async function generateReply(tweetText, tone, toneData, settings, context) {
  const { systemPrompt, userMessage } = buildReplyPrompt(tweetText, tone, toneData, context, {
    voiceProfile: settings.voiceProfile
  });

  if (settings.activeModel === GEMINI_MODEL) {
    if (!settings.geminiApiKey) throw new Error('Gemini API key not set');
    return callGemini(settings.geminiApiKey, systemPrompt, userMessage);
  }

  if (settings.activeModel === 'kimi-k2.5') {
    if (!settings.moonshotApiKey) throw new Error('Moonshot API key not set');
    return callKimi(settings.moonshotApiKey, systemPrompt, userMessage, settings.moonshotEndpoint);
  }

  if (settings.activeModel === 'claude-haiku') {
    if (!settings.anthropicApiKey) throw new Error('Anthropic API key not set');
    return callClaude(settings.anthropicApiKey, systemPrompt, userMessage);
  }

  throw new Error(`Unsupported active model: ${settings.activeModel}`);
}

export {
  AUTO_STRATEGY_CONFIG,
  AUTO_STRATEGY_KEYS,
  CLAUDE_CODE_HAIKU_MODEL,
  CLAUDE_CODE_LOCAL_MODEL,
  DEFAULT_VOICE_PROFILE,
  buildVoiceGuideSection,
  callClaude,
  callGemini,
  callKimi,
  DRAFT_PHASE_FULL,
  DRAFT_PHASE_QUICK,
  GEMINI_CLI_MODEL,
  GEMINI_CLI_LOCAL_MODEL,
  GEMINI_MODEL,
  TONE_DEFAULTS,
  buildAdaptiveDraftPrompt,
  buildManualDraftPrompt,
  buildReplyPrompt,
  buildSystemPrompt,
  buildUserMessage,
  detectAutoDraftSkipReason,
  extractFirstJsonObject,
  generateReply,
  getBaseToneForStrategy,
  guessStrategyForTone,
  normalizeAdaptiveDraftResult,
  parseAdaptiveDraftResult,
  callClaudeResult,
  callGeminiResult,
  callKimiResult
};
