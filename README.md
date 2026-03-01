# LINE 聊天機器人 (Gemini / OpenRouter)

這是一個純對話的 LINE 機器人。**完全免費**：預設優先使用 Google Gemini 處理訊息，若發生錯誤則自動退回使用 OpenRouter 提供的免費模型。

## 功能

- **純文字對話**：傳送任何文字訊息，機器人皆會由 AI 模型回應。
- **上下文記憶 (Context Memory)**：AI 會記得與您近 30 分鐘內的數則對話歷史，讓聊天能順暢承接上文（例如：先問「想配多少？」，再回「五分半」，教練聽得懂）。
- **看圖給建議 (多模態 Vision)**：直接上傳運動數據截圖或餐點照片給機器人，AI 將自動辨識圖片內容並以教練或美食家的口吻給予專業分析。
- **在地位置推薦**：可直接在聊天室傳送「位置資訊 (Location)」，AI 將會根據該地點（包含地址與地標名稱）自動為您推薦附近的美食或周邊資訊。為求簡潔，**餐廳名單預設將以標準化純文字清單格式**（包含店名、評價、價格區間、推薦品項、地圖連結）呈現。
- **自訂角色 (GEM) 概念**：所有角色與人設（System Prompt），皆統一由專案根目錄的 `gemini.config.json` 來控管，預設提供「幽默風趣且有同理心的當地美食專家兼馬拉松/健身教練」，會隨專案一併佈署生效。如果在機器平台或是 `.env` 另外設定了 `GEM_SYSTEM_INSTRUCTION` 環境變數，則會具有最高優先權並覆寫設定檔。
- **雙模型備援**：優先使用 `GEMINI_API_KEY`，如未設定或呼叫失敗，將自動轉由 `OPENROUTER_API_KEY` 接手。
- **強健的非同步架構 (Best Practice)**：因應 LLM 思考時間較長，實作了防重複金鑰 (`x-line-retry-key`) 以避免 LINE Webhook 逾時重發；並具備「發後不理 (fire-and-forget)」的背景處理機制。
- **智慧回覆降級與體驗優化**：對話當下會顯示讀取動畫 (Loading Animation)，並在處理完畢時優先使用 Reply API，若因等待過久導致 Token 失效，將自動降級改用 Push API 主動推播結果，確保訊息不漏接。

## 環境變數

| 變數                         | 說明                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `LINE_CHANNEL_ACCESS_TOKEN`  | LINE 頻道 Access Token                                                                                                    |
| `LINE_CHANNEL_SECRET`        | LINE 頻道 Secret                                                                                                          |
| `GEMINI_API_KEY`             | 選填。Google AI Studio API 金鑰，對話預設優先使用；[在此取得](https://aistudio.google.com/app/apikey)                     |
| `OPENROUTER_API_KEY`         | 選填。OpenRouter API 金鑰；作為 Gemini 的備援模型使用                                                                     |
| `GEM_SYSTEM_INSTRUCTION`     | 選填。環境變數型態的 System Prompt。**建議直接修改 `gemini.config.json`**，但若在此設定，則會**覆寫**設定檔的內容。       |
| `OPENROUTER_MODEL`           | 選填。OpenRouter 主模型，預設 `openrouter/aurora-alpha`                                                                   |
| `OPENROUTER_MODEL_FALLBACKS` | 選填。OpenRouter 備援模型清單（逗號分隔），主模型失敗時依序嘗試；預設 `meta-llama/llama-3.2-3b-instruct:free`             |
| `OPENROUTER_REFERRER`        | 選填。OpenRouter `HTTP-Referer` header，未填則使用預設 repo URL                                                           |
| `PORT`                       | 選填，Zeabur 會自動設定                                                                                                   |

## 開發環境與核心套件版本要求

為確保功能正常運作，本專案依賴以下特定環境與版本：

- **Node.js**: `>= 18.0.0`
- **@line/bot-sdk**: `^10.6.0` (因應 v9 後的 Breaking Changes 以及 `showLoadingAnimation` 支援)
- **@google/generative-ai**: `^0.21.0` (Gemini API 核心套件)
- **express**: `^4.18.2`

## 本地執行

```bash
cp .env.example .env
# 編輯 .env 填入上述金鑰

npm install
npm start
```

Webhook 需可從外網連線（可用 ngrok 等工具）。

## 測試

- 僅確認語法是否正常（無正式測試包含於目前專案中，主要透過直接啟動測試）：

```bash
npm start
```

> Windows PowerShell 若遇到 `npm.ps1` 執行政策限制，可改用 `npm.cmd`。

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
   - （選填）`GEMINI_API_KEY`：對話預設優先使用
   - （選填）`GEM_SYSTEM_INSTRUCTION`：自訂專家角色指令設定
   - （選填）`OPENROUTER_API_KEY`：當 Gemini 不可用或失敗時的備援
   - （選填）`OPENROUTER_MODEL`：預設 `openrouter/aurora-alpha`
   - （選填）`OPENROUTER_MODEL_FALLBACKS`：備援模型清單（逗號分隔）
3. 部署完成後，複製 Zeabur 提供的 **公開網址**（例如 `https://xxx.zeabur.app`）。

## 設定 LINE Webhook

1. 到 [LINE Developers](https://developers.line.biz) → 你的 **Messaging API** Channel → **Messaging API** 分頁。
2. **Webhook URL** 設為：`https://你的Zeabur網址/webhook`（例如 `https://xxx.zeabur.app/webhook`）。
3. 點 **Update**，並確認 **Use webhook** 為開啟。
4. 可點 **Verify** 檢查 Webhook 是否成功。

## 驗證機器人

在 LINE Developers 同一個 Channel 的 **Messaging API** 分頁，用 **LINE Official Account** 或掃描 **Channel** 的 QR code 加入機器人為好友。傳送任何文字訊息，確認機器人能正常使用 Gemini 進行回覆。如果有設定 `GEM_SYSTEM_INSTRUCTION`，可以從回應的語氣與內容確認設定是否生效。

## 授權

MIT
