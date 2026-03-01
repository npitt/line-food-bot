# LINE Food Bot 開發憲法 (Development Charter)

本憲法確立了「史都華教練 (Stuart)」專案的核心開發準則與架構規範。任何後續的開發、修改或重構，皆「必須」遵守以下規則，以確保系統穩定、費用可控且人設一致。

## 1. 核心架構與效能準則 (Architecture & Performance)
1. **發後不理 (Fire-and-Forget)**：介接 LINE Webhook 時，主程序必須立即回傳 HTTP 200 OK (`Promise.resolve(null)` 等)。耗時的 AI 運算必須放在背景非同步執行，絕對不可阻塞 Webhook 回應，以免引發 LINE 伺服器 Timeout 導致的重發機制轟炸。
2. **冪等性與防重複執行 (Idempotency)**：必須利用 Header 傳來的 `x-line-retry-key` 實作請求快取。若收到相同的 Retry Key，一律判定為重複金鑰直接略過，嚴防同一訊息重複消耗昂貴的 LLM Token。
3. **推播降級機制 (Graceful Degradation)**：回傳訊息時必先嘗試使用免費的 `replyMessage` API。若因 AI 回應時間過長導致 `replyToken` 過期失效 (Expired Error)，且對象具有 `userId`，則必須自動降級為利用 `pushMessage` 主動推播，確保訊息妥善送達。
4. **資源與記憶體防護**：使用者傳送的任何圖片，在轉交給 AI (轉換為 Base64) 分析前，**絕對必須**透過 `sharp` 套件進行壓縮 (寬度限制 1024px，JPEG 畫質 80%)。嚴禁將龐大的原始圖檔直接塞給 API 避免超過 Payload 限制與浪費記憶體。
5. **多圖片節流機制 (Debouncing & Batching)**：不允許對群組中使用者連發的數張圖片進行連環洗版回覆。必須以 `userId` 為鍵值建立暫存佇列 (Batch Queue)，等待約 1.5 秒無新圖片傳入後，再將收集來的圖片陣列一併打包發送給 AI 進行「綜合批次分析」。

## 2. 角色設定與對話準則 (System & Persona Constraints)
1. **外部化設定管理**：角色的 System Instruction、性格、能力設定，必須統一收斂與維護在專案目錄的 `gemini.config.json`，讓角色語意設定與主程式邏輯抽離，且方便進行 Git 版本控制。
2. **具備局部環境感知 (Time-Awareness)**：在構建傳遞給 AI 的系統提示前，後端程式必須主動將「當下的真實伺服器時間 (附帶正確時區)」以及「發話方 LINE 稱呼」以隱藏系統角色字串的前置方式注入給 AI，讓教練擁有時間與對象感知。
3. **對話快取 (Context Memory)**：系統需以 `userId` 維護 In-Memory 短期對話歷史，僅保存最新 6 句話 (包含 AI 與使用者的對答)，保存期限 30 分鐘。嚴禁將龐大的背景資料清單 (如 JSON 餐廳搜尋結果、Strava 分析全數據) 存入該歷史快取中，以免汙染使用者的日常對話與過快耗盡 Token。

## 3. API 串接與防捏造準則 (Integration & Anti-Hallucination)
1. **Google Places 真實世界防護網**：當使用者詢問實體地點附近的美食時，必須透過後端攔截並優先呼叫 Google Places API 撈取真實店家。**嚴禁 AI 憑空捏造餐廳**。賦予 AI 的 Prompt 必須強硬要求只能由 API 提供的營業中高分餐廳裡挑選推薦，杜絕 LLM 創造幽靈餐廳的幻覺。
2. **Strava 零權限爬蟲**：不依賴複雜的 Strava OAuth API。應直接攔截聊天中的 `strava.app.link` URL，跟隨轉址並抓取最終頁面的 OGP Tag (標題、描述)。若要取得高階數據 (爬升、心率、步頻)，必須解析內嵌的 React State (`__NEXT_DATA__`)。
3. **天氣資訊補償機制**：當 Strava 原始資料缺乏氣象資訊時，必須主動利用提取出的「當地時間戳記」與「起點地理座標」，呼叫免金鑰的天氣 API (如 Open-Meteo) 進行反查，將當時當地的氣溫與濕度補齊以利教練分析。

## 4. 群組體驗與干擾防護 (Group Chat Experience)
1. **無指令不回覆 (Idle Silence)**：在非一對一的聊天室 (群組) 中，若對話未被明確呼叫 (`史都華`, `Stuart`, `stu` 等關鍵詞) 且為純文字閒聊，機器人**絕對不可**主動插話回應。
2. **無關圖片過濾指令 (Noise Filter)**：若使用者在群組發送圖片但未標記教練，系統應暗中加上指令強制要求 AI 判斷該圖是否與運動紀錄有關，若無關則單純回傳 `[IGNORE]` 短代碼。主程式接收到該代碼後必須立刻銷毀且不送出任何推播。
3. **有溫度的針對性分析 (Targeted Coaching)**：要求 AI 在處理跑錶截圖或分享數據時，具備截圖人名識別能力。分析語氣必須明確針對「截圖內紀錄的主人翁」進行指教，用充滿溫度、同理心與幽默感的專業用語給予鼓勵，而非盲目地將所有數據均視為傳圖者本人的成績，更絕對不可使用過度貶低或毒舌的用詞。

> **修訂記錄** 
> 任何未來的協作開發者或 AI 繼任者，於增加新功能前必須確保不抵觸上述憲法原則。若有擴充需求，亦需以此文件為設計根基進行條文追加。
