const fetch = require('node-fetch');

/**
 * 計算陣列平均值
 */
function calculateAverage(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const valid = arr.filter(n => typeof n === 'number' && !isNaN(n));
    if (valid.length === 0) return null;
    const sum = valid.reduce((acc, val) => acc + val, 0);
    return Math.round(sum / valid.length);
}

/**
 * 取得天氣資訊 (使用 Open-Meteo API，免費無金鑰限制)
 * @param {number} lat 緯度
 * @param {number} lng 經度
 * @param {string} localTimeStr 當地時間字串 (例: "2026-03-01T09:36:46" 或 "2026-03-01T09:36:46Z")
 */
async function fetchWeather(lat, lng, localTimeStr) {
    try {
        const dateObj = new Date(localTimeStr);
        if (isNaN(dateObj.getTime())) return null;

        const dateStr = localTimeStr.split('T')[0];
        const hour = dateObj.getHours();

        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=temperature_2m,relative_humidity_2m,weathercode&start_date=${dateStr}&end_date=${dateStr}&timezone=auto`;
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            },
            timeout: 5000
        });
        if (!res.ok) return null;

        const data = await res.json();
        if (data && data.hourly && data.hourly.temperature_2m) {
            const temp = data.hourly.temperature_2m[hour];
            const humid = data.hourly.relative_humidity_2m[hour];
            const code = data.hourly.weathercode[hour];

            let cond = "晴朗/多雲";
            if (code >= 50 && code <= 69) cond = "雨天";
            else if (code >= 70 && code <= 79) cond = "雪天";
            else if (code >= 80 && code <= 82) cond = "陣雨";
            else if (code >= 95) cond = "雷雨";

            return `氣溫 ${temp}°C, 濕度 ${humid}%, ${cond}`;
        }
    } catch (err) {
        console.log('取得 Open-Meteo 天氣失敗:', err.message);
    }
    return null;
}

/**
 * 給定一個可能是 Strava 分享網址的字串，進行發送請求並解析網頁
 */
async function extractStravaStats(url) {
    if (!url) return '';
    url = url.trim();

    if (!/(strava\.app\.link|strava\.com\/activities)/i.test(url)) {
        return '';
    }

    try {
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
            },
            timeout: 5000
        });

        if (!res.ok) {
            console.log(`Strava 網址解析失敗，HTTP 狀態碼: ${res.status}`);
            return '';
        }

        const html = await res.text();

        // 1. 萃取 OGP 摘要 (基本資料)
        let title = '';
        const titleMatch = html.match(/<meta\s+(?:property|name)="og:title"\s+content="([^"]+)"/i) ||
            html.match(/<meta\s+content="([^"]+)"\s+(?:property|name)="og:title"/i);
        if (titleMatch && titleMatch[1]) {
            title = titleMatch[1].replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
        }

        let description = '';
        const descMatch = html.match(/<meta\s+(?:property|name)="og:description"\s+content="([^"]+)"/i) ||
            html.match(/<meta\s+content="([^"]+)"\s+(?:property|name)="og:description"/i);
        if (descMatch && descMatch[1]) {
            description = descMatch[1].replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
        }

        // 2. 嘗試解析 React 隱藏 State 以取得進階數據 (Elev, HR, Cadence, Weather)
        let advancedStats = [];
        const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);

        if (nextDataMatch && nextDataMatch[1]) {
            try {
                const nextData = JSON.parse(nextDataMatch[1]);
                const activity = nextData?.props?.pageProps?.activity;

                if (activity) {
                    // 跑者姓名 (Athlete Name)
                    if (activity.athlete) {
                        const runnerName = `${activity.athlete.lastName || ''} ${activity.athlete.firstName || ''}`.trim();
                        if (runnerName) {
                            advancedStats.push(`跑者: ${runnerName}`);
                        }
                    }

                    // 距離、時間、爬升 (Scalars)
                    if (activity.scalars) {
                        if (activity.scalars.distance) {
                            const distKm = (activity.scalars.distance / 1000).toFixed(2);
                            advancedStats.push(`距離: ${distKm} km`);

                            // 藉由 distance 與 movingTime 算配速
                            if (activity.scalars.movingTime) {
                                const timeSecs = activity.scalars.movingTime;
                                const paceSecs = Math.round(timeSecs / (activity.scalars.distance / 1000));
                                const paceMins = Math.floor(paceSecs / 60);
                                const paceRemainSecs = (paceSecs % 60).toString().padStart(2, '0');
                                advancedStats.push(`配速: ${paceMins}:${paceRemainSecs} /km`);

                                const timeMins = Math.floor(timeSecs / 60);
                                const timeHrs = Math.floor(timeMins / 60);
                                const remainMins = timeMins % 60;
                                advancedStats.push(`移動時間: ${timeHrs > 0 ? timeHrs + 'h ' : ''}${remainMins}m`);
                            }
                        }

                        if (activity.scalars.elevationGain !== undefined) {
                            advancedStats.push(`總爬升: ${activity.scalars.elevationGain}m`);
                        }
                    }

                    // 步頻、心率、功率 (從 streams 擷取並算平均)
                    if (activity.streams) {
                        const avgHr = calculateAverage(activity.streams.heartrate);
                        if (avgHr) advancedStats.push(`平均心率: ${avgHr} bpm`);

                        const avgCadence = calculateAverage(activity.streams.cadence);
                        if (avgCadence) {
                            // Strava 步頻如果是跑步通常是單腳，因此乘以 2 換算成大眾熟悉的 SPM
                            // 這裡直接提供原始值跟兩倍值給 AI 判斷
                            advancedStats.push(`平均步頻(單/雙腳): ${avgCadence} / ${avgCadence * 2} spm`);
                        }

                        const avgWatts = calculateAverage(activity.streams.watts);
                        if (avgWatts) advancedStats.push(`平均功率: ${avgWatts} W`);
                    }

                    // 天氣 (Weather)
                    if (activity.weather) {
                        advancedStats.push(`天氣: ${activity.weather}`);
                    } else if (activity.streams && activity.streams.location && activity.streams.location.length > 0 && activity.startLocal) {
                        // 如果 Strava 沒記天氣，嘗試用當地時間與座標打外部 API 查天氣
                        const startLoc = activity.streams.location[0]; // { lat, lng }
                        if (startLoc.lat && startLoc.lng) {
                            const extWeather = await fetchWeather(startLoc.lat, startLoc.lng, activity.startLocal);
                            if (extWeather) advancedStats.push(`(外部氣象局) 當時天氣: ${extWeather}`);
                        }
                    }
                }
            } catch (e) {
                console.log('解析 Strava 進階資料 JSON 失敗:', e.message);
            }
        }

        if (!title && !description) {
            console.log('Strava 網頁未截獲有效的 OGP tag');
            return '';
        }

        let result = `[這是一份 Strava 的運動紀錄數據]\n活動名稱：${title || '無標題'}\n基本防護數據：${description || '無摘要'}`;
        if (advancedStats.length > 0) {
            result += `\n進階教練分析數據：${advancedStats.join(', ')}`;
        }

        console.log(`[Strava 解析成功] 標題: ${title}`);
        return result;

    } catch (err) {
        console.error('Strava 網址解析發生例外錯誤:', err.message);
        return '';
    }
}

module.exports = {
    extractStravaStats
};
