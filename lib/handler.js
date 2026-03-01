/**
 * LINE 訊息處理 (純對話模式)
 */
const sharp = require('sharp');
const { generateChatReply } = require('./gemini');

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

async function replyOrPush(event, client, message) {
  try {
    // 試著先用 reply API (因為它不收推播費用)
    return await client.replyMessage({
      replyToken: event.replyToken,
      messages: [message]
    });
  } catch (err) {
    if (isReplyTokenError(err) && event?.source?.userId) {
      console.log('Reply token expired or invalid, forwarding to Push Message API.');
      return client.pushMessage({
        to: event.source.userId,
        messages: [message]
      });
    }
    throw err;
  }
}

/** 處理純文字聊天訊息 */
async function handleMessage(event, client, blobClient) {
  const sendMessage = (message) => replyOrPush(event, client, message);
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
    promptText = `[使用者傳送了所在位置] 標題：${title}, 地址：${address}。請依據此地點推薦我有什麼好吃的？`;
  } else if (event.message.type === 'text') {
    const text = (event.message.text || '').trim();
    // 設定呼叫關鍵字，避免群組內每句話都回覆
    const triggerKeywords = ['史都華', 'stuart', 'Stuart', 'stu', 'Stu'];
    const isTriggered = triggerKeywords.some(keyword => text.includes(keyword));

    // 群組中防干擾機制：如果不是特定關鍵句，也不是提及/回覆，就不要理會
    if (!isTriggered && event.source.type !== 'user') {
      return Promise.resolve(null);
    }
    promptText = text;
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

  return sendMessage({ type: 'text', text: aiResponse });
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
