/**
 * LINE Flex Message 組裝模組
 * 負責將餐廳資料轉換為精美的 Flex Carousel 卡片
 */

/**
 * 將餐廳 JSON 陣列組裝為 LINE Flex Carousel Bubbles
 * @param {Array} restaurants - 餐廳資料陣列 (包含 name, rating, price, item, mapUrl)
 * @returns {Array} LINE Flex Bubble 陣列 (最多 10 張)
 */
function buildRestaurantCarousel(restaurants) {
    return restaurants.slice(0, 10).map(r => {
        let safeMapUrl = r.mapUrl || '';
        try {
            // 利用 new URL() 自動將其中的中文字元等進行 URL Encode 處理
            safeMapUrl = new URL(safeMapUrl).href;
            if (!safeMapUrl.startsWith('http://') && !safeMapUrl.startsWith('https://')) {
                throw new Error('不合法的 URL Protocol');
            }
        } catch (e) {
            // 若解析失敗，則組裝一個保證合法的 Search URL
            const fallbackName = r.name || '餐廳';
            safeMapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fallbackName)}`;
        }

        // 限制 URI 長度為 1000 以內 (LINE Messaging API 限制)
        if (safeMapUrl.length > 1000) {
            safeMapUrl = safeMapUrl.slice(0, 1000);
        }

        return {
            type: 'bubble',
            body: {
                type: 'box',
                layout: 'vertical',
                spacing: 'sm',
                contents: [
                    { type: 'text', text: r.name || '未知名稱', weight: 'bold', size: 'xl', wrap: true },
                    { type: 'text', text: '⭐ ' + (r.rating || '無'), size: 'sm', color: '#888888' },
                    { type: 'text', text: '💰 ' + (r.price || '無'), size: 'sm', color: '#888888' },
                    { type: 'text', text: '🍜 ' + (r.item || '無'), size: 'sm', color: '#444444', wrap: true }
                ]
            },
            footer: {
                type: 'box',
                layout: 'vertical',
                contents: [
                    {
                        type: 'button',
                        style: 'primary',
                        color: '#03C755',
                        action: {
                            type: 'uri',
                            label: 'Google Map 導航',
                            uri: safeMapUrl
                        }
                    }
                ]
            }
        };
    });
}

/**
 * 嘗試將 AI 回應解析為 Flex Message + 純文字的訊息陣列
 * @param {string} aiResponse - AI 回應原文
 * @returns {Array|null} 訊息陣列，或 null 表示非 Flex 格式
 */
function tryParseFlexResponse(aiResponse) {
    const jsonMatch = aiResponse.match(/```(?:json)?\n([\s\S]*?)\n```/i);
    if (!jsonMatch) return null;

    try {
        const restaurants = JSON.parse(jsonMatch[1]);
        const introText = aiResponse.replace(jsonMatch[0], '').trim();
        const messages = [];

        // 若教練有講前情提要，把它當作第一則訊息
        if (introText) {
            messages.push({ type: 'text', text: introText });
        }

        const bubbles = buildRestaurantCarousel(restaurants);
        if (bubbles.length > 0) {
            messages.push({
                type: 'flex',
                altText: '史都華 (Stuart) 為你找了幾家好吃的 Banana! (請在手機看)',
                contents: {
                    type: 'carousel',
                    contents: bubbles
                }
            });
        }

        return messages.length > 0 ? messages : null;
    } catch (e) {
        console.log('Flex Message 解析失敗，降級為純文字輸出', e.message);
        return null;
    }
}

module.exports = {
    buildRestaurantCarousel,
    tryParseFlexResponse
};
