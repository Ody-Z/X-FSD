const TONE_DEFAULTS = {
  supportive: 'Write a warm, encouraging reply that shows genuine interest. Keep it concise and authentic.',
  question: 'Ask a thoughtful, engaging follow-up question about the topic. Be genuinely curious.',
  smart: 'Write an insightful reply that adds value or a fresh perspective. Be concise and sharp.',
  enhance: 'Rewrite/improve the draft reply to sound more polished, engaging, and natural.',
  funny: 'Write a witty, humorous reply that is light-hearted. Avoid being offensive or try-hard.'
};

function buildSystemPrompt(tone, toneData) {
  const prompt = toneData?.prompt || TONE_DEFAULTS[tone] || TONE_DEFAULTS.supportive;
  const comparisons = toneData?.comparisons || [];

  let system = `You generate short X (Twitter) replies. Follow this instruction for tone:\n\n${prompt}\n\nRules:\n- Keep replies under 280 characters\n- Sound human and natural, never robotic\n- No hashtags unless the original post uses them\n- Match the casualness level of the original post`;

  if (comparisons.length > 0) {
    system += '\n\nHere are examples of how the user edits AI-generated replies. Learn from the differences between "AI Generated" and "User Final" to match their style:\n';
    for (const c of comparisons.slice(-10)) {
      system += `\nOriginal post: ${c.originalPost}\nAI Generated: ${c.aiGenerated}\nUser Final: ${c.userFinal}\n---`;
    }
  }

  return system;
}

async function callClaude(apiKey, systemPrompt, tweetText) {
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
      messages: [{ role: 'user', content: `Reply to this post:\n\n${tweetText}` }]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error (${res.status}): ${err}`);
  }

  const data = await res.json();
  return data.content[0].text;
}

async function callKimi(apiKey, systemPrompt, tweetText) {
  const res = await fetch('https://api.moonshot.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'kimi-k2.5',
      max_tokens: 300,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Reply to this post:\n\n${tweetText}` }
      ]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Kimi API error (${res.status}): ${err}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

async function generateReply(tweetText, tone, toneData, settings) {
  const systemPrompt = buildSystemPrompt(tone, toneData);

  if (settings.activeModel === 'kimi-k2.5') {
    if (!settings.moonshotApiKey) throw new Error('Moonshot API key not set');
    return callKimi(settings.moonshotApiKey, systemPrompt, tweetText);
  }

  if (!settings.anthropicApiKey) throw new Error('Anthropic API key not set');
  return callClaude(settings.anthropicApiKey, systemPrompt, tweetText);
}

export { generateReply, TONE_DEFAULTS, buildSystemPrompt };
