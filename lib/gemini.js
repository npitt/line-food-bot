const fetch = require('node-fetch');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { FLASH_LIMIT, FLASH_THRESHOLD, MAX_HISTORY_LENGTH, HISTORY_TTL_MS } = require('./constants');

let botConfig = {};
try {
  const configPath = path.resolve(__dirname, '../gemini.config.yaml');
  const fileContents = fs.readFileSync(configPath, 'utf8');
  botConfig = yaml.load(fileContents);
} catch (e) {
  console.log('找不到 gemini.config.yaml，將只依賴環境變數。');
}

// 優先讀取環境變數，若無則讀取 gemini.config.yaml 中的設定並展開成單一字串
let parsedSystemPrompt = '';
if (process.env.GEM_SYSTEM_INSTRUCTION) {
  parsedSystemPrompt = process.env.GEM_SYSTEM_INSTRUCTION;
} else if (botConfig.systemInstruction) {
  const { role, personality, capabilities } = botConfig.systemInstruction;
  let text = (role || '') + '\n';
  if (Array.isArray(personality)) text += '你的性格特質：\n- ' + personality.join('\n- ') + '\n';
  if (capabilities) {
    text += '\n你的具備能力與鐵律：\n';
    for (const [key, details] of Object.entries(capabilities)) {
      text += `能力 [${key}]: ${details.action}\n[觸發條件]: ${details.trigger}\n`;
      if (Array.isArray(details.critical_rules)) {
        text += '[絕對遵守的鐵律]:\n' + details.critical_rules.map((r, i) => `${i + 1}. ${r}`).join('\n') + '\n';
      }
    }
  }
  parsedSystemPrompt = text.trim();
}

console.log('系統人設 (System Instruction) 套用結果字串長度：', parsedSystemPrompt.length);

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL_DEFAULT = 'openrouter/aurora-alpha';
const OPENROUTER_MODEL_FALLBACKS_DEFAULT = ['meta-llama/llama-3.2-3b-instruct:free'];

// 使用內建的 Map 當作輕量級 In-Memory 對話歷史快取
const chatHistoryCache = new Map();

/**
 * API 用量追蹤器 (In-Memory)
 */
const apiUsageTracker = {
  date: '', // 當前紀錄日期 YYYY-MM-DD
  flashCount: 0 // gemini-2.5-flash 的當日使用次數
};

const FLASH_LIMIT_DISPLAY = FLASH_LIMIT; // 用於顯示

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
          { type: 'text', text: prompt }
        ];
        const images = Array.isArray(imageBase64) ? imageBase64 : [imageBase64];
        images.forEach(img => {
          userContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img}` } });
        });
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
            ...(parsedSystemPrompt ? [{ role: 'system', content: parsedSystemPrompt }] : []),
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
async function generateChatReply(userMessage, imageBase64 = null, userId = null, userName = '跑友', systemContext = '') {
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

  promptText += historyContext + `用戶最新訊息：\n${userMessage.trim()}\n`;
  if (systemContext) {
    promptText += `\n${systemContext}`;
  }

  let finalReply = '';

  // 1. 優先使用 Gemini
  if (process.env.GEMINI_API_KEY) {
    try {
      // 檢查是否需要重置每日計額 (以台北時間為準)
      const todayStr = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
      if (apiUsageTracker.date !== todayStr) {
        apiUsageTracker.date = todayStr;
        apiUsageTracker.flashCount = 0;
        console.log(`[系統通知] ${todayStr} 每日 API 用量計數重置。`);
      }

      // 決定使用的模型 (優先 2.5-flash，快到上限則改用 flash-lite)
      let selectedModel = 'gemini-2.5-flash';
      if (apiUsageTracker.flashCount >= FLASH_THRESHOLD) {
        selectedModel = 'gemini-2.5-flash-lite';
      }

      console.log(`[Gemini API 請求] 模型: ${selectedModel}, 今日 Flash 已用量: ${apiUsageTracker.flashCount}`);

      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const modelOptions = { model: selectedModel };
      if (parsedSystemPrompt) {
        modelOptions.systemInstruction = parsedSystemPrompt;
      }
      const model = genAI.getGenerativeModel(modelOptions);

      let generateArgs = [promptText];
      if (imageBase64) {
        const images = Array.isArray(imageBase64) ? imageBase64 : [imageBase64];
        images.forEach(img => {
          // 將圖片加入 Gemini 支援的 multipart 格式
          generateArgs.push({
            inlineData: {
              data: img,
              mimeType: 'image/jpeg'
            }
          });
        });
      }

      const result = await model.generateContent(generateArgs);
      const response = await result.response;
      finalReply = (response.text() || '').trim();

      // 成功後，如果是使用 flash 則增加計數
      if (selectedModel === 'gemini-2.5-flash') {
        apiUsageTracker.flashCount++;
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

/**
 * 取得當前 API 使用量狀態描述
 */
function getApiUsageStatus() {
  const todayStr = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
  // 確保日期同步
  if (apiUsageTracker.date !== todayStr) {
    apiUsageTracker.date = todayStr;
    apiUsageTracker.flashCount = 0;
  }

  const remaining = Math.max(0, FLASH_LIMIT - apiUsageTracker.flashCount);
  const currentModel = apiUsageTracker.flashCount >= FLASH_THRESHOLD ? 'gemini-2.5-flash-lite (節能降級模式)' : 'gemini-2.5-flash (標準高品質模式)';
  const statusIcon = apiUsageTracker.flashCount >= FLASH_THRESHOLD ? '⚠️' : '✅';

  return `📊 【史都華教練 API 用量報告】\n` +
    `📅 日期：${todayStr}\n` +
    `🚀 目前模型：${currentModel}\n` +
    `📈 今日 Flash 已呼叫：${apiUsageTracker.flashCount} 次\n` +
    `📉 剩餘免費高質額度：${remaining} 次\n` +
    `${statusIcon} 運作狀態：${apiUsageTracker.flashCount >= FLASH_THRESHOLD ? '已啟動自動降級保護' : '正常運作中'}`;
}

/**
 * 取得特定用戶的對話歷史紀錄內容
 */
function getUserHistory(userId) {
  if (!userId) return [];
  const cache = chatHistoryCache.get(userId);
  if (!cache) return [];
  // 檢查是否過期
  if (Date.now() - cache.lastUpdated > HISTORY_TTL_MS) {
    chatHistoryCache.delete(userId);
    return [];
  }
  return cache.history;
}

module.exports = {
  generateChatReply,
  getApiUsageStatus,
  getUserHistory
};
