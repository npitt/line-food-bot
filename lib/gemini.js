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

// 使用內建的 Map 當作輕量級 In-Memory 對話歷史快取
const chatHistoryCache = new Map();
const MAX_HISTORY_LENGTH = 6; // 記憶最近的 6 句話 (包含一問一答)
const HISTORY_TTL_MS = 30 * 60 * 1000; // 快取存活時間：30分鐘

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
async function generateChatReply(userMessage, imageBase64 = null, userId = null, userName = '跑友') {
  if (!userMessage || !userMessage.trim()) return '沒有收到訊息。';

  // 取得現在時間並格式化為本地時間字串
  const now = new Date();
  const timeString = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
  const dayOfWeek = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];

  // 將時間資訊與使用者名稱偷偷塞進 Prompt 前面，讓 AI 擁有時間與人物感知能力
  let promptText = `[系統提示] 目前現實時間為：${timeString} (星期${dayOfWeek})。正在跟你對話的用戶 LINE 暱稱叫做「${userName}」，可以試著用這個名字稱呼他/她。\n\n`;

  // 載入該用戶的歷史紀錄 (Context Memory)
  let historyContext = '';
  let userHistory = [];
  if (userId) {
    const userCache = chatHistoryCache.get(userId);
    if (userCache && (now.getTime() - userCache.lastUpdated < HISTORY_TTL_MS)) {
      userHistory = userCache.history;
      if (userHistory.length > 0) {
        historyContext = `[以下是我們先前最近的對話紀錄，供你參考]\n` +
          userHistory.map(h => `${h.role === 'user' ? '我' : '你'}: ${h.content}`).join('\n') +
          `\n[對話紀錄結束]\n\n`;
      }
    } else if (userCache) {
      // 記憶體過期，移除
      chatHistoryCache.delete(userId);
    }
  }

  promptText += historyContext + `用戶最新訊息：\n${userMessage.trim()}`;

  let finalReply = '';

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
      if (text) {
        finalReply = text;
      }
    } catch (err) {
      console.warn('Gemini chat error:', err.message);
    }
  }

  // 2. 如果 Gemini 失敗或是沒有設定 API Key，嘗試使用 OpenRouter
  if (!finalReply && process.env.OPENROUTER_API_KEY) {
    try {
      const text = await callOpenRouter(promptText, imageBase64);
      if (text) {
        finalReply = text;
      }
    } catch (err) {
      console.warn('OpenRouter chat error:', err.message);
    }
  }

  // 3. 處理完成後，若有結果且有 userId，將對話存回快取中
  if (finalReply) {
    if (userId) {
      userHistory.push({ role: 'user', content: userMessage.trim() });
      userHistory.push({ role: 'model', content: finalReply });

      // 移除太舊的記憶，避免超過上限
      if (userHistory.length > MAX_HISTORY_LENGTH) {
        userHistory = userHistory.slice(userHistory.length - MAX_HISTORY_LENGTH);
      }

      chatHistoryCache.set(userId, {
        history: userHistory,
        lastUpdated: new Date().getTime()
      });
    }
    return finalReply;
  }

  return '目前 AI 模型發生錯誤，請稍後再試。';
}

module.exports = {
  generateChatReply,
};
