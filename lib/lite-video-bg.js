const { verifyPlaybackToken, getPlaybackTokenTtlSeconds } = require('./playback-token');

const DEFAULT_BG_API_URL = 'https://api.miaomc.cn/image/get';
const DEFAULT_TIMEOUT_MS = 8000;

const bindings = new Map();

function isHttpUrl(value) {
  const str = String(value || '').trim();
  return /^https?:\/\//i.test(str);
}

function getApiUrl() {
  const raw = String(process.env.LITE_VIDEO_BG_API_URL || '').trim();
  return isHttpUrl(raw) ? raw : DEFAULT_BG_API_URL;
}

function getTimeoutMs() {
  const raw = parseInt(process.env.LITE_VIDEO_BG_API_TIMEOUT_MS, 10);
  if (!Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1000, Math.min(30000, raw));
}

function parseJsonImageUrl(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const direct = [obj.url, obj.image, obj.img, obj.src, obj.data && obj.data.url, obj.data && obj.data.image]
    .map((v) => String(v || '').trim())
    .find((v) => isHttpUrl(v));
  return direct || '';
}

async function fetchImageUrlFromApi(apiUrl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(apiUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'MusicForUrl/1.0 (+lite-video-bg)',
        'Accept': 'application/json,text/plain,image/*,*/*;q=0.8'
      }
    });

    if (!res.ok) {
      throw new Error(`BG API HTTP ${res.status}`);
    }

    const finalUrl = String(res.url || '').trim();
    const contentType = String(res.headers.get('content-type') || '').toLowerCase();

    if (isHttpUrl(finalUrl) && contentType.startsWith('image/')) {
      return finalUrl;
    }

    const body = await res.text();

    if (contentType.includes('application/json') || body.trim().startsWith('{') || body.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(body);
        const parsedUrl = parseJsonImageUrl(parsed);
        if (parsedUrl) return parsedUrl;
      } catch (_) {
      }
    }

    const plain = body.trim();
    if (isHttpUrl(plain)) return plain;

    if (isHttpUrl(finalUrl)) return finalUrl;

    throw new Error('BG API response does not contain a valid image URL');
  } finally {
    clearTimeout(timer);
  }
}

function getTokenExpiryMs(token) {
  const verified = verifyPlaybackToken(token || '');
  if (verified.ok && Number.isFinite(verified.expiresAt)) {
    return verified.expiresAt * 1000;
  }

  const ttl = getPlaybackTokenTtlSeconds();
  return Date.now() + Math.max(30, ttl) * 1000;
}

function cleanupExpired(now) {
  const at = Number.isFinite(now) ? now : Date.now();
  for (const [key, value] of bindings.entries()) {
    if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= at) {
      bindings.delete(key);
    }
  }
}

async function getOrBindBg({ token, playlistId, source, fallbackUrl }) {
  const now = Date.now();
  const rawToken = String(token || '').trim();
  const fallback = isHttpUrl(fallbackUrl) ? String(fallbackUrl).trim() : '';

  if (!rawToken) {
    return fallback;
  }

  cleanupExpired(now);

  const existed = bindings.get(rawToken);
  if (existed && existed.url && existed.expiresAt > now) {
    return existed.url;
  }

  let picked = fallback;

  try {
    const apiUrl = getApiUrl();
    const timeoutMs = getTimeoutMs();
    const randomUrl = await fetchImageUrlFromApi(apiUrl, timeoutMs);
    if (isHttpUrl(randomUrl)) {
      picked = randomUrl;
    }
  } catch (e) {
    if (!picked) {
      // 无可回退时保持空字符串
      picked = '';
    }
  }

  const expiresAt = Math.max(now + 1000, getTokenExpiryMs(rawToken));

  bindings.set(rawToken, {
    url: picked,
    playlistId: String(playlistId || ''),
    source: String(source || ''),
    expiresAt
  });

  return picked;
}

function __resetForTests() {
  bindings.clear();
}

module.exports = {
  DEFAULT_BG_API_URL,
  DEFAULT_TIMEOUT_MS,
  getOrBindBg,
  __resetForTests
};
