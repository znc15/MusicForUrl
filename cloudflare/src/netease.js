import CryptoJS from 'crypto-js';
import forge from 'node-forge';
import QRCode from 'qrcode';

const API_DOMAIN = 'https://interface.music.163.com';
const WEB_DOMAIN = 'https://music.163.com';
const IV = '0102030405060708';
const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const EAPI_KEY = 'e82ckenh8dichen8';
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

function cookieMap(cookie) {
  const map = new Map();
  for (const part of String(cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    if (key) map.set(key, part.slice(index + 1).trim());
  }
  return map;
}

function mergeCookies(...values) {
  const cookies = new Map();
  for (const value of values) {
    for (const [key, item] of cookieMap(value)) cookies.set(key, item);
  }
  return Array.from(cookies, ([key, value]) => `${key}=${value}`).join('; ');
}

function getSetCookies(headers) {
  const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  if (values.length) return values.map((value) => value.split(';')[0]);
  const combined = headers.get('set-cookie');
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,\s]+=)/).map((value) => value.split(';')[0].trim());
}

function aesEncrypt(text, key, mode, iv = '') {
  const encrypted = CryptoJS.AES.encrypt(
    CryptoJS.enc.Utf8.parse(text), CryptoJS.enc.Utf8.parse(key), {
      iv: CryptoJS.enc.Utf8.parse(iv),
      mode: mode === 'ECB' ? CryptoJS.mode.ECB : CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    },
  );
  return mode === 'ECB' ? encrypted.ciphertext.toString().toUpperCase() : encrypted.toString();
}

function weapiForm(data) {
  const random = crypto.getRandomValues(new Uint8Array(16));
  const secret = Array.from(random, (byte) => BASE62[byte % BASE62.length]).join('');
  const first = aesEncrypt(JSON.stringify(data), PRESET_KEY, 'CBC', IV);
  const params = aesEncrypt(first, secret, 'CBC', IV);
  const encrypted = forge.pki.publicKeyFromPem(PUBLIC_KEY).encrypt(secret.split('').reverse().join(''), 'NONE');
  return new URLSearchParams({ params, encSecKey: forge.util.bytesToHex(encrypted) });
}

function eapiForm(uri, data) {
  const body = JSON.stringify(data);
  const digest = CryptoJS.MD5(`nobody${uri}use${body}md5forencrypt`).toString();
  const value = `${uri}-36cd479b6b5-${body}-36cd479b6b5-${digest}`;
  return new URLSearchParams({ params: aesEncrypt(value, EAPI_KEY, 'ECB') });
}

