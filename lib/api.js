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
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  const messages = [{ role: 'user', content: `Reply to this post:\n\n${tweetText}` }];
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];

  for (let i = 0; i < 3; i++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-3-5-haiku-20241022', max_tokens: 300, system: systemPrompt, messages, tools })
    });
    if (!res.ok) throw new Error(`Claude API error (${res.status}): ${await res.text()}`);

    const data = await res.json();
    if (data.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: data.content });
      messages.push({ role: 'user', content: 'Continue.' });
      continue;
    }
    return data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }

  throw new Error('Claude web search exceeded max iterations');
}

async function callKimi(apiKey, systemPrompt, tweetText, endpoint) {
  const baseUrl = endpoint || 'https://api.moonshot.cn/v1';
  const url = `${baseUrl}/chat/completions`;
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
  const tools = [{ type: 'builtin_function', function: { name: '$web_search' } }];
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Reply to this post:\n\n${tweetText}` }
  ];

  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'kimi-k2.5', max_tokens: 300, thinking: { type: 'disabled' }, messages, tools })
    });
    if (!res.ok) throw new Error(`Kimi API error (${res.status}): ${await res.text()}`);

    const choice = (await res.json()).choices[0];
    if (choice.finish_reason !== 'tool_calls') return choice.message.content;

    messages.push(choice.message);
    for (const tc of choice.message.tool_calls) {
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: tc.function.arguments });
    }
  }

  throw new Error('Kimi web search exceeded max iterations');
}

async function generateReply(tweetText, tone, toneData, settings) {
  const systemPrompt = buildSystemPrompt(tone, toneData);

  if (settings.activeModel === 'kimi-k2.5') {
    if (!settings.moonshotApiKey) throw new Error('Moonshot API key not set');
    return callKimi(settings.moonshotApiKey, systemPrompt, tweetText, settings.moonshotEndpoint);
  }

  if (!settings.anthropicApiKey) throw new Error('Anthropic API key not set');
  return callClaude(settings.anthropicApiKey, systemPrompt, tweetText);
}

export { generateReply, TONE_DEFAULTS, buildSystemPrompt };
