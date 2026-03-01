/**
 * 全域常數集中管理
 * 所有散落各模組的硬編碼常數統一於此定義
 */

module.exports = {
    // === Gemini API 用量控制 ===
    FLASH_LIMIT: 250,               // gemini-2.5-flash 每日免費上限
    FLASH_THRESHOLD: 240,           // 門檻值，達到則降級至 flash-lite (FLASH_LIMIT - 10)

    // === 對話歷史快取 ===
    MAX_HISTORY_LENGTH: 6,          // 記憶最近的 6 句話 (包含一問一答)
    HISTORY_TTL_MS: 30 * 60 * 1000, // 對話快取存活時間：30 分鐘

    // === 課表存儲 ===
    SCHEDULE_CACHE_TTL: 14 * 24 * 60 * 60 * 1000,   // 課表快取：14 天
    SCHEDULE_CLEANUP: 365 * 24 * 60 * 60 * 1000,     // 維護清理：1 年無動作即刪除

    // === 圖片處理 ===
    IMAGE_MAX_WIDTH: 1024,          // 圖片最大寬度 (px)
    IMAGE_QUALITY: 80,              // JPEG 壓縮品質 (%)
    IMAGE_BATCH_DELAY: 1500,        // 多圖批次等待時間 (ms)
};
