const fetch = require('node-fetch');
const { GoogleGenerativeAI } = require('@google/generative-ai');

let botConfig = {};
try {
  botConfig = require('../gemini.config.json');
} catch (e) {
  console.log('找不到 gemini.config.json，將只依賴環境變數。');
}

// 優先讀取環境變數，若無則讀取 gemini.config.json 中的設定並轉為字串
const systemInstructionRaw = process.env.GEM_SYSTEM_INSTRUCTION ||
  (botConfig.systemInstruction ? JSON.stringify(botConfig.systemInstruction) : '');

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

async function callOpenRouter(prompt, imageBase64) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const models = getOpenRouterModels();
  let lastError = null;

  for (const model of models) {
    try {
      // 根據有沒有圖片來決定 message 結構 (OpenRouter 的 Vision 格式)
      let userContent = prompt;
      if (imageBase64) {
        userContent = [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
        ];
      }

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
            ...(systemInstructionRaw ? [{ role: 'system', content: systemInstructionRaw }] : []),
            { role: 'user', content: userContent }
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
async function generateChatReply(userMessage, imageBase64 = null) {
  if (!userMessage || !userMessage.trim()) return '沒有收到訊息。';

  // 取得現在時間並格式化為本地時間字串
  const now = new Date();
  const timeString = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
  const dayOfWeek = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];

  // 將時間資訊偷偷塞進 Prompt 前面，讓 AI 擁有時間感知能力
  const promptText = `[系統提示] 目前現實時間為：${timeString} (星期${dayOfWeek})。請根據此時間回答。\n\n用戶訊息：\n${userMessage.trim()}`;

  // 1. 優先使用 Gemini
  if (process.env.GEMINI_API_KEY) {
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const modelOptions = { model: 'gemini-2.5-flash' };
      if (systemInstructionRaw) {
        modelOptions.systemInstruction = systemInstructionRaw;
      }
      const model = genAI.getGenerativeModel(modelOptions);

      let generateArgs = [promptText];
      if (imageBase64) {
        // 將圖片加入 Gemini 支援的 multipart 格式
        generateArgs.push({
          inlineData: {
            data: imageBase64,
            mimeType: 'image/jpeg'
          }
        });
      }

      const result = await model.generateContent(generateArgs);
      const text = (result.response?.text() || '').trim();
      if (text) return text;
    } catch (err) {
      console.warn('Gemini chat error:', err.message);
    }
  }

  // 2. 如果 Gemini 失敗或是沒有設定 API Key，嘗試使用 OpenRouter
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const text = await callOpenRouter(promptText, imageBase64);
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
