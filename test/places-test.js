/**
 * 功能測試：地理編碼（Nominatim）與附近餐廳（Overpass）
 * 使用台灣地點驗證服務正常。執行：node test/places-test.js 或 npm test
 */
require('dotenv').config();
const { geocodeAddress, searchNearbyRestaurants } = require('../lib/places');

async function run() {
  let passed = 0;
  let failed = 0;

  console.log('--- 地理編碼（Nominatim）台灣地點 ---');
  const testAddresses = ['台北車站', '台大', '信義區'];
  for (const addr of testAddresses) {
    try {
      const geo = await geocodeAddress(addr);
      if (!geo || typeof geo.lat !== 'number' || typeof geo.lng !== 'number') {
        console.log(`  ✗ ${addr}: 無結果或格式錯誤`);
        failed++;
      } else {
        console.log(`  ✓ ${addr} → ${geo.lat.toFixed(4)}, ${geo.lng.toFixed(4)} (${geo.formatted?.slice(0, 50)}...)`);
        passed++;
      }
    } catch (e) {
      console.log(`  ✗ ${addr}: ${e.message}`);
      failed++;
    }
  }

  console.log('\n--- 附近餐廳（Overpass）---');
  try {
    const geo = await geocodeAddress('台北車站');
    if (!geo) {
      console.log('  跳過（需先有 geocode 結果）');
    } else {
      const list = await searchNearbyRestaurants(
        { lat: geo.lat, lng: geo.lng },
        { cuisine: '不限', price: '不限', minRating: null }
      );
      if (!Array.isArray(list)) {
        console.log('  ✗ 回傳格式錯誤');
        failed++;
      } else {
        console.log(`  ✓ 台北車站附近找到 ${list.length} 筆餐廳`);
        if (list.length > 0) {
          console.log(`    範例: ${list[0].name} ${list[0].vicinity ? `- ${list[0].vicinity}` : ''}`);
        }
        passed++;
      }
    }
  } catch (e) {
    console.log(`  ✗ Overpass 查詢失敗: ${e.message}`);
    failed++;
  }

  console.log('\n--- 結果 ---');
  console.log(`通過: ${passed}, 失敗: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
