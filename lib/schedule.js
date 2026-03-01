/**
 * 課表解析與 200m 操場換算模組
 * 偵測使用者傳來的訓練週期課表，解析全馬組各組別的週四間歇配速，
 * 並換算成興雅國中 200m 操場每圈所需秒數。
 */

// 暫存已解析的課表 (以「日期區間串」為 Key，例如 "02/23-03/01")
// 同時保留一份全域最晚貼出的課表快取
const schedulesByPeriod = new Map();
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 課表快取延長至 7 天 (因為是一週一份)

/**
 * 偵測訊息是否為訓練週期課表
 */
function isTrainingSchedule(text) {
    if (!text || text.length < 100) return false;
    // 課表通常包含這些特徵關鍵字
    const keywords = ['訓練週期', '全馬組', 'SUB', '週四', 'warm up', 'freejog'];
    const matchCount = keywords.filter(k => text.includes(k)).length;
    // 至少命中 3 個關鍵字才算是課表
    return matchCount >= 3;
}

/**
 * 將配速字串 (如 "04:00" 或 "03:50") 轉換成秒數
 */
function paceToSeconds(paceStr) {
    const cleaned = paceStr.replace(/[^\d:]/g, '').trim();
    const parts = cleaned.split(':');
    if (parts.length !== 2) return null;
    const mins = parseInt(parts[0], 10);
    const secs = parseInt(parts[1], 10);
    if (isNaN(mins) || isNaN(secs)) return null;
    return mins * 60 + secs;
}

/**
 * 將每公里秒數換算成每 200m 秒數
 */
function paceToLapTime(paceSeconds) {
    return Math.round(paceSeconds / 5);
}

/**
 * 解析課表文字，提取全馬組各組別的週四間歇資料
 * @param {string} text 完整課表文字
 * @returns {Object} { weekLabel, groups: [{ name, interval, paces, lapTimes, rest }] }
 */