async function requestNetease(uri, data = {}, { cookie = '', mode = 'eapi' } = {}) {
  const saved = cookieMap(cookie);
  const csrf = saved.get('__csrf') || '';
  let url;
  let form;
  let outboundCookie;

  if (mode === 'weapi') {
    url = `${WEB_DOMAIN}/weapi/${uri.slice(5)}`;
    form = weapiForm({ ...data, csrf_token: csrf });
    outboundCookie = mergeCookies(cookie, '__remember_me=true', 'os=pc');
  } else {
    url = `${API_DOMAIN}/eapi/${uri.slice(5)}`;
    const header = {
      osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
      os: 'pc',
      appver: '3.1.17.204416',
      versioncode: '140',
      channel: 'netease',
      requestId: `${Date.now()}_${Math.floor(Math.random() * 1000).toString().padStart(4, '0')}`,
      __csrf: csrf,
    };
    if (saved.has('MUSIC_U')) header.MUSIC_U = saved.get('MUSIC_U');
    if (saved.has('MUSIC_A')) header.MUSIC_A = saved.get('MUSIC_A');
    form = eapiForm(uri, { ...data, e_r: false, header });
    outboundCookie = Object.entries(header).map(([key, value]) =>
      `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    ).join('; ');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': mode === 'weapi'
        ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'
        : 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)',
      referer: WEB_DOMAIN,
      cookie: outboundCookie,
    },
    body: form.toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`网易云接口 HTTP ${response.status}`);
  const body = await response.json();
  return { body, cookie: mergeCookies(cookie, ...getSetCookies(response.headers)) };
}

function artists(track) {
  return (track?.ar || track?.artists || []).map((artist) => artist?.name).filter(Boolean).join('/');
}

function duration(track) {
  const milliseconds = Number(track?.dt ?? track?.duration ?? 0);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? Math.round(milliseconds / 1000) : 0;
}

async function createQRCode() {
  const result = await requestNetease('/api/login/qrcode/unikey', { type: 3 });
  const key = result.body?.unikey;
  if (!key) throw new Error('获取网易云二维码失败');
  const qrurl = `${WEB_DOMAIN}/login?codekey=${encodeURIComponent(key)}`;
  const svg = await QRCode.toString(qrurl, { type: 'svg', width: 256, margin: 2 });
  return { key, qrimg: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
}

async function checkQRCode(key) {
  const result = await requestNetease('/api/login/qrcode/client/login', { key, type: 3 });
  return { code: result.body?.code, message: result.body?.message, cookie: result.cookie };
}

async function checkLoginStatus(cookie) {
  const result = await requestNetease('/api/w/nuser/account/get', {}, { cookie, mode: 'weapi' });
  const profile = result.body?.profile;
  const account = result.body?.account;
  if (!profile || !account) return { logged: false };
  return {
    logged: true,
    userId: String(profile.userId ?? account.id),
    nickname: profile.nickname || '',
    avatar: profile.avatarUrl || '',
    vipType: Number(profile.vipType) || 0,
  };
}

async function sendCaptcha(phone) {
  const result = await requestNetease('/api/sms/captcha/sent', {
    ctcode: '86', secrete: 'music_middleuser_pclogin', cellphone: phone,
  }, { mode: 'weapi' });
  return result.body?.code === 200;
}

async function loginWithPhone(phone, credential, kind) {
  const data = {
    type: '1', https: 'true', phone, countrycode: '86', remember: 'true',
    ...(kind === 'captcha' ? { captcha: credential } : { password: CryptoJS.MD5(credential).toString() }),
  };
  const result = await requestNetease('/api/w/login/cellphone', data, { mode: 'weapi' });
  if (result.body?.code !== 200 || !result.cookie) {
    throw new Error(result.body?.message || '网易云登录失败');
  }
  return result.cookie;
}

async function getUserPlaylists(userId, cookie) {
  const result = await requestNetease('/api/user/playlist', {
    uid: userId, limit: 1000, offset: 0, includeVideo: true,
  }, { cookie, mode: 'weapi' });
  if (result.body?.code !== 200) throw new Error(result.body?.message || '获取歌单失败');
  const playlists = (result.body.playlist || []).map((playlist) => ({
    id: playlist.id,
    name: playlist.name,
    cover: playlist.coverImgUrl,
    trackCount: playlist.trackCount,
    creator: playlist.creator?.nickname,
    userId: playlist.userId,
    playCount: playlist.playCount,
  }));
  return { playlists, count: result.body.playlistCount ?? playlists.length };
}

async function getPlaylistDetail(playlistId, cookie) {
  const result = await requestNetease('/api/v6/playlist/detail', {
    id: playlistId, n: 100000, s: 8,
  }, { cookie });
  const playlist = result.body?.playlist;
  if (result.body?.code !== 200 || !playlist) {
    throw new Error(result.body?.message || '获取歌单失败');
  }
  const tracks = (playlist.tracks || []).map((track) => ({
    id: track.id,
    name: track.name,
    artist: artists(track),
    duration: duration(track),
    cover: track.al?.picUrl || track.album?.picUrl || '',
  }));
  return {
    id: playlist.id,
    name: playlist.name || '',
    cover: playlist.coverImgUrl || '',
    songCount: Number(playlist.trackCount) || tracks.length,
    tracks,
  };
}

const QUALITY_LEVELS = {
  low: { level: 'standard', bitrate: 128000 },
  medium: { level: null, bitrate: 192000 },
  high: { level: 'exhigh', bitrate: 320000 },
  lossless: { level: 'lossless', bitrate: 999000 },
};

async function getSongUrl(songId, cookie, env) {
  const quality = String(env.MUSIC_QUALITY || 'low').toLowerCase();
  const selected = QUALITY_LEVELS[quality] || QUALITY_LEVELS.low;
  const ids = JSON.stringify([String(songId)]);
  if (selected.level) {
    try {
      const result = await requestNetease('/api/song/enhance/player/url/v1', {
        ids, level: selected.level, encodeType: 'flac',
      }, { cookie });
      const url = result.body?.data?.[0]?.url;
      if (result.body?.code === 200 && url) return url;
    } catch (_) {
      // Older account and regional responses may still require the bitrate endpoint.
    }
  }
  const result = await requestNetease('/api/song/enhance/player/url', {
    ids, br: selected.bitrate,
  }, { cookie });
  if (result.body?.code !== 200) return null;
  return result.body?.data?.[0]?.url || null;
}

export {
  checkLoginStatus, checkQRCode, createQRCode, getPlaylistDetail, getSongUrl,
  getUserPlaylists, loginWithPhone, sendCaptcha,
};
