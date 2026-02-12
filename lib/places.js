/**
 * Google Geocoding + Places API (Legacy) 整合
 * 需啟用：Geocoding API、Places API (Legacy)
 */
const fetch = require('node-fetch');

const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const NEARBY_URL = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';

/** 料理類型對應 Google keyword（搜尋用） */
const CUISINE_KEYWORDS = {
  中式: '中餐 中式',
  日式: '日式 日本料理',
  韓式: '韓式 韓式料理',
  西式: '西式 西餐',
  泰式: '泰式 泰國料理',
  咖啡甜點: '咖啡 甜點 下午茶',
  素食: '素食 蔬食',
  不限: '',
};

/** 價位對應 API：0=便宜 1=平價 2=中等 3=貴 4=高級 */
const PRICE_MAP = {
  便宜: { minprice: 0, maxprice: 1 },
  中等: { minprice: 1, maxprice: 2 },
  高價: { minprice: 2, maxprice: 4 },
  不限: {},
};

/**
 * 將地址或地點名稱轉成經緯度
 */
async function geocodeAddress(address) {
  if (!GOOGLE_API_KEY) throw new Error('未設定 GOOGLE_PLACES_API_KEY');
  const url = `${GEOCODE_URL}?address=${encodeURIComponent(address)}&language=zh-TW&key=${GOOGLE_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK' || !data.results?.length) {
    return null;
  }
  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng, formatted: data.results[0].formatted_address };
}

/**
 * 搜尋附近餐廳
 * @param {{ lat: number, lng: number }} location
 * @param {{ cuisine?: string, price?: string, minRating?: number }} preferences
 */
async function searchNearbyRestaurants(location, preferences = {}) {
  if (!GOOGLE_API_KEY) throw new Error('未設定 GOOGLE_PLACES_API_KEY');
  const { lat, lng } = location;
  const { cuisine = '不限', price = '不限', minRating } = preferences;

  const params = new URLSearchParams({
    location: `${lat},${lng}`,
    radius: '1500',
    type: 'restaurant',
    language: 'zh-TW',
    key: GOOGLE_API_KEY,
  });

  const keyword = CUISINE_KEYWORDS[cuisine] || CUISINE_KEYWORDS['不限'];
  if (keyword) params.set('keyword', keyword);

  const { minprice, maxprice } = PRICE_MAP[price] || {};
  if (minprice !== undefined) params.set('minprice', minprice);
  if (maxprice !== undefined) params.set('maxprice', maxprice);

  const url = `${NEARBY_URL}?${params.toString()}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(data.error_message || data.status);
  }

  let list = (data.results || []).map((p) => ({
    name: p.name,
    rating: p.rating,
    user_ratings_total: p.user_ratings_total || 0,
    vicinity: p.vicinity,
    place_id: p.place_id,
    lat: p.geometry?.location?.lat,
    lng: p.geometry?.location?.lng,
    price_level: p.price_level,
  }));

  if (minRating != null && minRating > 0) {
    list = list.filter((p) => p.rating != null && p.rating >= minRating);
  }

  list.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  return list.slice(0, 5);
}

module.exports = { geocodeAddress, searchNearbyRestaurants, CUISINE_KEYWORDS, PRICE_MAP };
