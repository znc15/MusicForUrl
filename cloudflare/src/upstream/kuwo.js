// 酷我音乐游客适配器。
//
// 能力边界（与 platforms.js 的能力矩阵一致）：
//   歌单读取 ⚠️  上游 www.kuwo.cn 的公开接口带风控：必须同时带 Cookie 与与之匹配的
//                csrf 头，且对数据中心 IP 会直接返回 "The request is illegal!"。
//                这里先请求一次页面拿 Cookie 再调用接口；仍然被拒时给出可操作的提示。
//                运维可以用 KUWO_COOKIE 变量直接贴一份浏览器 Cookie 绕过引导。
//   音源解析 ✅  antiserver.kuwo.cn 的转换接口无需登录，支持 128/192/320 kbps 三档。
//   账号接入 ✅  账号密码 / 手机短信登录（kuwo-login.js）。没有扫码登录接口；
//                登录只解决账号身份，音源仍按游客接口解析。
//
// 免费额度约束：读歌单最多 2 次子请求（引导 + 接口），解析音源 1 次。

import { captcha, checkLoginStatus, loginByPassword, loginBySms, sendSms } from './kuwo-login.js';
import { upstreamRequest } from './request.js';

const WEB_ORIGIN = 'https://www.kuwo.cn';
const ANTI_ORIGIN = 'http://antiserver.kuwo.cn';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TOKEN_COOKIE = /^(kw_token|Hm_Iuvt_[A-Za-z0-9]+)$/;
const PLAYLIST_TRACK_LIMIT = 1000;

class KuwoError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'KuwoError';
    this.status = status;
  }
}

const BLOCKED_MESSAGE = '酷我接口拒绝了本次请求（风控）。可以稍后重试，或由部署者设置 KUWO_COOKIE 变量。';

function headers(extra = {}) {
  return { 'user-agent': DESKTOP_UA, accept: 'application/json, text/plain, */*', ...extra };
}

// Workers 里 getSetCookie 是新接口，回退到单值读取以兼容旧运行时
function setCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

function cookiePairs(list) {
  const pairs = new Map();
  for (const entry of list) {
    const pair = String(entry).split(';')[0];
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    pairs.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  return pairs;
}

/**
 * 取一份可用的会话 Cookie。优先用部署者提供的 KUWO_COOKIE（浏览器里复制的那份），
 * 否则匿名请求一次网页，从 Set-Cookie 里捞出 csrf 令牌。
 */
async function session(env) {
  const configured = String(env?.KUWO_COOKIE || '').trim();
  if (configured) return configured;

  const response = await upstreamRequest(`${WEB_ORIGIN}/`,
    { headers: headers({ accept: 'text/html' }), redirect: 'follow' }, { headersOnly: true });
  const pairs = cookiePairs(setCookies(response));
  const name = [...pairs.keys()].find((key) => TOKEN_COOKIE.test(key));
  if (!name) return '';
  return `${name}=${pairs.get(name)}`;
}

function csrfOf(cookie) {
  for (const pair of String(cookie).split(';')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    if (TOKEN_COOKIE.test(name)) return pair.slice(index + 1).trim();
  }
  return '';
}

async function playlistApi(env, playlistId, cookie) {
  const query = new URLSearchParams({
    pid: String(playlistId), pn: '1', rn: String(PLAYLIST_TRACK_LIMIT), httpsStatus: '1',
  });
  const response = await upstreamRequest(`${WEB_ORIGIN}/api/www/playlist/playListInfo?${query}`, {
    headers: headers({
      referer: `${WEB_ORIGIN}/playlist_detail/${playlistId}`,
      ...(cookie ? { cookie, csrf: csrfOf(cookie) } : {}),
    }),
  });
  if (!response.ok) throw new KuwoError(`酷我接口返回 ${response.status}`, 502);
  const body = await response.json().catch(() => null);
  if (!body) throw new KuwoError('酷我接口返回了非 JSON 内容', 502);
  if (body.success === false || body.code === 404) {
    const message = String(body.message || body.error || '');
    if (/illegal|CSRF/i.test(message)) throw new KuwoError(BLOCKED_MESSAGE, 502);
    throw new KuwoError(message || '酷我歌单不存在或已被删除', 404);
  }
  return body.data || body;
}

function coverUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  return value.replace(/^http:\/\//, 'https://');
}

function trackOf(item) {
  const rid = String(item?.rid || item?.id || '').trim();
  if (!/^\d{1,20}$/.test(rid)) return null;
  const duration = Number(item.duration);
  return {
    id: rid,
    name: String(item.name || '').trim(),
    artist: String(item.artist || '').trim(),
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    cover: coverUrl(item.pic || item.albumpic),
  };
}

async function getPlaylistDetail(playlistId, _cookie, env) {
  const cookie = await session(env);
  const data = await playlistApi(env, playlistId, cookie);
  const list = Array.isArray(data.musicList) ? data.musicList : [];

  const seen = new Set();
  const tracks = [];
  for (const item of list) {
    const track = trackOf(item);
    if (!track || seen.has(track.id)) continue;
    seen.add(track.id);
    tracks.push(track);
  }
  if (!tracks.length) throw new KuwoError('这个酷我歌单里没有可播放的歌曲', 404);
  const totalCount = Math.max(Number(data.total) || 0, tracks.length);

  return {
    id: String(playlistId),
    name: String(data.name || '').trim() || `酷我歌单 ${playlistId}`,
    cover: coverUrl(data.pic),
    songCount: totalCount,
    totalCount,
    includedCount: tracks.length,
    partialReason: tracks.length >= totalCount ? null
      : list.length >= PLAYLIST_TRACK_LIMIT ? 'platform_limit' : 'missing_tracks',
    tracks,
  };
}

const BITRATE = { low: 128000, medium: 192000, high: 320000, lossless: 320000 };
const BR_PARAM = { low: '128kmp3', medium: '192kmp3', high: '320kmp3', lossless: '320kmp3' };

async function convertUrl(songId, br) {
  const query = new URLSearchParams({
    type: 'convert_url', rid: `MUSIC_${songId}`, format: 'mp3', br, response: 'url',
  });
  const response = await upstreamRequest(`${ANTI_ORIGIN}/anti.s?${query}`, { headers: headers() }, { maxBytes: 16384 });
  if (!response.ok) return '';
  const text = (await response.text()).trim();
  return /^https?:\/\//i.test(text) ? text : '';
}

async function getSongResource(songId, _cookie, env) {
  const quality = String(env?.MUSIC_QUALITY || 'low').toLowerCase();
  const url = await convertUrl(songId, BR_PARAM[quality] || BR_PARAM.low);
  if (!url) return null;
  return {
    url,
    bitrate: BITRATE[quality] || BITRATE.low,
    format: 'mp3',
    size: 0,
    quality,
    // 直链带时间戳签名，缓存层只保留 90 秒
    expiresAt: Date.now() + 90 * 1000,
  };
}

export {
  BLOCKED_MESSAGE, KuwoError, captcha, checkLoginStatus, getPlaylistDetail, getSongResource,
  loginByPassword, loginBySms, sendSms,
};
