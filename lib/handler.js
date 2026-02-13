/**
 * LINE 訊息與 Postback 處理
 */
const line = require('@line/bot-sdk');
const { parseIntent } = require('./gemini');

const PREF_CUISINE = ['中式', '日式', '韓式', '西式', '泰式', '咖啡甜點', '素食', '不限'];
const PREF_PRICE = ['便宜', '中等', '高價', '不限'];
const PREF_RATING = ['3.5', '4.0', '4.5', '不限'];

function getLineErrorDetail(err) {
  return (
    err?.originalError?.response?.data?.message ||
    err?.originalError?.response?.data?.details?.[0]?.message ||
    err?.message ||
    ''
  );
}

function isReplyTokenError(err) {
  const detail = getLineErrorDetail(err);
  const raw = JSON.stringify(err?.originalError?.response?.data || '');
  return /reply token|invalid reply token|expired/i.test(`${detail} ${raw}`);
}

async function replyWithFallback(event, client, message) {
  try {
    return await client.replyMessage(event.replyToken, message);
  } catch (err) {
    if (isReplyTokenError(err) && event?.source?.userId) {
      console.warn('replyMessage failed with reply token issue, fallback to pushMessage');
      return client.pushMessage(event.source.userId, message);
    }
    throw err;
  }
}

/** 使用者暫存：地點、偏好（實際部署可改用 Redis 或 DB） */
const userState = new Map();

function getUserState(userId) {
  if (!userState.has(userId)) {
    userState.set(userId, { location: null, cuisine: '不限', price: '不限', minRating: null });
  }
  return userState.get(userId);
}

/** 產生 Google Maps 導航連結（點開可導航） */
function getMapsNavUrl(place) {
  const lat = place.lat;
  const lng = place.lng;
  const name = encodeURIComponent(place.name || '');
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

/** 單一餐廳的 Flex 氣泡（含名稱、評價、導航按鈕） */
function restaurantBubble(place, index) {
  const mapsUrl = getMapsNavUrl(place);
  const ratingText = place.rating != null ? `⭐ ${place.rating} (${place.user_ratings_total || 0} 則評論)` : '評分：－（免費地圖資料）';
  return {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: place.name, weight: 'bold', size: 'md', wrap: true },
        { type: 'text', text: place.vicinity || '', size: 'sm', color: '#666666', wrap: true, margin: 'sm' },
        { type: 'text', text: ratingText, size: 'sm', margin: 'sm' },
        {
          type: 'box',
          layout: 'vertical',
          margin: 'md',
          contents: [
            {
              type: 'button',
              action: { type: 'uri', label: '在地圖開啟／導航', uri: mapsUrl },
              style: 'primary',
              height: 'sm',
            },
          ],
        },
      ],
    },
  };
}

/** 回傳「推薦結果」Flex Carousel */
function replyRestaurants(reply, list, locationLabel) {
  if (!list.length) {
    return reply({
      type: 'text',
      text: `在「${locationLabel}」附近沒有符合條件的餐廳，試試放寬喜好或換個地點。`,
    });
  }
  const bubbles = list.map((p, i) => restaurantBubble(p, i));
  return reply({
    type: 'flex',
    altText: `為你找到 ${list.length} 間附近餐廳`,
    contents: { type: 'carousel', contents: bubbles },
  });
}

/** 搜尋附近餐廳並回覆；失敗時回傳錯誤訊息給使用者（如逾時、連線失敗） */
async function searchAndReply(reply, location, state, api) {
  try {
    const list = await api.searchNearbyRestaurants(location, {
      cuisine: state.cuisine,
      price: state.price,
      minRating: state.minRating,
    });
    return replyRestaurants(reply, list, state.locationLabel || '該地點');
  } catch (err) {
    return reply({
      type: 'text',
      text: err.message || '查詢附近餐廳失敗，請稍後再試。',
    });
  }
}

/** 回傳「請選擇喜好」的 QuickReply + Postback */
function replyPreferenceQuickReply(reply, userId) {
  const state = getUserState(userId);
  return reply({
    type: 'text',
    text: `已記錄地點。請選擇喜好篩選（可略過）：\n・料理：${state.cuisine}\n・價位：${state.price}\n・最低評分：${state.minRating || '不限'}`,
    quickReply: {
      items: [
        {
          type: 'action',
          action: { type: 'postback', label: '🔹 料理類型', data: 'action=cuisine' },
        },
        {
          type: 'action',
          action: { type: 'postback', label: '🔹 價位', data: 'action=price' },
        },
        {
          type: 'action',
          action: { type: 'postback', label: '🔹 最低評分', data: 'action=rating' },
        },
        {
          type: 'action',
          action: { type: 'postback', label: '✅ 直接推薦', data: 'action=search' },
        },
      ],
    },
  });
}

