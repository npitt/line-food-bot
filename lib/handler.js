/**
 * LINE 訊息與 Postback 處理
 */
const line = require('@line/bot-sdk');

const PREF_CUISINE = ['中式', '日式', '韓式', '西式', '泰式', '咖啡甜點', '素食', '不限'];
const PREF_PRICE = ['便宜', '中等', '高價', '不限'];
const PREF_RATING = ['3.5', '4.0', '4.5', '不限'];

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
  const ratingText = place.rating != null ? `⭐ ${place.rating} (${place.user_ratings_total || 0} 則評論)` : '尚無評分';
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
              action: { type: 'uri', label: '在 Google 地圖開啟／導航', uri: mapsUrl },
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
function replyRestaurants(client, replyToken, list, locationLabel) {
  if (!list.length) {
    return client.replyMessage(replyToken, {
      type: 'text',
      text: `在「${locationLabel}」附近沒有符合條件的餐廳，試試放寬喜好或換個地點。`,
    });
  }
  const bubbles = list.map((p, i) => restaurantBubble(p, i));
  return client.replyMessage(replyToken, {
    type: 'flex',
    altText: `為你找到 ${list.length} 間附近餐廳`,
    contents: { type: 'carousel', contents: bubbles },
  });
}

/** 回傳「請選擇喜好」的 QuickReply + Postback */
function replyPreferenceQuickReply(client, replyToken, userId) {
  const state = getUserState(userId);
  return client.replyMessage(replyToken, {
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
  const data = event.postback.data || '';
  const state = getUserState(userId);

  const params = new URLSearchParams(data);
  const action = params.get('action');
  const value = params.get('value');

  if (action === 'cuisine' && value) {
    state.cuisine = value;
    return client.replyMessage(event.replyToken, { type: 'text', text: `已設定料理類型：${value}` });
  }
  if (action === 'price' && value) {
    state.price = value;
    return client.replyMessage(event.replyToken, { type: 'text', text: `已設定價位：${value}` });
  }
  if (action === 'rating' && value) {
    state.minRating = value === '不限' ? null : parseFloat(value);
    return client.replyMessage(event.replyToken, { type: 'text', text: `已設定最低評分：${value}` });
  }

  if (action === 'cuisine') {
    const items = PREF_CUISINE.map((c) => ({ type: 'action', action: { type: 'postback', label: c, data: `action=cuisine&value=${c}` } }));
    return client.replyMessage(event.replyToken, { type: 'text', text: '選擇料理類型', quickReply: { items } });
  }
  if (action === 'price') {
    const items = PREF_PRICE.map((p) => ({ type: 'action', action: { type: 'postback', label: p, data: `action=price&value=${p}` } }));
    return client.replyMessage(event.replyToken, { type: 'text', text: '選擇價位', quickReply: { items } });
  }
  if (action === 'rating') {
    const items = PREF_RATING.map((r) => ({ type: 'action', action: { type: 'postback', label: r === '不限' ? '不限' : `${r} 星以上`, data: `action=rating&value=${r}` } }));
    return client.replyMessage(event.replyToken, { type: 'text', text: '選擇最低評分', quickReply: { items } });
  }

  if (action === 'search') {
    if (!state.location) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '請先傳送一個地點（地址或名稱），例如：台北車站' });
    }
    const list = await api.searchNearbyRestaurants(state.location, {
      cuisine: state.cuisine,
      price: state.price,
      minRating: state.minRating,
    });
    return replyRestaurants(client, event.replyToken, list, state.locationLabel || '該地點');
  }

  return Promise.resolve(null);
}

/** 處理文字訊息：地點名稱 / 指令 */
async function handleMessage(event, client, api) {
  const userId = event.source.userId;
  const text = (event.message.text || '').trim();
  const state = getUserState(userId);

  if (event.message.type === 'location') {
    state.location = { lat: event.message.latitude, lng: event.message.longitude };
    state.locationLabel = `經緯度 ${event.message.latitude.toFixed(4)}, ${event.message.longitude.toFixed(4)}`;
    return replyPreferenceQuickReply(client, event.replyToken, userId);
  }

  if (!text) return Promise.resolve(null);

  if (text === '推薦' || text === '搜尋' || text === '找餐廳') {
    if (!state.location) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '請先傳送一個地點（地址或名稱），例如：台北車站' });
    }
    const list = await api.searchNearbyRestaurants(state.location, {
      cuisine: state.cuisine,
      price: state.price,
      minRating: state.minRating,
    });
    return replyRestaurants(client, event.replyToken, list, state.locationLabel || '該地點');
  }

  if (text === '說明' || text === 'help' || text === '？' || text === '?') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '🍽 使用方式：\n\n1. 傳送「地點名稱或地址」，例如：台北車站、信義威秀\n2. 或傳送你的「位置」（LINE 的定位）\n3. 選擇喜好：料理類型、價位、最低評分（可略過）\n4. 點「直接推薦」取得附近餐廳\n\n每則推薦都會附 Google 評價與「在 Google 地圖開啟／導航」按鈕，點擊即可導航。',
    });
  }

  const geo = await api.geocodeAddress(text);
  if (!geo) {
    return client.replyMessage(event.replyToken, { type: 'text', text: '找不到這個地點，請換個關鍵字或傳送定位。' });
  }

  state.location = { lat: geo.lat, lng: geo.lng };
  state.locationLabel = geo.formatted || text;
  return replyPreferenceQuickReply(client, event.replyToken, userId);
}

module.exports = { handleMessage, handlePostback };
