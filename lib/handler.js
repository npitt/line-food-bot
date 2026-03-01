/**
 * LINE 訊息處理 (純對話模式)
 */
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
async function handleMessage(event, client) {
  const sendMessage = (message) => replyOrPush(event, client, message);
  const userId = event.source.userId;

  let promptText = '';
  let imageBase64 = null;

  if (event.message.type === 'location') {
    const address = event.message.address || '';
    const title = event.message.title || '';
    promptText = `[使用者傳送了所在位置] 標題：${title}, 地址：${address}。請依據此地點推薦我有什麼好吃的？`;
  } else if (event.message.type === 'text') {
    promptText = (event.message.text || '').trim();
  } else if (event.message.type === 'image') {
    // 收到圖片，透過 LINE API 下載圖片內容
    try {
      const stream = await client.getMessageContent(event.message.id);
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      imageBase64 = buffer.toString('base64');
      promptText = '請幫我分析這張圖片，如果是餐點請用美食家角度給建議，如果是運動數據或跑錶截圖請用教練角度給建議。';
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

  // 取得 AI 回覆，支援傳入 Base64 圖片
  const aiResponse = await generateChatReply(promptText, imageBase64);

  return sendMessage({ type: 'text', text: aiResponse });
}

async function handlePostback(event, client) {
  // 純對話模式下暫不處理 postback
  return Promise.resolve(null);
}

module.exports = { handleMessage, handlePostback };
