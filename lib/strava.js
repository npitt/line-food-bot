const fetch = require('node-fetch');

/**
 * 給定一個可能是 Strava 分享網址的字串，進行發送請求並解析 OGP 標籤 (og:title / og:description)
 * 藉由解析 OGP 來無須 API 認證取得該活動摘要 (例如: 距離、配速、時間)
 * @param {string} url Strava 分享網址 (例: https://strava.app.link/... 或 https://www.strava.com/activities/...)
 * @returns {Promise<string>} 回傳組合後的摘要文字，若失敗則回傳空字串
 */
async function extractStravaStats(url) {
    if (!url) return '';
    url = url.trim();

    // 檢查是否包含 strava 網域特徵
    if (!/(strava\.app\.link|strava\.com\/activities)/i.test(url)) {
        return '';
    }

    try {
        // 發送帶有常見 User-Agent 的請求，避免被輕易拒絕
        // node-fetch 預設會自動 follow redirects (處理 .app.link 轉址)
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
            },
            timeout: 5000 // 設定 5 秒 timeout，避免卡死
        });

        if (!res.ok) {
            console.log(`Strava 網址解析失敗，HTTP 狀態碼: ${res.status}`);
            return '';
        }

        const html = await res.text();

        // 解析 <meta property="og:title" content="...">
        let title = '';
        const titleMatch = html.match(/<meta\s+(?:property|name)="og:title"\s+content="([^"]+)"/i) ||
            html.match(/<meta\s+content="([^"]+)"\s+(?:property|name)="og:title"/i);
        if (titleMatch && titleMatch[1]) {
            // 處理像是 "&#x27;" 這類的簡單 HTML Entity
            title = titleMatch[1].replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
        }

        // 解析 <meta property="og:description" content="...">
        let description = '';
        const descMatch = html.match(/<meta\s+(?:property|name)="og:description"\s+content="([^"]+)"/i) ||
            html.match(/<meta\s+content="([^"]+)"\s+(?:property|name)="og:description"/i);

        if (descMatch && descMatch[1]) {
            description = descMatch[1].replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
        }

        if (!title && !description) {
            console.log('Strava 網頁未截獲有效的 OGP tag');
            return '';
        }

        console.log(`[Strava 解析成功]: ${title} / ${description}`);
        return `[這是一份 Strava 的運動紀錄數據]\n活動名稱：${title || '無標題'}\n數據摘要：${description || '無摘要'}`;

    } catch (err) {
        console.error('Strava 網址解析發生例外錯誤:', err.message);
        return '';
    }
}

module.exports = {
    extractStravaStats
};
