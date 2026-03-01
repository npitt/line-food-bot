const fs = require('fs');
const path = require('path');
const { SCHEDULE_CACHE_TTL, SCHEDULE_CLEANUP } = require('./constants');

// 資料目錄：優先使用環境變數 DATA_DIR，預設為 /tmp (Zeabur 容器可寫)
const DATA_DIR = process.env.DATA_DIR || '/tmp';
const DB_PATH = path.resolve(DATA_DIR, 'schedules.json');

// 暫存已解析的課表 (結構: Map<sourceId, Map<period, entry>>)
// sourceId 可能是 groupId、roomId 或 userId
const storageBySource = new Map();

/**
 * 載入持久化存儲的課表
 */
function loadSchedulesFromDB() {
    try {
        if (fs.existsSync(DB_PATH)) {
            const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
            // data 結構: { sourceId: { period: entry, ... }, ... }
            for (const [sourceId, periodsMap] of Object.entries(data)) {
                const innerMap = new Map();
                for (const [period, entry] of Object.entries(periodsMap)) {
                    // 過濾掉明顯太舊的資料 (超過一個月就不載入)
                    if (Date.now() - entry.timestamp < 30 * 24 * 60 * 60 * 1000) {
                        innerMap.set(period, entry);
                    }
                }
                if (innerMap.size > 0) {
                    storageBySource.set(sourceId, innerMap);
                }
            }
            console.log(`[系統通知] 載入共 ${storageBySource.size} 個來源單位的歷史課表。`);
        }
    } catch (e) {
        console.warn('[系統警告] 載入 schedules.json 失敗:', e.message);
    }
}

/**
 * 將目前課表快取存回持久化檔案
 */
function saveSchedulesToDB() {
    try {
        const rootObj = {};
        const now = Date.now();

        for (const [sourceId, periodsMap] of storageBySource) {
            // 找出該來源下最新的一筆更新紀錄
            const latestEntryTimestamp = Math.max(...Array.from(periodsMap.values()).map(e => e.timestamp));

            // 如果該來源下所有內容都超過一年沒動作，則不寫入檔案 (即變相清除)
            if (now - latestEntryTimestamp > SCHEDULE_CLEANUP) {
                console.log(`[維護清理] 來源 ${sourceId} 已超過一年無動作，正式移除其課表內容。`);
                storageBySource.delete(sourceId);
                continue;
            }

            rootObj[sourceId] = Object.fromEntries(periodsMap);
        }
        fs.writeFileSync(DB_PATH, JSON.stringify(rootObj, null, 2), 'utf8');
    } catch (e) {
        console.warn('[系統警告] 儲存 schedules.json 失敗:', e.message);
    }
}

// 啟動時立即載入
loadSchedulesFromDB();

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
    // 放寬空白限制，容忍 Week9 和 02/23 之間有多個空白字元
    const weekMatch = text.match(/(Week\s*\d+)\s+([\d/]+\s*[~-]\s*[\d/]+)/i);
    const weekLabel = weekMatch ? weekMatch[1].trim() : '本週';
    const periodStr = weekMatch ? weekMatch[2].replace(/\s+/g, '') : null;

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
            target: `SUB ${match[2]} `,
            index: match.index
        });
    }

    // 也要處理 "S SUB" 的情況 (S 組前面有行首)
    const sMatch = fullMarathonBlock.match(/^S\s+SUB\s*([\d:~]+)/m);
    if (sMatch && !groupHeaders.find(g => g.name === 'S')) {
        groupHeaders.unshift({
            name: 'S',
            target: `SUB ${sMatch[1]} `,
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
        const reps = repsMax ? `${repsMin} ~${repsMax} ` : repsMin;

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
        ? `${group.lapTimes[0]} ~ ${group.lapTimes[group.lapTimes.length - 1]} 秒`
        : `${group.lapTimes[0]} 秒`;

    const paceStr = group.paces.length > 1
        ? `@${group.paces[0]} ~ ${group.paces[group.paces.length - 1]}/km`
        : `@${group.paces[0]}/km`;

    let result = `🏃 ${parsed.weekLabel} 全馬${groupName}組\n`;
    result += `🎯 ${group.target}\n`;
    result += `━━━━━━━━━━━━━━\n`;
    result += `📋 間歇：${group.distance}m × ${group.reps}\n`;
    result += `⏱ 配速：${paceStr}\n`;
    result += `🔄 200m：${lapTimeStr}\n`;
    result += `😮‍💨 恢復：${group.rest}\n`;
    result += `━━━━━━━━━━━━━━\n`;
    result += `📐 ${group.distance}m = ${group.lapsPerRep} 圈\n`;
    result += `💡 配速(秒/km) ÷ 5 = 200m 秒數`;

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
function cacheSchedule(sourceId, parsed) {
    if (!parsed.periodStr || !sourceId) return;

    let periodsMap = storageBySource.get(sourceId);
    if (!periodsMap) {
        periodsMap = new Map();
        storageBySource.set(sourceId, periodsMap);
    }

    const entry = {
        data: parsed,
        timestamp: Date.now()
    };

    periodsMap.set(parsed.periodStr, entry);
    saveSchedulesToDB(); // 持久化存儲
}

/**
 * 檢查給定的週期字串是否包含目標日期
 * @param {string} periodStr - 格式範例: "02/23-03/01"
 * @param {Date} targetDate - 要檢查的目標日期 (若不傳則預設為今天)
 */
function isDateInPeriod(periodStr, targetDate) {
    if (!periodStr) return false;
    try {
        const parts = periodStr.split(/[\s~-]/).filter(Boolean);
        if (parts.length !== 2) return false;

        const baseDate = targetDate ? new Date(targetDate) : new Date();
        const currentYear = baseDate.getFullYear();

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
            if (baseDate.getMonth() < 2) start.setFullYear(currentYear - 1);
            else end.setFullYear(currentYear + 1);
        }

        return baseDate >= start && baseDate <= end;
    } catch (e) {
        return false;
    }
}

/**
 * 從快取取得已解析的課表 (相容舊邏輯，改為依來源抓取最新)
 */
function getCachedSchedule(sourceId) {
    return getLatestSchedule(sourceId);
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
 * 取得特定來源「本週」或「最接近現在」的課表
 */
function getLatestSchedule(sourceId) {
    if (!sourceId) return null;
    const periodsMap = storageBySource.get(sourceId);
    if (!periodsMap || periodsMap.size === 0) return null;

    // 1. 優先找日期符合今天的
    for (const [period, entry] of periodsMap.entries()) {
        if (isDateInPeriod(period)) return entry.data;
    }

    // 2. 若沒找到本週的，回傳最後一份存入的
    const sortedEntries = Array.from(periodsMap.values())
        .sort((a, b) => b.timestamp - a.timestamp);

    return sortedEntries.length > 0 ? sortedEntries[0].data : null;
}

/**
 * 取得特定來源包含目標日期的課表 (嚴格判定日期)
 * @param {string} sourceId - 來源 ID
 * @param {Date} targetDate - 目標日期
 */
function getThisWeekSchedule(sourceId, targetDate) {
    if (!sourceId) return null;
    const periodsMap = storageBySource.get(sourceId);
    if (!periodsMap) return null;

    for (const [period, entry] of periodsMap.entries()) {
        if (isDateInPeriod(period, targetDate)) return entry.data;
    }
    return null;
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
