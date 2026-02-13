/**
 * 功能測試：Gemini 意圖解析（需設定 GEMINI_API_KEY）
 * 執行：node test/gemini-test.js 或 npm run test:gemini
 */
require('dotenv').config();
const { parseIntent } = require('../lib/gemini');

async function run() {
  if (!process.env.GEMINI_API_KEY) {
    console.log('未設定 GEMINI_API_KEY，略過 Gemini 測試');
    process.exit(0);
    return;
  }

  console.log('--- Gemini 意圖解析 ---');
  const cases = [
    { msg: '台大', state: { hasLocation: false }, expectIntent: 'set_location' },
    { msg: '給我資料呀', state: { hasLocation: true, currentCuisine: '不限' }, expectIntent: 'search' },
    { msg: '信義區日式 幫我找', state: { hasLocation: false }, expectIntent: 'set_location' },
    { msg: '說明', state: { hasLocation: false }, expectIntent: 'help' },
  ];

  let passed = 0;
  let skipped = 0;
  let failed = 0;
  for (const { msg, state, expectIntent } of cases) {
    let warnedQuotaOrRateLimit = false;
    const originalWarn = console.warn;
    console.warn = (...args) => {
      const text = args
        .map((arg) => (typeof arg === 'string' ? arg : String(arg)))
        .join(' ')
        .toLowerCase();
      if (text.includes('429') || text.includes('quota') || text.includes('rate limit')) {
        warnedQuotaOrRateLimit = true;
      }
      originalWarn(...args);
    };

    try {
      const r = await parseIntent(msg, state);
      if (warnedQuotaOrRateLimit) {
        console.log(`  - "${msg}" 略過：Gemini 配額/速率限制 (429)`);
        skipped++;
        continue;
      }
      const ok = r.intent === expectIntent;
      if (ok) {
        console.log(`  ✓ "${msg}" → intent=${r.intent} (location=${r.location || '-'}, cuisine=${r.cuisine || '-'})`);
        passed++;
      } else {
        console.log(`  ✗ "${msg}" 期望 intent=${expectIntent}, 實際 intent=${r.intent}`);
        failed++;
      }
    } catch (e) {
      if (warnedQuotaOrRateLimit) {
        console.log(`  - "${msg}" 略過：Gemini 配額/速率限制 (429)`);
        skipped++;
      } else {
        console.log(`  ✗ "${msg}": ${e.message}`);
        failed++;
      }
    } finally {
      console.warn = originalWarn;
    }
  }

  console.log('\n--- 結果 ---');
  console.log(`通過: ${passed}, 略過: ${skipped}, 失敗: ${failed}`);
  if (failed === 0 && skipped > 0) {
    console.log('(部分案例因 API 配額或速率限制被略過)');
    process.exit(0);
    return;
  }
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
