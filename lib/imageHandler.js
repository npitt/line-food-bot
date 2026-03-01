/**
 * 圖片訊息處理模組
 * 負責圖片下載、壓縮、多圖批次佇列、群組過濾等邏輯
 */
const sharp = require('sharp');
const { generateChatReply } = require('./gemini');
const { IMAGE_MAX_WIDTH, IMAGE_QUALITY, IMAGE_BATCH_DELAY } = require('./constants');

// 儲存正在收集的多張圖片批次處理器 (以 userId 為 Key)
const imageBatchQueue = new Map();

/**
 * 下載並壓縮 LINE 圖片訊息
 * @param {Object} blobClient - LINE Blob API Client
 * @param {string} messageId - 訊息 ID
 * @returns {string} Base64 壓縮後圖片字串
 */
async function downloadAndCompress(blobClient, messageId) {
    if (!blobClient) throw new Error('Blob Client 未初始化');

    const stream = await blobClient.getMessageContent(messageId);
    const chunks = [];
    // LINE v9+ 回傳的是 Web ReadableStream，在 Node 中需稍微不同處理
    for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
    }
    const rawBuffer = Buffer.concat(chunks);

    // 利用 sharp 將圖片壓縮大小與品質，降低記憶體和 API 負載
    const compressedBuffer = await sharp(rawBuffer)
        .resize({ width: IMAGE_MAX_WIDTH, withoutEnlargement: true }) // 將最大寬度限制在 1024px
        .jpeg({ quality: IMAGE_QUALITY }) // 轉為 JPEG 格式並且壓縮至 80% 畫質
        .toBuffer();

    return compressedBuffer.toString('base64');
}

/**
 * 產生圖片的系統指令 Context
 * @param {string} textWithImage - 使用者附帶的文字
 * @param {boolean} isTriggered - 是否被關鍵字觸發
 * @param {boolean} isGroupChat - 是否在群組內
 * @param {string} restaurantsStr - 已查詢到的餐廳字串
 * @returns {string} 系統指令文字
 */
function buildImageSystemContext(textWithImage, isTriggered, isGroupChat, restaurantsStr) {
    let ctx = '';

    if (!isTriggered && isGroupChat) {
        ctx = `【群組圖像過濾指令】：如果這是一般的生活閒聊圖片，且看起來跟「運動紀錄」、「馬拉松」或是「跑步教練的人設」完全無關，請你直接且只能回覆『[IGNORE]』，絕對不要講任何其他廢話。如果是運動截圖，再用教練的角度回應。`;
    } else {
        ctx = `【教練視覺指令】：請幫我分析這張/這些圖片。如果是餐點，請用美食家角度給建議；如果是運動數據或跑錶截圖，請用教練角度給予充滿溫度、同理心與幽默感的專業鼓勵。特別注意：如果截圖或數據中有顯示「特定的人名」，請針對「該跑者」分析。`;
    }

    if (textWithImage) {
        ctx += `\n\n[使用者附註了文字]：${textWithImage}`;
        if (restaurantsStr) {
            ctx += `\n\n${restaurantsStr}\n【重要指令】：請唯一且絕對從以上提供的真實餐廳中揀選推薦，不要憑空捏造！`;
        }
    }

    return ctx;
}

/**
 * 處理圖片訊息的批次佇列邏輯
 * @param {Object} params - 參數物件
 * @returns {Promise} 解析後的 Promise
 */
function enqueueImage(params) {
    const { userId, sourceId, base64Str, textWithImage, imgSystemContext, displayName, client } = params;
    const batchKey = userId;
    if (!batchKey) return Promise.resolve(null);

    if (!imageBatchQueue.has(batchKey)) {
        imageBatchQueue.set(batchKey, {
            images: [],
            texts: [],
            systemContexts: [],
            targetId: sourceId
        });
    }

    const batchData = imageBatchQueue.get(batchKey);
    batchData.images.push(base64Str);
    if (textWithImage) batchData.texts.push(textWithImage);
    if (imgSystemContext) batchData.systemContexts.push(imgSystemContext);

    // 每次收到同使用者的連發圖片，重新計算 1500 毫秒的 Timeout
    if (batchData.timer) clearTimeout(batchData.timer);

    batchData.timer = setTimeout(async () => {
        const finalBatch = imageBatchQueue.get(batchKey);
        imageBatchQueue.delete(batchKey);

        if (!finalBatch || finalBatch.images.length === 0) return;

        const combinedPrompt = finalBatch.texts.length > 0
            ? `請幫我分析這 ${finalBatch.images.length} 張圖。使用者說：\n` + finalBatch.texts.join('\n')
            : `請幫我分析這 ${finalBatch.images.length} 張圖。`;

        // 刪除重複的 context 避免 AI 錯亂
        const combinedContext = [...new Set(finalBatch.systemContexts)].join('\n\n');

        try {
            await client.showLoadingAnimation({ chatId: finalBatch.targetId, loadingSeconds: 20 });
        } catch (e) { /* ignore */ }

        // 交給 AI 進行綜合多圖分析
        const replyMessage = await generateChatReply(
            combinedPrompt,
            finalBatch.images,
            batchKey,
            displayName,
            combinedContext
        );

        if (replyMessage && replyMessage.trim() !== '[IGNORE]') {
            try {
                await client.pushMessage({
                    to: finalBatch.targetId,
                    messages: [{ type: 'text', text: replyMessage.trim() }]
                });
            } catch (err) {
                console.error('Batch Push Message Error:', err?.originalError?.response?.data || err.message);
            }
        }
    }, 1500);

    // 圖片的回覆完全交由 setTimeout 背景推播處理，當前 webhook 事件即刻返回 null
    return Promise.resolve(null);
}

module.exports = {
    downloadAndCompress,
    buildImageSystemContext,
    enqueueImage
};
