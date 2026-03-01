const activeApiKey = process.env.GOOGLE_PLACES_API_KEY;

/**
 * 透過 Google Places Text Search API 尋找附近的餐廳
 * @param {string} queryText - 使用者輸入的地點或欲搜尋的目標
 * @returns {Promise<string[]>} - 回傳格式化後的餐廳名單字串陣列
 */
async function searchNearbyRestaurants(queryText) {
    if (!activeApiKey) {
        throw new Error('未設定 GOOGLE_PLACES_API_KEY');
    }

    try {
        const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
        url.searchParams.append('query', `${queryText} 附近美食 餐廳`);
        url.searchParams.append('type', 'restaurant');
        url.searchParams.append('opennow', 'true');
        url.searchParams.append('language', 'zh-TW');
        url.searchParams.append('key', activeApiKey);

        const response = await fetch(url.href);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        const results = data.results;
        if (!results || results.length === 0) {
            return [];
        }

        // 進行簡易品質過濾：只挑選評分大於等於 4.0 且至少有 10 則評論的店家
        const highQualityRestaurants = results.filter(
            (r) => r.rating >= 4.0 && r.user_ratings_total >= 10
        );

        // 取前 5 家最好的推薦給教練
        const topPicks = highQualityRestaurants.slice(0, 5);

        return topPicks.map((r) => {
            // 組裝給 AI 參考的精簡字串
            const name = r.name;
            const rating = `${r.rating}顆星 (${r.user_ratings_total}則評論)`;
            const priceLevel = r.price_level ? '💰'.repeat(r.price_level) : '未知';
            const address = r.formatted_address;
            const status = r.opening_hours?.open_now ? '營業中' : '目前休息';
            const mapUrl = `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${r.place_id}`;

            return `店名: ${name} | 評分: ${rating} | 價位: ${priceLevel} | 狀態: ${status} | 地址: ${address} | 導航: ${mapUrl}`;
        });
    } catch (error) {
        console.error('Google Places API 請求失敗:', error.message);
        throw new Error('搜尋真實餐廳發生錯誤');
    }
}

module.exports = { searchNearbyRestaurants };
