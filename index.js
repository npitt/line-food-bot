/**
 * LINE 美食推薦機器人
 * - 輸入地點推薦附近餐廳
 * - 依喜好篩選（料理類型、價位、最低評分）
 * - 顯示 Google 評價與可導航的 Google Maps 連結
 */
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

const { handleMessage, handlePostback } = require('./lib/handler');

const app = express();
const port = process.env.PORT || 3000;

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.warn('請設定 LINE_CHANNEL_ACCESS_TOKEN 與 LINE_CHANNEL_SECRET');
}

const client = new line.Client(config);

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

    // 立即回傳 200 OK，避免 LINE 官方因為等待 AI 處理逾時而重試
    safeSend200(res);

    Promise.all(req.body.events.map((event) => handleEvent(event, client)))
      .catch((err) => {
        console.error('Webhook error:', err);
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

async function handleEvent(event, client) {
  try {
    if (event.type === 'message') {
      return await handleMessage(event, client);
    }
    if (event.type === 'postback') {
      return await handlePostback(event, client);
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
