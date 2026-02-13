# LINE 美食推薦機器人

依「地點」推薦附近餐廳，可依喜好篩選。**完全免費**：使用 OpenStreetMap（Nominatim + Overpass），不需 Google API、不需綁卡。

## 功能

- **輸入地點**：傳送地址或地名（如「台北車站」），或傳送 LINE 定位
- **選用 Google AI Studio（Gemini）**：設定 `GEMINI_API_KEY` 後，可用自然語描述，例如「信義區附近想找日式」→ 自動擷取地點「信義區」與料理「日式」，查詢更精準
- **喜好篩選**：料理類型（中式、日式、韓式、西式、泰式、咖啡甜點、素食、不限）等
- **結果**：店名、地址、**在地圖開啟／導航**按鈕（點擊可用 Google 地圖導航）。無評分資料（免費地圖不提供）

## 環境變數

| 變數 | 說明 |
|------|------|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE 頻道 Access Token |
| `LINE_CHANNEL_SECRET` | LINE 頻道 Secret |
| `GEMINI_API_KEY` | 選填。Google AI Studio API 金鑰，用於解析使用者訊息擷取地點與料理類型；[在此取得](https://aistudio.google.com/app/apikey) |
| `PORT` | 選填，Zeabur 會自動設定 |

## 本地執行

```bash
cp .env.example .env
# 編輯 .env 填入上述金鑰

npm install
npm start
```

Webhook 需可從外網連線（可用 ngrok 等工具）。

## 推上 GitHub

1. 在 [GitHub](https://github.com) 建立新 repo（例如 `line-food-bot`，可選 public）。
2. 在本機專案目錄執行（將 `你的帳號` 換成你的 GitHub 使用者名稱）：

```bash
cd C:\git_repo\line-food-bot
git remote add origin https://github.com/你的帳號/line-food-bot.git
git push -u origin main
```

`.env` 已由 `.gitignore` 排除，不會被提交。

## 部署到 Zeabur

1. 登入 [Zeabur](https://zeabur.com) → **New Project** → **Deploy from GitHub**，選擇此 repo
2. 在服務的 **Variables** 分頁新增：
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `LINE_CHANNEL_SECRET`
   - （選填）`GEMINI_API_KEY`：若要用自然語解析地點與料理類型
3. 部署完成後，複製 Zeabur 提供的 **公開網址**（例如 `https://xxx.zeabur.app`）。

## 設定 LINE Webhook

1. 到 [LINE Developers](https://developers.line.biz) → 你的 **Messaging API** Channel → **Messaging API** 分頁。
2. **Webhook URL** 設為：`https://你的Zeabur網址/webhook`（例如 `https://xxx.zeabur.app/webhook`）。
3. 點 **Update**，並確認 **Use webhook** 為開啟。
4. 可點 **Verify** 檢查 Webhook 是否成功。

## 驗證機器人

在 LINE Developers 同一個 Channel 的 **Messaging API** 分頁，用 **LINE Official Account** 或掃描 **Channel** 的 QR code 加入機器人為好友。傳送地點（例如「台北車站」）或傳送定位，依流程選擇喜好後點「直接推薦」，確認有回傳餐廳與地圖導航連結。

## 授權

MIT
