/**
 * LINE 訊息處理 (純對話模式)
 */
const { generateChatReply, getApiUsageStatus, getUserHistory } = require('./gemini');
const { searchNearbyRestaurants } = require('./places');
const { extractStravaStats } = require('./strava');
const { isTrainingSchedule, parseSchedule, formatGroupResult, buildGroupQuickReply, cacheSchedule, getCachedSchedule, isGroupSelection, getLatestSchedule, getThisWeekSchedule, isDateInPeriod } = require('./schedule');
const { downloadAndCompress, buildImageSystemContext, enqueueImage } = require('./imageHandler');
const { tryParseFlexResponse } = require('./flexBuilder');

// 儲存正在收集的多張圖片批次處理器 (以 userId 為 Key)
const imageBatchQueue = new Map();

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

async function replyOrPush(event, client, messages) {
  try {
    // 試著先用 reply API (因為它不收推播費用)
    return await client.replyMessage({
      replyToken: event.replyToken,
      messages: messages
    });
  } catch (err) {
    if (isReplyTokenError(err) && event?.source?.userId) {
      console.log('Reply token expired or invalid, forwarding to Push Message API.');
      return client.pushMessage({
        to: event.source.userId,
        messages: messages
      });
    }
    throw err;
  }
}

/** 處理純文字聊天訊息 */
async function handleMessage(event, client, blobClient) {
  // 支援傳入單一訊息物件或陣列形式的整合 function
  const sendMessage = (msgs) => replyOrPush(event, client, Array.isArray(msgs) ? msgs : [msgs]);
  const userId = event.source.userId;
  const sourceId = event.source.groupId || event.source.roomId || event.source.userId;
  let displayName = '跑友';

  // 嘗試取得使用者的 LINE 暱稱，讓 AI 可以稱呼他
  if (userId) {
    try {
      const profile = await client.getProfile(userId);
      if (profile && profile.displayName) {
        displayName = profile.displayName;
      }
    } catch (e) {
      console.log(`無法取得使用者 ${userId} 的顯示名稱，預設為 ${displayName}`);
    }
  }

  console.log(`[對話來源] ${sourceId} (${displayName}): ${event.message.type === 'text' ? event.message.text : '[' + event.message.type + ']'}`);

  // 共用的私有函式：從使用者的附帶文字中擷取找餐廳意圖並呼叫 Google Places API
  async function extractRealRestaurants(inputText) {
    const textDesc = inputText.toLowerCase();

    // 判斷是否具備找餐廳的雙重意圖特徵：[地點副詞] + [食物名詞]
    const hasLocationKeyword = ['附近', '周遭', '周邊', '推薦'].some(k => textDesc.includes(k));
    const hasFoodKeyword = ['美食', '吃', '餐廳', '好料'].some(k => textDesc.includes(k));

    const isFoodIntent = hasLocationKeyword && hasFoodKeyword;

    let resultStr = '';
    console.log(`[意圖偵測] 輸入文字: "${inputText}", 是否匹配餐廳查詢: ${isFoodIntent}`);

    if (isFoodIntent) {
      try {
        const cleanKeyword = inputText.replace(/史都華|stuart|stu/ig, '').trim();
        console.log(`[Google API 請求] 關鍵字: "${cleanKeyword}"`);

        const apiResults = await searchNearbyRestaurants(cleanKeyword);
        console.log(`[Google API 結果] 找到 ${apiResults.length} 家餐廳`);

        if (apiResults.length > 0) {
          resultStr = `\n\n【真實世界餐廳清單】：\n` + apiResults.join('\n');
        } else {
          console.log('Google Places API 無結果回傳 (可能查無餐廳)');
        }
      } catch (e) {
        console.log('文字地點萃取 Google Places API 失敗或無結果', e.message);
      }
    }
    return resultStr;
  }

  let promptText = '';
  let systemContextText = '';
  let imageBase64 = null;

  if (event.message.type === 'location') {
    const address = event.message.address || '';
    const title = event.message.title || '';
    // 收到位置資訊後，先偷偷打給 Google Places API 取回附近最高分的 5 間營業中餐廳
    let realRestaurantsStr = '';
    try {
      // 給出明確的關鍵字給 Places API，利用使用者的位置文字
      const searchKeyword = title || address;
      const apiResults = await searchNearbyRestaurants(searchKeyword);
      if (apiResults.length > 0) {
        realRestaurantsStr = `\n\n【真實世界餐廳清單】：\n` + apiResults.join('\n');
      }
    } catch (e) {
      console.log('取得 Google Places API 失敗或無結果', e.message);
    }

    promptText = `[使用者傳送了所在位置] 標題：${title}, 地址：${address}。請依據此地點推薦我有什麼好吃的？`;
    if (realRestaurantsStr) {
      systemContextText = `${realRestaurantsStr}\n\n【重要指令】：請你「唯一且絕對必須」從以上提供的【真實世界餐廳清單】中，依照你史都華的口吻包裝推薦給使用者，不要自己憑空捏造名單！如果清單為空，請回報找不到營業中的好餐廳。`;
    }
  } else if (event.message.type === 'text') {
    const text = (event.message.text || '').trim();
    // 設定呼叫關鍵字，避免群組內每句話都回覆
    const triggerKeywords = ['史都華', 'stuart', 'Stuart', 'stu', 'Stu'];
    const isTriggered = triggerKeywords.some(keyword => text.includes(keyword));

    // 群組中防干擾機制：如果不是特定關鍵句，也不是提及/回覆，就不要理會
    if (!isTriggered && event.source.type !== 'user') {
      return Promise.resolve(null);
    }

    // --- 1. 先檢查是否為特別的系統查詢指令 (管理員限定) ---
    const adminId = process.env.ADMIN_USER_ID;
    const isSystemQuery = (text === '使用量' || text === '用量查詢' || text === '查用量');

    if (isSystemQuery) {
      if (adminId && userId === adminId) {
        const usageStatus = getApiUsageStatus();
        return sendMessage({ type: 'text', text: usageStatus });
      } else if (isSystemQuery && event.source.type === 'user') {
        // 如果是私訊且想查但不是管理員，可以幽默回應或直接忽略
        // 這裡選擇讓它繼續往下走，或是給個小小兵風格的拒絕
        console.log(`[權限阻擋] 非管理員試圖查詢用量: ${userId}`);
      }
    }

    // --- 2. 檢查是否為「課表X組」的組別選擇指令 (必須最優先，以免被下方模糊匹配蓋過) ---
    const selectedGroup = isGroupSelection(text);
    if (selectedGroup) {
      const cached = getCachedSchedule(sourceId);
      if (cached) {
        const result = formatGroupResult(cached, selectedGroup);
        if (result) {
          return sendMessage({ type: 'text', text: `Bello! 🍌\n\n${result}` });
        } else {
          return sendMessage({ type: 'text', text: `找不到全馬${selectedGroup}組的資料耶，確認一下課表裡有沒有這組？` });
        }
      } else {
        return sendMessage({ type: 'text', text: '教練的記憶體裡沒有存到課表耶～請重新貼一次課表給我！' });
      }
    }

    // --- 3. 檢查是否為「課表」查詢指令 (模糊匹配，支援指定日期與相對週次) ---
    const isScheduleQuery = (text.includes('課表') || text.includes('訓練表')) && text.length < 15;

    if (isScheduleQuery) {
      // 判斷查詢意圖的指定日期或週次偏移
      let targetDate = new Date();
      let targetWeekName = '本週';
      let isSpecificQuery = false; // 是否為非「本週」的明確查詢

      // 擷取指定日期 (例如 "3/5" 或 "03/05" 或 "3月5日")
      const dateMatch = text.match(/([01]?\d)[/月]([0-3]?\d)/);
      if (dateMatch) {
        const m = parseInt(dateMatch[1], 10);
        const d = parseInt(dateMatch[2], 10);
        targetDate.setMonth(m - 1, d);
        targetWeekName = `${m}/${d}`;
        isSpecificQuery = true;
      } else if (text.includes('下') || text.includes('明') || text.includes('次') || text.toLowerCase().includes('next')) {
        targetDate.setDate(targetDate.getDate() + 7);
        targetWeekName = '下週';
        isSpecificQuery = true;
      } else if (text.includes('上') || text.includes('前') || text.toLowerCase().includes('last')) {
        targetDate.setDate(targetDate.getDate() - 7);
        targetWeekName = '上週';
        isSpecificQuery = true;
      }

      // 1. 優先查記憶體快取中對應日期的課表
      let parsed = getThisWeekSchedule(sourceId, targetDate);

      // 若找的是本週且沒找到，才 fallback 到 getLatestSchedule (如果是找未來或過去就不要 fallback)
      if (!parsed && !isSpecificQuery) {
        parsed = getLatestSchedule(sourceId);
      }

      // 2. 如果快取沒了 (例如部署重啟)，嘗試從對話紀錄中「救援」最近貼過的課表
      if (!parsed) {
        console.log(`[課表救援] 來源 ${sourceId} 快取為空，嘗試從對話紀錄中搜尋課表文字...`);
        const history = getUserHistory(userId);
        // 由新到舊找，看有沒有人傳過課表文字
        for (let i = history.length - 1; i >= 0; i--) {
          const pastText = history[i].content;
          if (isTrainingSchedule(pastText)) {
            const rescued = parseSchedule(pastText);
            if (rescued) {
              cacheSchedule(sourceId, rescued); // 放回該來源的快取
              // 重新檢查這個救回來的是不是我們要的那個日期
              if (isDateInPeriod(rescued.periodStr, targetDate) || !isSpecificQuery) {
                console.log(`[課表救援] 成功救回並匹配到 ${targetWeekName} 課表:`, rescued.weekLabel);
                parsed = rescued;
              }
              break;
            }
          }
        }
      }

      if (parsed) {
        const isTargetWeek = isDateInPeriod(parsed.periodStr, targetDate);
        const promptIntro = isTargetWeek
          ? `Bello, ${displayName}! 🍌 幫你找到${targetWeekName} (${parsed.periodStr}) 的課表了！`
          : `Bello, ${displayName}! 🍌 目前沒找到指定時間的課表，但教練幫你挖出最近一份紀錄 (${parsed.weekLabel})。`;

        const quickReplyItems = buildGroupQuickReply(parsed.groups);
        return sendMessage({
          type: 'text',
          text: `${promptIntro}\n\n請選擇組別 👇`,
          quickReply: {
            items: quickReplyItems
          }
        });
      } else {
        // 真的找不到了
        return sendMessage({ type: 'text', text: '史都華教練的記憶體還沒存到這週的訓練週期課表耶～請把整份課表再貼給我一次吧！' });
      }
    }

    // --- 4. 偵測是否為原始課表文字 (如是，解析並存入快取與 JSON) ---
    if (isTrainingSchedule(text)) {
      console.log('偵測到訓練週期課表，開始解析...');
      const parsed = parseSchedule(text);
      if (parsed && parsed.groups.length > 0) {
        cacheSchedule(sourceId, parsed);
        const groupNames = parsed.groups.map(g => `${g.name}組`).join('、');
        const quickReplyItems = buildGroupQuickReply(parsed.groups);
        return sendMessage({
          type: 'text',
          text: `Bello, ${displayName}! 🍌 收到 ${parsed.weekLabel} 的課表了！\n\n偵測到全馬組有：${groupNames}\n\n請選擇你要看哪一組的 200m 操場換算 👇`,
          quickReply: {
            items: quickReplyItems
          }
        });
      }
      // 解析失敗就當作普通文字交給 AI 處理
    }

    // --- 3. 判斷是否為 Strava 分享連結 ---
    const stravaRegex = /(?:https?:\/\/)?(?:www\.)?(?:strava\.com\/activities\/\d+|strava\.app\.link\/\w+)/i;
    const stravaMatch = text.match(stravaRegex);
    if (stravaMatch) {
      console.log('偵測到 Strava 分享連結，開始解析:', stravaMatch[0]);
      const stravaStats = await extractStravaStats(stravaMatch[0]);
      promptText = text;
      if (stravaStats) {
        systemContextText = `${stravaStats}\n\n【重要指令】：分析以上用戶傳來的 Strava 運動數據，明確針對「他/該位跑者」進行數據分析（如距離、配速等）。請發揮史都華教練的專業、正向與同理心性格，給予有溫度且幽默的鼓勵與指導。絕對不要把這份數據當成是你自己的！`;
      }
    } else {
      // 判斷是否在詢問特定地點的餐廳
      const realRestaurantsStr = await extractRealRestaurants(text);
      promptText = text;
      if (realRestaurantsStr) {
        systemContextText = `${realRestaurantsStr}\n\n【重要指令】：請你「唯一且絕對必須」從以上提供的【真實世界餐廳清單】中，依照你史都華的口吻包裝推薦給使用者 ${displayName}，不要自己憑空捏造名單！如果清單為空，請回報找不到這附近營業中的好餐廳。`;
      }
    }
  } else if (event.message.type === 'image') {
    // 收到圖片，委派給圖片處理模組
    try {
      const base64Str = await downloadAndCompress(blobClient, event.message.id);
      const textWithImage = (event.message.text || '').trim();
      const realRestaurantsStr = await extractRealRestaurants(textWithImage);

      // 產生圖片系統指令
      const triggerKeywords = ['史都華', 'stuart', 'Stuart', 'stu', 'Stu'];
      const isTriggered = (textWithImage && triggerKeywords.some(key => textWithImage.includes(key)));
      const imgSystemContext = buildImageSystemContext(textWithImage, isTriggered, event.source.type !== 'user', realRestaurantsStr);

      // 加入批次佇列
      return enqueueImage({
        userId, sourceId, base64Str, textWithImage, imgSystemContext, displayName, client
      });

    } catch (e) {
      console.error('無法下載圖片內容:', e.message);
      return sendMessage({ type: 'text', text: '抱歉，教練的老花眼沒看清楚這張圖，請再傳一次！' });
    }
  } else if (event.message.type === 'sticker') {
    // 忽略貼圖，不佔用 API 與干擾對話
    return Promise.resolve(null);
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

  // 取得 AI 回覆，支援傳入 Base64 圖片與使用者的 userId (作對話記憶快取使用)
  // 將隱藏指令 (systemContext) 獨立為第5個參數傳遞，避免被記錄進使用者的對話快取歷史中
  const finalSystemContext = `目前的對話者是 ${displayName}。${systemContextText || ''}`;
  const aiResponse = await generateChatReply(promptText, imageBase64, userId, displayName, finalSystemContext);

  let messagesToSend = [];

  // 嘗試解析為 Flex Message (針對美食推薦的卡片輪播轉換)
  const flexMessages = tryParseFlexResponse(aiResponse);
  if (flexMessages) {
    messagesToSend = flexMessages;
  } else {
    // 正常聊天對話
    messagesToSend = [{ type: 'text', text: aiResponse }];
  }

  return sendMessage(messagesToSend);
}

async function handlePostback(event, client, blobClient) {
  // 純對話模式下暫不處理 postback
  return Promise.resolve(null);
}

/** 處理加入群組或新成員加入事件 */
async function handleJoin(event, client) {
  // 如果事件發生在群組或聊天室內
  if (event.source.type === 'group' || event.source.type === 'room') {
    const welcomeMsg = "Bello~ 🍌 \n\n小小兵史都華 (Stuart) 降臨啦！\n平時我會安靜地在旁邊吃香蕉，但只要你們在對話中提到「史都華」或者是叫我「stu」，我就會跳出來給你們最嚴峻的配速建議或是幫忙找吃的！\n\n快點給我 Banana 試試看吧！😎";
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: welcomeMsg }]
    }).catch(e => console.log('歡迎訊息發送失敗:', e.message));
  }
  return Promise.resolve(null);
}

module.exports = { handleMessage, handlePostback, handleJoin };
