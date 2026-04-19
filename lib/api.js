const TONE_DEFAULTS = {
  supportive: 'Write a warm, encouraging reply that shows genuine interest. Keep it concise and authentic.',
  question: 'Ask a thoughtful, engaging follow-up question about the topic. Be genuinely curious.',
  smart: 'Write an insightful reply that adds value or a fresh perspective. Be concise and sharp.',
  enhance: 'Rewrite/improve the draft reply to sound more polished, engaging, and natural.',
  funny: 'Write a witty, humorous reply that is light-hearted. Avoid being offensive or try-hard.'
};

const GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';
const GEMINI_CLI_LOCAL_MODEL = 'gemini-cli-local';

function buildSystemPrompt(tone, toneData) {
  const prompt = toneData?.prompt || TONE_DEFAULTS[tone] || TONE_DEFAULTS.supportive;
  const comparisons = toneData?.comparisons || [];

  let system = `You generate X (Twitter) replies that spark engagement. Follow this instruction for tone:\n\n${prompt}\n\nRules:\n- Use line breaks generously. Each sentence or thought gets its own line with a blank line after it.\n- Sound genuine and human, not polished or robotic. Imperfect is good.\n- Write something people want to reply to — a take, a question, a reaction that invites conversation.\n- No hashtags unless the original post uses them.\n- Match the casualness level of the original post.`;

  if (comparisons.length > 0) {
    system += '\n\nHere are examples of how the user edits AI-generated replies. Learn from the differences between "AI Generated" and "User Final" to match their style:\n';
    for (const c of comparisons.slice(-10)) {
      system += `\nOriginal post: ${c.originalPost}\nAI Generated: ${c.aiGenerated}\nUser Final: ${c.userFinal}\n---`;
    }
  }

  return system;
}

async function callClaude(apiKey, systemPrompt, userMessage) {
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
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

async function callKimi(apiKey, systemPrompt, userMessage, endpoint) {
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
  return (await res.json()).choices[0].message.content;
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter(part => typeof part.text === 'string').map(part => part.text).join('').trim();

  if (text) return text;

  const blockReason = data?.promptFeedback?.blockReason;
  if (blockReason) throw new Error(`Gemini blocked the request: ${blockReason}`);

  throw new Error('Gemini returned no text response');
}

function buildUserMessage(tweetText, context) {
  let msg = '';
  if (context?.threadTweets?.length > 1) {
    msg += 'Thread context (earlier tweets in conversation):\n';
    context.threadTweets.slice(0, -1).forEach((t, i) => { msg += `[${i + 1}] ${t}\n`; });
    msg += '\n';
  }
  const poster = context?.posterHandle ? ` by ${context.posterHandle}` : '';
  msg += `Reply to this post${poster}:\n\n${tweetText}`;
  return msg;
}

function buildReplyPrompt(tweetText, tone, toneData, context) {
  return {
    systemPrompt: buildSystemPrompt(tone, toneData),
    userMessage: buildUserMessage(tweetText, context)
  };
}

async function callGemini(apiKey, systemPrompt, userMessage) {
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
  return extractGeminiText(await res.json());
}

async function generateReply(tweetText, tone, toneData, settings, context) {
  const { systemPrompt, userMessage } = buildReplyPrompt(tweetText, tone, toneData, context);

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
  GEMINI_CLI_LOCAL_MODEL,
  GEMINI_MODEL,
  buildReplyPrompt,
  buildSystemPrompt,
  buildUserMessage,
  generateReply,
  TONE_DEFAULTS
};
