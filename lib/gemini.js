/**
 * 使用 Google AI Studio（Gemini）解析使用者訊息，擷取「地點」與「料理類型」
 * 需設定 GEMINI_API_KEY（從 https://aistudio.google.com/app/apikey 取得）
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');

const VALID_CUISINES = ['中式', '日式', '韓式', '西式', '泰式', '咖啡甜點', '素食', '不限'];

const SYSTEM_PROMPT = `你是美食推薦機器人的解析器。從使用者訊息中擷取：
1. **地點**：可被地理編碼的具體地名或地址（例如：台北車站、信義區、中山北路二段、市政府站）。若使用者只說「附近」「這附近」「這裡」而沒有具體地名，地點填空字串。
2. **料理類型**：只可從以下選一個：中式、日式、韓式、西式、泰式、咖啡甜點、素食、不限。若無法判斷則填「不限」。

只回傳一行 JSON，不要 markdown、不要其他說明。格式：{"location":"...", "cuisine":"..."}`;

/**
 * 解析使用者訊息，回傳 { location, cuisine }
 * 若未設定 GEMINI_API_KEY 或呼叫失敗，回傳 { location: null, cuisine: null }，呼叫端應改用原始訊息當地點。
 */
async function parseUserIntent(userMessage) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !userMessage || !userMessage.trim()) {
    return { location: null, cuisine: null };
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = `${SYSTEM_PROMPT}\n\n使用者訊息：${userMessage.trim()}`;
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = (response.text() || '').trim();
    if (!text) return { location: null, cuisine: null };

    const jsonStr = text.replace(/```json?\s*|\s*```/g, '').trim();
    const parsed = JSON.parse(jsonStr);
    const location = typeof parsed.location === 'string' ? parsed.location.trim() : null;
    let cuisine = typeof parsed.cuisine === 'string' ? parsed.cuisine.trim() : null;
    if (!VALID_CUISINES.includes(cuisine)) cuisine = '不限';

    return { location: location || null, cuisine };
  } catch (err) {
    console.warn('Gemini parseUserIntent error:', err.message);
    return { location: null, cuisine: null };
  }
}

module.exports = { parseUserIntent };
