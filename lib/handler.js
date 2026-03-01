/**
 * LINE 訊息處理 (純對話模式)
 */
const sharp = require('sharp');
const { generateChatReply } = require('./gemini');
const { searchNearbyRestaurants } = require('./places');

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

async function replyOrPush(event, client, messages) {
  try {
    // 試著先用 reply API (因為它不收推播費用)
    return await client.replyMessage({
      replyToken: event.replyToken,
      messages: messages
    });
  } catch (err) {
    if (isReplyTokenError(err) && event?.source?.userId) {
      console.log('Reply token expired or invalid, forwarding to Push Message API.');
      return client.pushMessage({
        to: event.source.userId,
        messages: messages
      });
    }
    throw err;
  }
}

/** 處理純文字聊天訊息 */
async function handleMessage(event, client, blobClient) {
  // 支援傳入單一訊息物件或陣列形式的整合 function
  const sendMessage = (msgs) => replyOrPush(event, client, Array.isArray(msgs) ? msgs : [msgs]);
  const userId = event.source.userId;
  let displayName = '跑友';

  // 嘗試取得使用者的 LINE 暱稱，讓 AI 可以稱呼他
  if (userId) {
    try {
      const profile = await client.getProfile(userId);
      if (profile && profile.displayName) {
        displayName = profile.displayName;
      }
    } catch (e) {
      console.log('無法取得使用者名稱 (可能未加好友或取消授權)', e.message);
    }
  }

  let promptText = '';
  let imageBase64 = null;

  if (event.message.type === 'location') {
    const address = event.message.address || '';
    const title = event.message.title || '';
    // 收到位置資訊後，先偷偷打給 Google Places API 取回附近最高分的 5 間營業中餐廳
    let realRestaurantsStr = '';
    try {
      // 給出明確的關鍵字給 Places API，利用使用者的位置文字
      const searchKeyword = title || address;
      const apiResults = await searchNearbyRestaurants(searchKeyword);
      if (apiResults.length > 0) {
        realRestaurantsStr = `\n\n【真實世界餐廳清單】：\n` + apiResults.join('\n');
      }
    } catch (e) {
      console.log('取得 Google Places API 失敗或無結果', e.message);
    }

    promptText = `[使用者傳送了所在位置] 標題：${title}, 地址：${address}。請依據此地點推薦我有什麼好吃的？${realRestaurantsStr ? '\n\n【重要指令】：請你「唯一且絕對必須」從以上提供的【真實世界餐廳清單】中，依照你史都華的口吻包裝推薦給使用者，不要自己憑空捏造名單！如果清單為空，請回報找不到營業中的好餐廳。' : ''}`;
  } else if (event.message.type === 'text') {
    const text = (event.message.text || '').trim();
    // 設定呼叫關鍵字，避免群組內每句話都回覆
    const triggerKeywords = ['史都華', 'stuart', 'Stuart', 'stu', 'Stu'];
    const isTriggered = triggerKeywords.some(keyword => text.includes(keyword));

    // 群組中防干擾機制：如果不是特定關鍵句，也不是提及/回覆，就不要理會
    if (!isTriggered && event.source.type !== 'user') {
      return Promise.resolve(null);
    }

    // 判斷是否在詢問特定地點的餐廳 (例如：「國父紀念館附近」、「推薦信義區美食」)
    const foodIntentRegex = /(.*)(附近|週邊|周遭|推薦)(.*)(美食|吃|餐廳|好吃的)/i;
    const matchLocation = text.match(foodIntentRegex);

    let realRestaurantsStr = '';
    if (matchLocation) {
      try {
        // 將整句詢問或擷取到的地點丟給 Places API 去判斷 (Google API 的 query 本身容錯率很高)
        const apiResults = await searchNearbyRestaurants(text);
        if (apiResults.length > 0) {
          realRestaurantsStr = `\n\n【真實世界餐廳清單】：\n` + apiResults.join('\n');
        }
      } catch (e) {
        console.log('文字地點萃取 Google Places API 失敗或無結果', e.message);
      }
    }

    promptText = text + (realRestaurantsStr ? `\n\n【重要指令】：請你「唯一且絕對必須」從以上提供的【真實世界餐廳清單】中，依照你史都華的口吻包裝推薦給使用者，不要自己憑空捏造名單！如果清單為空，請回報找不到這附近營業中的好餐廳。` : '');
  } else if (event.message.type === 'image') {
    // 收到圖片，透過 LINE Blob API 下載圖片內容
    try {
      if (!blobClient) throw new Error('Blob Client 未初始化');

      const stream = await blobClient.getMessageContent(event.message.id);
      const chunks = [];
      // LINE v9+ 回傳的是 Web ReadableStream，在 Node 中需稍微不同處理
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      const rawBuffer = Buffer.concat(chunks);
      // 利用 sharp 將圖片壓縮大小與品質，降低記憶體和 API 負載
      const compressedBuffer = await sharp(rawBuffer)
        .resize({ width: 1024, withoutEnlargement: true }) // 將最大寬度限制在 1024px，避免傳送 4k 原圖
        .jpeg({ quality: 80 }) // 轉為 JPEG 格式並且壓縮至 80% 畫質
        .toBuffer();

      imageBase64 = compressedBuffer.toString('base64');
      promptText = '請幫我分析這張圖片。如果是餐點，請用美食家角度給建議；如果是運動數據或跑錶截圖，請用教練角度給建議。特別注意：如果截圖或數據中有顯示「特定的人名」或「跑者名稱」，請明確針對「該位跑者」進行數據分析與無情的吐槽教導，不要把這份數據當作是正在跟你講話的使用者本人的。';
    } catch (e) {
      console.error('無法下載圖片內容:', e.message);
      return sendMessage({ type: 'text', text: '抱歉，教練的老花眼沒看清楚這張圖，請再傳一次！' });
    }
  } else if (event.message.type === 'sticker') {
    return sendMessage({ type: 'text', text: '貼圖好可愛！但我不懂貼圖的意思哦～' });
  } else {
    // 其他類型的訊息不處理
    return Promise.resolve(null);
  }

  if (!promptText && !imageBase64) return Promise.resolve(null);

  // 通知 LINE 正在處理中 (顯示 ... 的動畫)
  if (userId) {
    try {
      await client.showLoadingAnimation({ chatId: userId, loadingSeconds: 20 });
    } catch (e) {
      console.log('無法顯示 Loading Animation，可能非單對單聊天：', e.message);
    }
  }

  // 取得 AI 回覆，支援傳入 Base64 圖片與使用者的 userId (作對話記憶快取使用)
  const aiResponse = await generateChatReply(promptText, imageBase64, userId, displayName);

  let messagesToSend = [];

  // 嘗試解析 JSON (針對美食推薦的卡片輪播轉換)
  // 利用 Regex 抓出 Markdown 內的 json 區塊
  const jsonMatch = aiResponse.match(/```(?:json)?\n([\s\S]*?)\n```/i);
  if (jsonMatch) {
    try {
      const restaurants = JSON.parse(jsonMatch[1]);
      const introText = aiResponse.replace(jsonMatch[0], '').trim();

      // 若教練有講前情提要，把它當作第一則訊息
      if (introText) {
        messagesToSend.push({ type: 'text', text: introText });
      }

      // 建立 LINE Flex Message Carousel (橫向輪播最多限制 10 張)
      const bubbles = restaurants.slice(0, 10).map(r => {
        let safeMapUrl = r.mapUrl || '';
        try {
          // 利用 new URL() 自動將其中的中文字元等進行 URL Encode 處理
          safeMapUrl = new URL(safeMapUrl).href;
          if (!safeMapUrl.startsWith('http://') && !safeMapUrl.startsWith('https://')) {
            throw new Error('不合法的 URL Protocol');
          }
        } catch (e) {
          // 若解析失敗，則組裝一個保證合法的 Search URL
          const fallbackName = r.name || '餐廳';
          safeMapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fallbackName)}`;
        }

        // 限制 URI 長度為 1000 以內 (LINE Messaging API 限制)
        if (safeMapUrl.length > 1000) {
          safeMapUrl = safeMapUrl.slice(0, 1000);
        }

        return {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              { type: 'text', text: r.name || '未知名稱', weight: 'bold', size: 'xl', wrap: true },
              { type: 'text', text: '⭐ ' + (r.rating || '無'), size: 'sm', color: '#888888' },
              { type: 'text', text: '💰 ' + (r.price || '無'), size: 'sm', color: '#888888' },
              { type: 'text', text: '🍜 ' + (r.item || '無'), size: 'sm', color: '#444444', wrap: true }
            ]
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: '#03C755',
                action: {
                  type: 'uri',
                  label: 'Google Map 導航',
                  uri: safeMapUrl
                }
              }
            ]
          }
        };
      });

      if (bubbles.length > 0) {
        messagesToSend.push({
          type: 'flex',
          altText: '史都華 (Stuart) 為你找了幾家好吃的 Banana! (請在手機看)',
          contents: {
            type: 'carousel',
            contents: bubbles
          }
        });
      }
    } catch (e) {
      console.log('Flex Message 解析失敗，降級為純文字輸出', e.message);
      messagesToSend = [{ type: 'text', text: aiResponse }];
    }
  } else {
    // 正常聊天對話
    messagesToSend = [{ type: 'text', text: aiResponse }];
  }

  return sendMessage(messagesToSend);
}

async function handlePostback(event, client, blobClient) {
  // 純對話模式下暫不處理 postback
  return Promise.resolve(null);
}

/** 處理加入群組或新成員加入事件 */
async function handleJoin(event, client) {
  // 如果事件發生在群組或聊天室內
  if (event.source.type === 'group' || event.source.type === 'room') {
    const welcomeMsg = "Bello~ 🍌 \n\n小小兵史都華 (Stuart) 降臨啦！\n平時我會安靜地在旁邊吃香蕉，但只要你們在對話中提到「史都華」或者是叫我「stu」，我就會跳出來給你們最嚴峻的配速建議或是幫忙找吃的！\n\n快點給我 Banana 試試看吧！😎";
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: welcomeMsg }]
    }).catch(e => console.log('歡迎訊息發送失敗:', e.message));
  }
  return Promise.resolve(null);
}

module.exports = { handleMessage, handlePostback, handleJoin };
