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
    return await client.replyMessage(event.replyToken, message);
  } catch (err) {
    if (isReplyTokenError(err) && event?.source?.userId) {
      console.log('Reply token expired or invalid, forwarding to Push Message API.');
      return client.pushMessage(event.source.userId, message);
    }
    throw err;
  }
}

/** 處理純文字聊天訊息 */
async function handleMessage(event, client) {
  const sendMessage = (message) => replyOrPush(event, client, message);
  const userId = event.source.userId;

  if (event.message.type !== 'text') {
    if (event.message.type === 'sticker') {
      return sendMessage({ type: 'text', text: '貼圖好可愛！' });
    }
    return Promise.resolve(null);
  }

  const text = (event.message.text || '').trim();
  if (!text) return Promise.resolve(null);

  // 通知 LINE 正在處理中 (顯示 ... 的動畫)
  // 如果使用者是從群組發問，則不支援此 API，所以用 catch 忽略錯誤
  if (userId) {
    try {
      await client.showLoadingAnimation({ chatId: userId, loadingSeconds: 20 });
    } catch (e) {
      console.log('無法顯示 Loading Animation，可能非單對單聊天：', e.message);
    }
  }

  // 取得 AI 回覆
  const aiResponse = await generateChatReply(text);

  return sendMessage({ type: 'text', text: aiResponse });
}

async function handlePostback(event, client) {
  // 純對話模式下暫不處理 postback
  return Promise.resolve(null);
}

module.exports = { handleMessage, handlePostback };
