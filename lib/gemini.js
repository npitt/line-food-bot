const fetch = require('node-fetch');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL_DEFAULT = 'openrouter/aurora-alpha';
const OPENROUTER_MODEL_FALLBACKS_DEFAULT = ['meta-llama/llama-3.2-3b-instruct:free'];

function getOpenRouterModels() {
  const preferredModel = (process.env.OPENROUTER_MODEL || OPENROUTER_MODEL_DEFAULT).trim();
  const fallbackModels = (process.env.OPENROUTER_MODEL_FALLBACKS || OPENROUTER_MODEL_FALLBACKS_DEFAULT.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([preferredModel, ...fallbackModels])];
}

async function callOpenRouter(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const models = getOpenRouterModels();
  let lastError = null;

  for (const model of models) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.OPENROUTER_REFERRER || 'https://github.com/line-food-bot',
        },
        body: JSON.stringify({
          model,
          messages: [
            ...(process.env.GEM_SYSTEM_INSTRUCTION ? [{ role: 'system', content: process.env.GEM_SYSTEM_INSTRUCTION }] : []),
            { role: 'user', content: prompt }
          ],
          max_tokens: 1024,
          temperature: 0.7,
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        lastError = `model=${model}, status=${res.status}, error=${errText.slice(0, 200)}`;
        console.warn(`OpenRouter model failed: ${model} (${res.status})`);
        continue;
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim()) {
        return content.trim();
      }

      lastError = `model=${model}, status=200, error=empty content`;
      console.warn(`OpenRouter model returned empty content: ${model}`);
    } catch (err) {
      lastError = `model=${model}, error=${err.message}`;
      console.warn(`OpenRouter model error: ${model}`, err.message);
    }
  }

  throw new Error(`OpenRouter all models failed: ${lastError || 'unknown error'}`);
}

/**
 * 處理並回傳單純對話
 * 優先使用 Gemini；失敗時改用 OpenRouter
 */
async function generateChatReply(userMessage) {
  if (!userMessage || !userMessage.trim()) return '沒有收到訊息。';

  const prompt = userMessage.trim();

  // 1. 優先使用 Gemini
  if (process.env.GEMINI_API_KEY) {
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const modelOptions = { model: 'gemini-2.5-flash' };
      if (process.env.GEM_SYSTEM_INSTRUCTION) {
        modelOptions.systemInstruction = process.env.GEM_SYSTEM_INSTRUCTION;
      }
      const model = genAI.getGenerativeModel(modelOptions);
      const result = await model.generateContent(prompt);
      const text = (result.response?.text() || '').trim();
      if (text) return text;
    } catch (err) {
      console.warn('Gemini chat error:', err.message);
    }
  }

  // 2. 如果 Gemini 失敗或是沒有設定 API Key，嘗試使用 OpenRouter
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const text = await callOpenRouter(prompt);
      if (text) return text;
    } catch (err) {
      console.warn('OpenRouter chat error:', err.message);
    }
  }

  return '目前 AI 模型發生錯誤，請稍後再試。';
}

module.exports = {
  generateChatReply,
};