function parseSchedule(text) {
    // 抓取週數標題與日期週期 (如 "Week9  02/23-03/01")
    const weekMatch = text.match(/(Week\s*\d+\s+([\d/]+[\s~-]*[\d/]+))/i);
    const weekLabel = weekMatch ? weekMatch[1].trim() : '本週';
    const periodStr = weekMatch ? weekMatch[2].trim() : null;

    // 截取全馬組區塊 (從 "全馬組" 到 "半馬組" 之前，或到文末)
    const fullMarathonMatch = text.match(/全馬組[\s\S]*?(?=半馬組|$)/);
    if (!fullMarathonMatch) return null;
    const fullMarathonBlock = fullMarathonMatch[0];

    // 用組別標頭拆分各組 (S, A, B, C, D, E, F, G, H, I)
    // 模式：行首的 S/A/B... 後面接 SUB
    const groupPattern = /^([A-IＡ-Ｉ])\s*SUB\s*([\d:~]+)/gm;
    const groupHeaders = [];
    let match;
    while ((match = groupPattern.exec(fullMarathonBlock)) !== null) {
        // 將全形英文轉為半形
        let name = match[1].replace(/[Ａ-Ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
        groupHeaders.push({
            name: name,
            target: `SUB ${match[2]}`,
            index: match.index
        });
    }

    // 也要處理 "S SUB" 的情況 (S 組前面有行首)
    const sMatch = fullMarathonBlock.match(/^S\s+SUB\s*([\d:~]+)/m);
    if (sMatch && !groupHeaders.find(g => g.name === 'S')) {
        groupHeaders.unshift({
            name: 'S',
            target: `SUB ${sMatch[1]}`,
            index: fullMarathonBlock.indexOf(sMatch[0])
        });
    }

    // 按出現順序排序
    groupHeaders.sort((a, b) => a.index - b.index);

    const groups = [];

    for (let i = 0; i < groupHeaders.length; i++) {
        const start = groupHeaders[i].index;
        const end = i < groupHeaders.length - 1 ? groupHeaders[i + 1].index : fullMarathonBlock.length;
        const block = fullMarathonBlock.substring(start, end);

        // 抓取週四間歇資料 (特徵：1200 x N 或 800 x N)
        const intervalMatch = block.match(/(1200|800)\s*[xX×]\s*(\d+)(?:\s*~\s*(\d+))?\s*@\s*([\d:~!]+)\/km/);
        if (!intervalMatch) continue;

        const distance = intervalMatch[1]; // 1200 或 800
        const repsMin = intervalMatch[2];
        const repsMax = intervalMatch[3] || null;
        const reps = repsMax ? `${repsMin}~${repsMax}` : repsMin;

        // 解析配速 (可能是範圍如 "03:50~03:45" 或單一如 "05:00")
        let paceRaw = intervalMatch[4].replace(/!/g, '1'); // 修正常見 typo (04:!5 → 04:15)
        const paceRange = paceRaw.split('~').map(p => p.trim());

        const paces = paceRange.map(p => ({
            display: p.includes(':') ? p : null,
            seconds: paceToSeconds(p)
        })).filter(p => p.seconds);

        const lapTimes = paces.map(p => paceToLapTime(p.seconds));

        // 抓取休息時間
        const restMatch = block.match(/R\s*[:：]\s*([\d''"]+)/);
        const rest = restMatch ? restMatch[1].replace(/['']/g, "'").replace(/[""]/g, '"') : '?';

        groups.push({
            name: groupHeaders[i].name,
            target: groupHeaders[i].target,
            distance: distance,
            reps: reps,
            paces: paces.map(p => p.display),
            lapTimes: lapTimes,
            rest: rest,
            lapsPerRep: distance === '1200' ? 6 : 4
        });
    }

    if (groups.length === 0) return null;

    return { weekLabel, periodStr, groups };
}

/**
 * 將單一組別的資料格式化成使用者友善的文字回覆
 */
function formatGroupResult(parsed, groupName) {
    const group = parsed.groups.find(g => g.name === groupName);
    if (!group) return null;

    const lapTimeStr = group.lapTimes.length > 1
        ? `${group.lapTimes[0]}~${group.lapTimes[group.lapTimes.length - 1]} 秒`
        : `${group.lapTimes[0]} 秒`;

    const paceStr = group.paces.length > 1
        ? `@${group.paces[0]}~${group.paces[group.paces.length - 1]}/km`
        : `@${group.paces[0]}/km`;

    let result = `🏃 ${parsed.weekLabel} 全馬${groupName}組\n`;
    result += `🎯 目標：${group.target}\n\n`;
    result += `| 項目 | 內容 |\n`;
    result += `| :--- | :--- |\n`;
    result += `| 📋 間歇 | ${group.distance}m × ${group.reps} |\n`;
    result += `| ⏱ 配速 | ${paceStr} |\n`;
    result += `| 🔄 200m | **${lapTimeStr}** |\n`;
    result += `| 😮‍💨 休息 | ${group.rest} |\n\n`;
    result += `📐 註：${group.distance}m = ${group.lapsPerRep} 圈\n`;
    result += `💡 公式：配速(秒/km) ÷ 5 = 200m 秒數`;

    return result;
}

/**
 * 產生 LINE Quick Reply 按鈕陣列 (讓使用者選擇組別)
 */
function buildGroupQuickReply(groups) {
    return groups.map(g => ({
        type: 'action',
        action: {
            type: 'message',
            label: `${g.name}組 ${g.target}`,
            text: `課表${g.name}組`
        }
    }));
}

/**
 * 儲存解析結果到快取
 */
function cacheSchedule(userId, parsed) {
    if (!parsed.periodStr) return;

    const entry = {
        data: parsed,
        timestamp: Date.now()
    };

    // 以日期區間作為唯一標識，避免同一週課表重複存多份，但也允許存不同週
    schedulesByPeriod.set(parsed.periodStr, entry);
}

/**
 * 檢查給定的週期字串是否包含今天
 * 格式範例: "02/23-03/01"
 */
function isDateInPeriod(periodStr) {
    if (!periodStr) return false;
    try {
        const parts = periodStr.split(/[\s~-]/).filter(Boolean);
        if (parts.length !== 2) return false;

        const now = new Date();
        const currentYear = now.getFullYear();

        const parseDate = (str) => {
            const [m, d] = str.split('/').map(Number);
            // 處理跨年問題 (如果結束月份小於起始月份，代表跨年)
            return new Date(currentYear, m - 1, d);
        };

        let start = parseDate(parts[0]);
        let end = parseDate(parts[1]);
        end.setHours(23, 59, 59, 999);

        // 如果 end 比 start 小，且現在是年初，可能是去年底貼的
        if (end < start) {
            if (now.getMonth() < 2) start.setFullYear(currentYear - 1);
            else end.setFullYear(currentYear + 1);
        }

        return now >= start && now <= end;
    } catch (e) {
        return false;
    }
}

/**
 * 從快取取得已解析的課表 (相容舊邏輯，改為抓取全域最新)
 */
function getCachedSchedule(userId) {
    return getLatestSchedule();
}

/**
 * 檢查訊息是否為組別選擇指令 (如 "課表A組")
 */
function isGroupSelection(text) {
    if (!text) return null;
    const match = text.match(/課表\s*([A-ISa-is])\s*組/i);
    if (match) return match[1].toUpperCase();
    return null;
}

/**
 * 取得「本週」或「最接近現在」的課表
 */
function getLatestSchedule() {
    // 2. 若沒找到本週的，回傳最後一份存入的
    const sortedEntries = Array.from(schedulesByPeriod.values())
        .sort((a, b) => b.timestamp - a.timestamp);

    return sortedEntries.length > 0 ? sortedEntries[0].data : null;
}

module.exports = {
    isTrainingSchedule,
    parseSchedule,
    formatGroupResult,
    buildGroupQuickReply,
    cacheSchedule,
    getCachedSchedule,
    isGroupSelection,
    getLatestSchedule,
    getThisWeekSchedule,
    isDateInPeriod
};
