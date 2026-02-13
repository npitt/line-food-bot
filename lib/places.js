/**
 * 免費方案：OpenStreetMap Nominatim（地理編碼）+ Overpass API（附近餐廳）
 * 不需 API 金鑰、不需付費。無 Google 評分，僅顯示店名、地址與導航連結。
 */
const fetch = require('node-fetch');

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

const NOMINATIM_HEADERS = {
  'User-Agent': 'LINEFoodBot/1.0 (https://github.com/line-food-bot)',
};

/** 料理類型對應 OSM cuisine 或名稱關鍵字（用於篩選） */
const CUISINE_KEYWORDS = {
  中式: ['chinese', '中式', '中餐', '台灣', '台菜', '麵', '飯'],
  日式: ['japanese', '日式', '日本', '拉麵', '壽司', '丼'],
  韓式: ['korean', '韓式', '韓國', '烤肉'],
  西式: ['western', '西式', '西餐', '義大利', 'pizza', 'pasta', 'american'],
  泰式: ['thai', '泰式', '泰國'],
  咖啡甜點: ['coffee', 'cake', 'cafe', '咖啡', '甜點', '下午茶', '烘焙'],
  素食: ['vegetarian', 'vegan', '素食', '蔬食'],
  不限: [],
};

/** 價位：OSM 無標準欄位，僅保留選項不篩選 */
const PRICE_MAP = { 便宜: {}, 中等: {}, 高價: {}, 不限: {} };

/**
 * 將地址或地點名稱轉成經緯度（Nominatim，免費）
 */
async function geocodeAddress(address) {
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(address)}&format=json&limit=1`;
  const res = await fetch(url, { headers: NOMINATIM_HEADERS });
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  return {
    lat: parseFloat(first.lat),
    lng: parseFloat(first.lon),
    formatted: first.display_name || address,
  };
}

/**
 * 搜尋附近餐廳（Overpass API，免費）
 * 無評分、無價位篩選，可依料理關鍵字篩選
 */
async function searchNearbyRestaurants(location, preferences = {}) {
  const { lat, lng } = location;
  const { cuisine = '不限', price = '不限', minRating } = preferences;

  const radius = 1500;
  const query = `[out:json];
(node["amenity"~"restaurant|cafe|fast_food"](around:${radius},${lat},${lng});
 way["amenity"~"restaurant|cafe|fast_food"](around:${radius},${lat},${lng});
);
out body;
>;
out skel qt;`;

  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
  });
  const data = await res.json();
  if (!data.elements || !data.elements.length) return [];

  const points = [];
  const nodeIds = new Set();
  const wayCenters = new Map();

  for (const el of data.elements) {
    if (el.type === 'node' && el.lat != null && el.lon != null) {
      const name = el.tags?.name || el.tags?.brand || '未命名';
      if (!name || name === '未命名') continue;
      const cuisineTag = (el.tags?.cuisine || '').toLowerCase();
      const nameLower = name.toLowerCase();
      const keywords = CUISINE_KEYWORDS[cuisine] || [];
      if (keywords.length) {
        const match = keywords.some(
          (k) => nameLower.includes(k.toLowerCase()) || cuisineTag.includes(k.toLowerCase())
        );
        if (!match) continue;
      }
      nodeIds.add(el.id);
      points.push({
        name,
        vicinity: [el.tags?.['addr:street'], el.tags?.['addr:housenumber']].filter(Boolean).join(' ') || '',
        lat: el.lat,
        lng: el.lon,
        rating: null,
        user_ratings_total: 0,
      });
    }
    if (el.type === 'way' && el.center) {
      const name = el.tags?.name || el.tags?.brand || '未命名';
      if (!name || name === '未命名') continue;
      const cuisineTag = (el.tags?.cuisine || '').toLowerCase();
      const nameLower = name.toLowerCase();
      const keywords = CUISINE_KEYWORDS[cuisine] || [];
      if (keywords.length) {
        const match = keywords.some(
          (k) => nameLower.includes(k.toLowerCase()) || cuisineTag.includes(k.toLowerCase())
        );
        if (!match) continue;
      }
      wayCenters.set(el.id, {
        name,
        vicinity: [el.tags?.['addr:street'], el.tags?.['addr:housenumber']].filter(Boolean).join(' ') || '',
        lat: el.center.lat,
        lng: el.center.lon,
      });
    }
  }

  for (const [_, p] of wayCenters) {
    points.push({
      name: p.name,
      vicinity: p.vicinity,
      lat: p.lat,
      lng: p.lng,
      rating: null,
      user_ratings_total: 0,
    });
  }

  const withDistance = points.map((p) => ({
    ...p,
    _dist: Math.hypot(p.lat - lat, p.lng - lng),
  }));
  withDistance.sort((a, b) => a._dist - b._dist);
  return withDistance.slice(0, 5).map(({ _dist, ...rest }) => rest);
}

module.exports = { geocodeAddress, searchNearbyRestaurants, CUISINE_KEYWORDS, PRICE_MAP };
