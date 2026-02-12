/**
 * LINE 美食推薦機器人
 * - 輸入地點推薦附近餐廳
 * - 依喜好篩選（料理類型、價位、最低評分）
 * - 顯示 Google 評價與可導航的 Google Maps 連結
 */
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { searchNearbyRestaurants, geocodeAddress } = require('./lib/places');
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.send('LINE 美食推薦機器人運行中');
});

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map((event) => handleEvent(event, client)))
    .then(() => res.end())
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleEvent(event, client) {
  if (event.type === 'message') {
    return handleMessage(event, client, { searchNearbyRestaurants, geocodeAddress });
  }
  if (event.type === 'postback') {
    return handlePostback(event, client, { searchNearbyRestaurants, geocodeAddress });
  }
  return Promise.resolve(null);
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
