/**
 * LINE 美食推薦機器人
 * - 輸入地點推薦附近餐廳
 * - 依喜好篩選（料理類型、價位、最低評分）
 * - 顯示 Google 評價與可導航的 Google Maps 連結
 */
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

const { handleMessage, handlePostback, handleJoin } = require('./lib/handler');

const app = express();
const port = process.env.PORT || 3000;

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.warn('請設定 LINE_CHANNEL_ACCESS_TOKEN 與 LINE_CHANNEL_SECRET');
}

// 建立 LINE v9 API Client
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken
});
// 建立用來下載圖片等檔案內容的 Blob Client
const blobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: config.channelAccessToken
});

// 簡單快取：紀錄已經處理過的 x-line-retry-key，避免重複處理相同請求
// 由於在 Lambda / Serverless 環境下也可能重新啟動而清空快取，
// 但在一般運行時間內可以有效阻擋 LINE 因為 Timeout 產生的 Retry。
const processedRetries = new Set();
// 定期清理舊的 x-line-retry-key
setInterval(() => processedRetries.clear(), 10 * 60 * 1000);

// 手動讀取原始 body（Buffer），避免被平台或 express.json 先解析導致簽章驗證失敗
function rawBodyMiddleware(req, res, next) {
  const existingBody = req.body;
  req.body = undefined; // 避免 LINE middleware 誤用已解析的 Object

  function setRawBody(chunks) {
    const fromStream = Buffer.concat(chunks);
    if (fromStream.length > 0) {
      req.rawBody = fromStream;
    } else if (Buffer.isBuffer(existingBody) || typeof existingBody === 'string') {
      req.rawBody = Buffer.isBuffer(existingBody) ? existingBody : Buffer.from(existingBody, 'utf8');
    } else if (existingBody && typeof existingBody === 'object') {
      req.rawBody = Buffer.from(JSON.stringify(existingBody), 'utf8');
    } else {
      req.rawBody = Buffer.alloc(0);
    }
    next();
  }

  if (req.readableEnded) {
    setRawBody([]);
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => setRawBody(chunks));
  req.on('error', next);
}

// 先定義 /webhook，用「原始 body」給 LINE 簽章驗證用（不可先被 express.json 解析）
app.post(
  '/webhook',
  rawBodyMiddleware,
  (req, res, next) => {
    const run = line.middleware(config);
    run(req, res, (err) => {
      if (err) {
        console.error('LINE middleware error:', err?.message || err);
        return safeSend200(res);
      }
      next();
    });
  },
  (req, res) => {
    if (!req.body?.events?.length) {
      return safeSend200(res);
    }

    // 取得 LINE 為了 Retry 送來的識別碼
    const retryKey = req.headers['x-line-retry-key'];

    // 若該 retry-key 已經被處理過，表示是 LINE 因為 Timeout 重送的請求，直接略過。
    if (retryKey && processedRetries.has(retryKey)) {
      console.log(`[Retry Handler] 略過重複的請求: ${retryKey}`);
      return safeSend200(res);
    }

    if (retryKey) {
      processedRetries.add(retryKey);
    }

    // 立即回傳 200 OK，避免 LINE 官方因為等待逾時而重試
    safeSend200(res);

    // 在背景執行處理，發後不理 (fire-and-forget)，不用等待其結果
    req.body.events.forEach((event) => {
      handleEvent(event, client, blobClient).catch(err => {
        console.error('Background event handling error:', err);
        // 發生錯誤時將 retryKey 移除，讓下一次如有重試時能再執行
        if (retryKey) processedRetries.delete(retryKey);
      });
    });
  }
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.send('LINE 美食推薦機器人運行中');
});

function safeSend200(res) {
  try {
    if (!res.headersSent) res.status(200).end();
  } catch (e) {
    console.error('safeSend200:', e);
  }
}

async function handleEvent(event, client, blobClient) {
  try {
    if (event.type === 'message') {
      return await handleMessage(event, client, blobClient);
    }
    if (event.type === 'postback') {
      return await handlePostback(event, client, blobClient);
    }
    // 當機器人被加入群組，或是群組有新成員加入時
    if (event.type === 'join' || event.type === 'memberJoined') {
      return await handleJoin(event, client);
    }
  } catch (err) {
    console.error('handleEvent error:', err);
    const detail = err?.originalError?.response?.data;
    if (detail) {
      console.error('handleEvent error detail:', JSON.stringify(detail));
    }
  }
  return null;
}

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err?.message || err);
  if (req.originalUrl === '/webhook' && !res.headersSent) res.status(200).end();
  else next(err);
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