/** 處理 Postback：選料理 / 價位 / 評分 / 執行搜尋 */
async function handlePostback(event, client, api) {
  const userId = event.source.userId;
  const reply = (message) => replyWithFallback(event, client, message);
  const data = event.postback.data || '';
  const state = getUserState(userId);

  const params = new URLSearchParams(data);
  const action = params.get('action');
  const value = params.get('value');

  if (action === 'cuisine' && value) {
    state.cuisine = value;
    return reply({ type: 'text', text: `已設定料理類型：${value}` });
  }
  if (action === 'price' && value) {
    state.price = value;
    return reply({ type: 'text', text: `已設定價位：${value}` });
  }
  if (action === 'rating' && value) {
    state.minRating = value === '不限' ? null : parseFloat(value);
    return reply({ type: 'text', text: `已設定最低評分：${value}` });
  }

  if (action === 'cuisine') {
    const items = PREF_CUISINE.map((c) => ({ type: 'action', action: { type: 'postback', label: c, data: `action=cuisine&value=${c}` } }));
    return reply({ type: 'text', text: '選擇料理類型', quickReply: { items } });
  }
  if (action === 'price') {
    const items = PREF_PRICE.map((p) => ({ type: 'action', action: { type: 'postback', label: p, data: `action=price&value=${p}` } }));
    return reply({ type: 'text', text: '選擇價位', quickReply: { items } });
  }
  if (action === 'rating') {
    const items = PREF_RATING.map((r) => ({ type: 'action', action: { type: 'postback', label: r === '不限' ? '不限' : `${r} 星以上`, data: `action=rating&value=${r}` } }));
    return reply({ type: 'text', text: '選擇最低評分', quickReply: { items } });
  }

  if (action === 'search') {
    if (!state.location) {
      return reply({ type: 'text', text: '請先傳送一個地點（地址或名稱），例如：台北車站' });
    }
    return searchAndReply(reply, state.location, state, api);
  }

  return Promise.resolve(null);
}

/** 處理文字訊息：地點名稱 / 指令 */
async function handleMessage(event, client, api) {
  const userId = event.source.userId;
  const reply = (message) => replyWithFallback(event, client, message);
  const text = (event.message.text || '').trim();
  const state = getUserState(userId);

  if (event.message.type === 'location') {
    state.location = { lat: event.message.latitude, lng: event.message.longitude };
    state.locationLabel = `經緯度 ${event.message.latitude.toFixed(4)}, ${event.message.longitude.toFixed(4)}`;
    return replyPreferenceQuickReply(reply, userId);
  }

  if (!text) return Promise.resolve(null);

  const helpText = '🍽 使用方式：\n\n1. 傳送「地點名稱或地址」，例如：台北車站、信義威秀\n2. 或傳送你的「位置」（LINE 的定位）\n3. 選擇喜好：料理類型等（可略過）\n4. 說「給我資料」「直接推薦」或點按鈕取得附近餐廳\n\n使用免費地圖資料，點「在地圖開啟／導航」可用 Google 地圖導航。若有設定 Gemini API，可用自然語描述地點與料理類型。';

  // 由 Gemini 解析意圖（中介），再依意圖執行
  const parsed = await parseIntent(text, {
    hasLocation: !!state.location,
    currentCuisine: state.cuisine,
  });

  if (parsed.intent === 'help') {
    return reply({ type: 'text', text: helpText });
  }

  if (parsed.intent === 'search') {
    if (!state.location) {
      return reply({ type: 'text', text: '請先傳送一個地點（地址或名稱），例如：台北車站' });
    }
    return searchAndReply(reply, state.location, state, api);
  }

  if (parsed.intent === 'set_preference') {
    if (parsed.cuisine) state.cuisine = parsed.cuisine;
    if (!state.location) {
      return reply({ type: 'text', text: '請先傳送一個地點，再設定偏好。例如：台北車站' });
    }
    return replyPreferenceQuickReply(reply, userId);
  }

  if (parsed.intent === 'set_location') {
    if (!parsed.location) {
      return reply({ type: 'text', text: '請說出一個具體地點（例如：台北車站、信義區），我才能幫你找附近的餐廳。' });
    }
    if (parsed.cuisine) state.cuisine = parsed.cuisine;
    const geo = await api.geocodeAddress(parsed.location);
    if (!geo) {
      return reply({ type: 'text', text: '找不到這個地點，請換個關鍵字或傳送定位。' });
    }
    state.location = { lat: geo.lat, lng: geo.lng };
    state.locationLabel = geo.formatted || parsed.location;
    if (parsed.search_now) {
      return searchAndReply(reply, state.location, state, api);
    }
    return replyPreferenceQuickReply(reply, userId);
  }

  // unknown：當成地點嘗試 geocode（相容無 Gemini 或解析失敗）
  const geo = await api.geocodeAddress(text);
  if (!geo) {
    return reply({ type: 'text', text: '找不到這個地點，請換個關鍵字或傳送定位。也可以說「說明」看使用方式。' });
  }
  state.location = { lat: geo.lat, lng: geo.lng };
  state.locationLabel = geo.formatted || text;
  return replyPreferenceQuickReply(reply, userId);
}

module.exports = { handleMessage, handlePostback };
