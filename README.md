# LINE 美食推薦機器人

依「地點」推薦附近餐廳，可依喜好篩選，並顯示 Google 評價與一鍵導航連結。

## 功能

- **輸入地點**：傳送地址或地名（如「台北車站」），或傳送 LINE 定位
- **喜好篩選**（大家常用選項）：
  - **料理類型**：中式、日式、韓式、西式、泰式、咖啡甜點、素食、不限
  - **價位**：便宜、中等、高價、不限
  - **最低評分**：3.5 / 4.0 / 4.5 星以上、不限
- **結果**：店名、地址、Google 評分與評論數、**在 Google 地圖開啟／導航**按鈕（點擊即可用 Google Maps App 導航）

## 環境變數

| 變數 | 說明 |
|------|------|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE 頻道 Access Token |
| `LINE_CHANNEL_SECRET` | LINE 頻道 Secret |
| `GOOGLE_PLACES_API_KEY` | Google API 金鑰（需啟用 Geocoding API、Places API） |
| `PORT` | 選填，Zeabur 會自動設定 |

## 本地執行

```bash
cp .env.example .env
# 編輯 .env 填入上述金鑰

npm install
npm start
```

Webhook 需可從外網連線（可用 ngrok 等工具）。

## 部署到 Zeabur

1. 將此專案 **Push 到 GitHub**
2. 登入 [Zeabur](https://zeabur.com) → **New Project** → **Deploy from GitHub**，選擇此 repo
3. 在服務的 **Variables** 分頁新增：
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `LINE_CHANNEL_SECRET`
   - `GOOGLE_PLACES_API_KEY`
4. 部署完成後，複製 Zeabur 提供的 **公開網址**（例如 `https://xxx.zeabur.app`）
5. 到 [LINE Developers](https://developers.line.biz) → 你的 Channel → **Messaging API** → **Webhook URL** 設為：  
   `https://你的Zeabur網址/webhook`  
   並開啟 **Use webhook**

## Google API 設定

1. 前往 [Google Cloud Console](https://console.cloud.google.com/)
2. 建立專案或選擇既有專案
3. 啟用 **Geocoding API**、**Places API**（或 **Places API (Legacy)**）
4. **API 和服務** → **憑證** → 建立 **API 金鑰**，將金鑰貼到環境變數 `GOOGLE_PLACES_API_KEY`

## 授權

MIT
