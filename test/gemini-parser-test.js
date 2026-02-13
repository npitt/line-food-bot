/**
 * 離線單元測試：Gemini 回應 JSON 解析
 * 執行：node test/gemini-parser-test.js
 */
const { __testOnly_parseIntentFromResponseText } = require('../lib/gemini');

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} (expected=${expected}, actual=${actual})`);
  }
}

function runCase({ name, input, expected }) {
  const result = __testOnly_parseIntentFromResponseText(input);
  assertEqual(result.intent, expected.intent, `${name}: intent mismatch`);
  assertEqual(result.location, expected.location, `${name}: location mismatch`);
  assertEqual(result.cuisine, expected.cuisine, `${name}: cuisine mismatch`);
  assertEqual(result.search_now, expected.search_now, `${name}: search_now mismatch`);
}

function run() {
  const cases = [
    {
      name: 'valid set_location response',
      input: '{"intent":"set_location","location":"信義區","cuisine":"日式","search_now":true}',
      expected: { intent: 'set_location', location: '信義區', cuisine: '日式', search_now: true },
    },
    {
      name: 'invalid intent fallback to unknown',
      input: '{"intent":"go_now","location":"台北車站","cuisine":"中式","search_now":true}',
      expected: { intent: 'unknown', location: '台北車站', cuisine: '中式', search_now: false },
    },
    {
      name: 'invalid cuisine fallback to 不限',
      input: '{"intent":"set_preference","location":null,"cuisine":"義式","search_now":false}',
      expected: { intent: 'set_preference', location: null, cuisine: '不限', search_now: false },
    },
    {
      name: 'search_now only meaningful for set_location',
      input: '{"intent":"search","location":null,"cuisine":"不限","search_now":true}',
      expected: { intent: 'search', location: null, cuisine: '不限', search_now: false },
    },
    {
      name: 'markdown fenced json',
      input: '```json\n{"intent":"help","location":"","cuisine":"不限","search_now":false}\n```',
      expected: { intent: 'help', location: null, cuisine: '不限', search_now: false },
    },
    {
      name: 'invalid json fallback',
      input: 'not a json',
      expected: { intent: 'unknown', location: null, cuisine: null, search_now: false },
    },
  ];

  let passed = 0;
  let failed = 0;

  console.log('--- Gemini 離線解析測試 ---');
  for (const testCase of cases) {
    try {
      runCase(testCase);
      console.log(`  ✓ ${testCase.name}`);
      passed++;
    } catch (error) {
      console.log(`  ✗ ${testCase.name}: ${error.message}`);
      failed++;
    }
  }

  console.log('\n--- 結果 ---');
  console.log(`通過: ${passed}, 失敗: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
