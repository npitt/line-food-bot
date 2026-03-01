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

/** 處理純文字聊天訊息 */
async function handleMessage(event, client) {
  const reply = (message) => replyWithFallback(event, client, message);

  if (event.message.type !== 'text') {
    if (event.message.type === 'sticker') {
      return reply({ type: 'text', text: '貼圖好可愛！' });
    }
    return Promise.resolve(null);
  }

  const text = (event.message.text || '').trim();
  if (!text) return Promise.resolve(null);

  // 通知 LINE 正在處理中 (若有支援 Loading Animation)
  try {
    // Optional: 送出正在輸入中的狀態 (有些 SDK 版本有支援)
  } catch (e) { }

  // 取得 AI 回覆
  const aiResponse = await generateChatReply(text);

  return reply({ type: 'text', text: aiResponse });
}

async function handlePostback(event, client) {
  // 純對話模式下暫不處理 postback
  return Promise.resolve(null);
}

module.exports = { handleMessage, handlePostback };
