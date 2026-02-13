/**
 * 使用 Google AI Studio（Gemini）當作中介：解析使用者意圖與參數，再由呼叫端依意圖查詢
 * 需設定 GEMINI_API_KEY（從 https://aistudio.google.com/app/apikey 取得）
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');

const VALID_CUISINES = ['中式', '日式', '韓式', '西式', '泰式', '咖啡甜點', '素食', '不限'];

const INTENT_PROMPT = `你是美食推薦機器人的「意圖解析器」。機器人會出現在「群組」與「一對一」，請依語意判斷意圖。

**重要（群組／新查詢）：**
- 「換一個」「改查XXX」「我要查YYY」「重新查」「換地點」→ 一律當成**新查詢**，意圖填 **set_location**，location 填新地點（例如改查市政府就填「市政府」）。
- 使用者可能**一次說完需求**：例如「信義區日式 幫我找」「台大韓式 推薦」→ 意圖填 **set_location**，擷取 location 與 cuisine，並將 **search_now** 填 true（表示設定完立刻搜尋，不要只顯示篩選按鈕）。

**意圖 (intent) 只能填以下其中一個：**
- **search**：使用者「只要結果」，用「目前已有」的地點與偏好去搜尋（例如：給我資料、好了可以了、直接推薦）。沒有給新地點。
- **set_location**：使用者「給出新地點」或「換／改查某地」或「一次說地點+料理（+要結果）」。（若同時說要結果則 search_now 填 true）
- **set_preference**：使用者只想「改偏好」、沒有給新地點（例如：改韓式、換日式）。
- **help**：說明、怎麼用（說明、help、？、怎麼用）。
- **unknown**：無法判斷或與美食推薦無關。

**料理類型 (cuisine)** 只可從：中式、日式、韓式、西式、泰式、咖啡甜點、素食、不限。無法判斷填「不限」。

**search_now**：僅在 intent 為 set_location 時有意義。若使用者一句話裡同時「給地點（+料理）」且「要馬上搜尋」（幫我找、推薦、給我結果），填 true；否則填 false。

只回傳一行 JSON，不要 markdown、不要其他說明。
格式：{"intent":"search|set_location|set_preference|help|unknown", "location":"...", "cuisine":"...", "search_now": true或false}`;

/**
 * 解析使用者意圖（由 Gemini 當中介），回傳 { intent, location, cuisine, search_now }
 * @param {string} userMessage - 使用者輸入
 * @param {{ hasLocation: boolean, currentCuisine?: string }} currentState - 目前是否已有地點、當前料理
 * @returns {Promise<{ intent: string, location: string|null, cuisine: string|null, search_now: boolean }>}
 */
async function parseIntent(userMessage, currentState = {}) {
  const fallback = { intent: 'unknown', location: null, cuisine: null, search_now: false };
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !userMessage || !userMessage.trim()) {
    return fallback;
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const stateDesc = `目前狀態：已設定地點=${currentState.hasLocation ? '是' : '否'}，當前料理=${currentState.currentCuisine || '不限'}`;
    const prompt = `${INTENT_PROMPT}\n\n${stateDesc}\n\n使用者訊息：${userMessage.trim()}`;
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = (response.text() || '').trim();
    if (!text) return fallback;

    const jsonStr = text.replace(/```json?\s*|\s*```/g, '').trim();
    const parsed = JSON.parse(jsonStr);
    const intent = ['search', 'set_location', 'set_preference', 'help', 'unknown'].includes(parsed.intent)
      ? parsed.intent
      : 'unknown';
    const location = typeof parsed.location === 'string' ? parsed.location.trim() || null : null;
    let cuisine = typeof parsed.cuisine === 'string' ? parsed.cuisine.trim() : null;
    if (!VALID_CUISINES.includes(cuisine)) cuisine = '不限';
    const search_now = intent === 'set_location' && parsed.search_now === true;

    return { intent, location, cuisine, search_now };
  } catch (err) {
    console.warn('Gemini parseIntent error:', err.message);
    return fallback;
  }
}

/**
 * 僅解析「地點 + 料理」（舊版相容，或未用 parseIntent 時）
 * 若未設定 GEMINI_API_KEY 或呼叫失敗，回傳 { location: null, cuisine: null }
 */
async function parseUserIntent(userMessage) {
  const r = await parseIntent(userMessage, { hasLocation: false });
  return {
    location: r.intent === 'set_location' ? r.location : null,
    cuisine: r.cuisine,
  };
}

module.exports = { parseIntent, parseUserIntent };
