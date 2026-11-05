/**
 * QQ 音乐 API 封装
 * 参考 jsososo/QQMusicApi 项目的接口调用方式
 * 直接请求 QQ 音乐 Web API 端点，不依赖外部服务
 */

// ─── 常量 ───────────────────────────────────────────────

const MUSICU_FCG = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const QR_SHOW_URL = 'https://ssl.ptlogin2.qq.com/ptqrshow';
const QR_LOGIN_URL = 'https://ssl.ptlogin2.qq.com/ptqrlogin';
const AUTH_URL = 'https://graph.qq.com/oauth2.0/authorize';

const QQ_MUSIC_APPID = '716027609';
const QQ_MUSIC_DAID = '383';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ─── 工具函数 ─────────────────────────────────────────────

function normalizeCookie(cookie) {
  if (!cookie) return '';
  if (Array.isArray(cookie)) return cookie.join('; ');
  return String(cookie);
}

function parseCookieString(cookieStr) {
  const obj = {};
  if (!cookieStr) return obj;
  String(cookieStr).split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) obj[k] = v;
  });
  return obj;
}

function extractUin(cookie) {
  const obj = typeof cookie === 'string' ? parseCookieString(cookie) : cookie;
  let uin = obj.uin || obj.wxuin || obj.o_cookie || '';
  uin = String(uin).replace(/\D/g, '');
  return uin;
}

function extractMusicKey(cookie) {
  const obj = typeof cookie === 'string' ? parseCookieString(cookie) : cookie;
  return obj.qm_keyst || obj.qqmusic_key || '';
}

function buildQQAvatarUrl(uin, size = 100) {
  const cleanUin = String(uin || '').replace(/\D/g, '');
  if (!cleanUin) return '';
  const s = Number.isFinite(Number(size)) ? Math.max(40, Math.min(640, Number(size))) : 100;
  return `https://q1.qlogo.cn/g?b=qq&nk=${cleanUin}&s=${s}`;
}

// Workers 没有 Node 的 Buffer，用分块 btoa 转换二进制，避免一次展开过多参数
function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const CHUNK = 0x2000;
  let binary = '';
  for (let offset = 0; offset < view.length; offset += CHUNK) {
    binary += String.fromCharCode.apply(null, view.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

function hash33(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash += (hash << 5) + str.charCodeAt(i);
  }
  return hash & 0x7fffffff;
}

function getArtists(singers) {
  if (!Array.isArray(singers)) return '';
  return singers.map(s => s?.name || s?.title || '').filter(Boolean).join('/');
}

function getDurationSeconds(interval) {
  if (typeof interval === 'number') return interval;
  if (typeof interval === 'string' && interval.includes(':')) {
    const parts = interval.split(':');
    return (parseInt(parts[0]) || 0) * 60 + (parseInt(parts[1]) || 0);
  }
  const sec = parseInt(interval) || 0;
  return sec;
}

function getCoverUrl(album) {
  if (!album) return '';
  const mid = album.mid || album.pmid || '';
  if (mid) return `https://y.gtimg.cn/music/photo_new/T002R300x300M000${mid}.jpg`;
  return '';
}

function getSetCookieList(headers) {
  if (!headers || typeof headers.getSetCookie !== 'function') return [];
  return headers.getSetCookie();
}

function parseQQJsonPayload(text) {
  const src = String(text || '').trim();
  if (!src) throw new Error('空响应');

  const jsonpMatch = src.match(/^[a-zA-Z0-9_$.]+\(([\s\S]*)\)\s*;?$/);
  const payload = jsonpMatch ? jsonpMatch[1] : src;
  return JSON.parse(payload);
}

function pickQQApiMessage(data) {
  if (!data || typeof data !== 'object') return '';
  const msg = data.message || data.msg || data.errmsg || data.tips || '';
  return typeof msg === 'string' ? msg.trim() : '';
}

function qqAuthorizationError() {
  return Object.assign(new Error('QQ 音乐授权未完成，请重新扫码'), { status: 401 });
}

function authorizationUrl(value, base) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !['ssl.ptlogin2.graph.qq.com', 'ssl.ptlogin2.qq.com', 'graph.qq.com', 'y.qq.com', 'u.y.qq.com'].includes(url.hostname)) {
    throw qqAuthorizationError();
  }
  return url;
}

// 授权跳转期间保留 Cookie 的作用域，避免把 graph / ptlogin 的 host-only 凭据发给音乐域。
function authorizationCookies() {
  const values = new Map();
  return {
    collect(response, source) {
      const url = new URL(source);
      for (const raw of getSetCookieList(response.headers)) {
        const [pair, ...attributes] = String(raw).split(';');
        const split = pair.indexOf('=');
        if (split <= 0) continue;
        const name = pair.slice(0, split).trim();
        const value = pair.slice(split + 1).trim();
        const attrs = new Map(attributes.map(attribute => {
          const separator = attribute.indexOf('=');
          return separator < 0 ? [attribute.trim().toLowerCase(), '']
            : [attribute.slice(0, separator).trim().toLowerCase(), attribute.slice(separator + 1).trim()];
        }));
        const domain = (attrs.get('domain') || url.hostname).replace(/^\./, '').toLowerCase();
        if (!(domain === 'qq.com' || domain.endsWith('.qq.com')) ||
          !(url.hostname === domain || url.hostname.endsWith('.' + domain))) continue;
        const defaultPath = url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/';
        const path = attrs.get('path')?.startsWith('/') ? attrs.get('path') : defaultPath;
        const key = `${domain}:${path}:${name}`;
        const expires = attrs.has('max-age') ? Date.now() + Number(attrs.get('max-age')) * 1000
          : attrs.has('expires') ? Date.parse(attrs.get('expires')) : Infinity;
        if (!value || expires <= Date.now()) { values.delete(key); continue; }
        values.set(key, { name, value, domain, path, hostOnly: !attrs.has('domain'), expires });
      }
    },
    header(target) {
      const url = new URL(target);
      const matching = [...values.values()].filter(cookie => cookie.expires > Date.now() &&
        (url.hostname === cookie.domain || (!cookie.hostOnly && url.hostname.endsWith('.' + cookie.domain))) &&
        (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : cookie.path + '/')))
        .sort((a, b) => b.path.length - a.path.length || b.domain.length - a.domain.length);
      const selected = new Map();
      for (const cookie of matching) if (!selected.has(cookie.name)) selected.set(cookie.name, cookie.value);
      return [...selected].map(([name, value]) => `${name}=${value}`).join('; ');
    },
  };
}

async function followAuthorization(start, cookies) {
  let current = authorizationUrl(start);
  const visited = new Set();
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (visited.has(current.href)) throw qqAuthorizationError();
    visited.add(current.href);
    const cookie = cookies.header(current);
    const response = await qqFetch(current.href, {
      redirect: 'manual', headers: cookie ? { Cookie: cookie } : {},
    });
    cookies.collect(response, current);
    await response.body?.cancel();
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.ok) throw qqAuthorizationError();
      return;
    }
    const location = response.headers.get('location');
    if (!location) throw qqAuthorizationError();
    // 下一跳在任何请求与 Cookie 发送之前校验，支持同域相对 Location。
    current = authorizationUrl(location, current);
  }
  throw qqAuthorizationError();
}

function extractUinFromRedirectUrl(redirectUrl) {
  if (!redirectUrl) return '';
  try {
    const url = new URL(String(redirectUrl));
    const uin = (url.searchParams.get('uin') || '').replace(/\D/g, '');
    return uin;
  } catch (_) {
    return '';
  }
}

function parsePtuiCallbackPayload(text) {
  if (!text) return null;
  const src = String(text);
  const start = src.indexOf('ptuiCB(');
  if (start === -1) return null;

  const argsStart = start + 'ptuiCB('.length;
  let argsEnd = -1;
  let inQuote = false;
  let escaped = false;

  for (let i = argsStart; i < src.length; i++) {
    const ch = src[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === "'") {
      inQuote = !inQuote;
      continue;
    }
    if (ch === ')' && !inQuote) {
      argsEnd = i;
      break;
    }
  }

  if (argsEnd === -1) return null;

  const argsText = src.slice(argsStart, argsEnd);
  const fields = [];
  let current = '';
  inQuote = false;
  escaped = false;

  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];
    if (!inQuote) {
      if (ch === "'") {
        inQuote = true;
        current = '';
      }
      continue;
    }

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === "'") {
      fields.push(current);
      inQuote = false;
      current = '';
      continue;
    }

    current += ch;
  }

  if (fields.length < 5) return null;

  const code = parseInt(fields[0], 10);
  if (!Number.isFinite(code)) return null;

  return {
    code,
    redirectUrl: fields[2] || '',
    message: fields[4] || '',
    nickname: fields[5] || '',
    fields,
  };
}

async function qqFetch(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Referer: 'https://y.qq.com/',
        ...(options.headers || {}),
      },
    });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function musicuRequest(data, cookie = '') {
  const uin = extractUin(cookie);
  const musicKey = extractMusicKey(cookie);

  const reqData = {
    comm: {
      uin: uin ? parseInt(uin) : 0,
      format: 'json',
      ct: 24,
      cv: 0,
      ...(musicKey ? { authst: musicKey } : {}),
    },
    ...data,
  };

  const params = new URLSearchParams({
    '-': 'recom' + Date.now(),
    g_tk: 5381,
    loginUin: uin || '0',
    hostUin: '0',
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: '0',
    platform: 'yqq.json',
    needNewCode: '0',
    data: JSON.stringify(reqData),
  });

  const cookieStr = normalizeCookie(cookie);
  const res = await qqFetch(`${MUSICU_FCG}?${params.toString()}`, {
    headers: {
      ...(cookieStr ? { Cookie: cookieStr } : {}),
    },
  });

  if (!res.ok) throw new Error(`QQ Music API HTTP ${res.status}`);
  return res.json();
}

// ─── QR 码登录 ────────────────────────────────────────────

async function createQRCode() {
  const t = (Math.random()).toFixed(16);
  const url = `${QR_SHOW_URL}?appid=${QQ_MUSIC_APPID}&e=2&l=M&s=3&d=72&v=4&t=${t}&daid=${QQ_MUSIC_DAID}&pt_3rd_aid=100497308`;

  const res = await qqFetch(url);
  if (!res.ok) throw new Error('获取QQ音乐二维码失败');

  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  let qrsig = '';
  for (const c of setCookies) {
    const m = c.match(/qrsig=([^;]+)/);
    if (m) { qrsig = m[1]; break; }
  }

  if (!qrsig) throw new Error('未获取到 qrsig');

  const buf = await res.arrayBuffer();
  const base64 = toBase64(buf);
  const qrimg = `data:image/png;base64,${base64}`;

  return { qrsig, qrimg };
}

async function checkQRCode(qrsig) {
  const ptqrtoken = hash33(qrsig);
  const url = `${QR_LOGIN_URL}?u1=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump&ptqrtoken=${ptqrtoken}&ptredirect=0&h=1&t=1&g=1&from_ui=1&ptlang=2052&action=0-0-${Date.now()}&js_ver=21122200&js_type=1&login_sig=&pt_uistyle=40&aid=${QQ_MUSIC_APPID}&daid=${QQ_MUSIC_DAID}&pt_3rd_aid=100497308&has_signing=1`;

  const res = await qqFetch(url, {
    redirect: 'manual',
    headers: {
      Cookie: `qrsig=${qrsig}`,
    },
  });

  if (!res.ok) throw new Error('QQ 扫码状态服务暂时不可用');

  const text = await res.text();
  const parsed = parsePtuiCallbackPayload(text);
  if (!parsed) return { code: -1, message: '解析响应失败' };

  const code = parsed.code;
  const redirectUrl = parsed.redirectUrl;
  const message = parsed.message;
  const nickname = parsed.nickname;

  // code: 0=成功, 66=未扫码, 67=已扫码未确认, 65=二维码过期
  if (code === 0) {
    try {
      const cookies = authorizationCookies();
      cookies.collect(res, url);
      const confirmedUin = extractUinFromRedirectUrl(redirectUrl) || extractUin(cookies.header(MUSICU_FCG));
      if (redirectUrl) await followAuthorization(redirectUrl, cookies);
      if (!extractMusicKey(cookies.header(MUSICU_FCG))) await authQQMusic(cookies);
      const finalCookie = cookies.header(MUSICU_FCG);
      const finalUin = extractUin(finalCookie);
      if (!/^\d{1,20}$/.test(finalUin) || !extractMusicKey(finalCookie) ||
        (confirmedUin && confirmedUin !== finalUin)) throw qqAuthorizationError();
      return { code: 0, message: '登录成功', cookie: finalCookie, nickname, uin: finalUin };
    } catch (_) {
      throw qqAuthorizationError();
    }
  }

  return { code, message, nickname };
}

async function authQQMusic(cookies) {
  // 通过 QQ 互联授权获取 QQ 音乐 cookie
  const authUrl = `${AUTH_URL}?response_type=code&client_id=100497308&redirect_uri=https%3A%2F%2Fy.qq.com%2Fcgi-bin%2Fmusicu.fcg&scope=all&state=state&display=pc`;

  await followAuthorization(authUrl, cookies);
}

// ─── 登录状态检查 ──────────────────────────────────────────

// 公开资料接口只补充已由二维码确认的身份。调用者必须传入可信 QR 结果，
// 它本身不证明客户端提供的 Cookie 有效。
async function checkLoginStatus(cookie, expectedUin) {
  const uin = extractUin(cookie);
  const musicKey = extractMusicKey(cookie);

  if (!/^\d{1,20}$/.test(uin) || !musicKey || uin !== String(expectedUin || '')) {
    return { logged: false };
  }

  try {
    const result = await musicuRequest({
      req_0: {
        module: 'userInfo.BaseUserInfoServer',
        method: 'get_user_baseinfo_v2',
        param: { vec_uin: [uin] },
      },
    }, cookie);

    const info = result?.req_0?.data?.map_userinfo?.[uin];
    if (result?.code !== 0 || result?.req_0?.code !== 0 || result?.req_0?.data?.code !== 0 ||
      !info || (typeof info.uin === 'number' && !Number.isSafeInteger(info.uin)) || String(info.uin) !== uin) {
      return { logged: false };
    }

    return {
      logged: true,
      userId: uin,
      nickname: info.nick || `QQ用户${uin}`,
      avatar: info.headurl || buildQQAvatarUrl(uin),
      vipType: info.isvip || 0,
    };
  } catch (_) {
    return { logged: false };
  }
}

// ─── 用户歌单 ─────────────────────────────────────────────

async function getUserPlaylists(uin, cookie = '') {
  const params = new URLSearchParams({
    hostUin: '0',
    hostuin: uin,
    sin: '0',
    size: '200',
    g_tk: '5381',
    loginUin: '0',
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: '0',
    platform: 'yqq.json',
    needNewCode: '0',
  });

  const cookieStr = normalizeCookie(cookie);
  const res = await qqFetch(`https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss?${params.toString()}`, {
    headers: {
      Referer: 'https://y.qq.com/portal/profile.html',
      ...(cookieStr ? { Cookie: cookieStr } : {}),
    },
  });

  const text = await res.text();
  const data = parseQQJsonPayload(text);

  if (data.code === 4000) {
    return { playlists: [], hasMore: false, count: 0 };
  }

  if (!data.data || !data.data.disslist) {
    throw new Error(data.msg || '获取QQ音乐用户歌单失败');
  }

  const playlists = data.data.disslist.map(p => ({
    id: String(p.tid || p.dirid),
    name: p.diss_name || '',
    cover: p.diss_cover || '',
    trackCount: p.song_cnt || 0,
    creator: data.data.hostname || '',
    userId: uin,
    playCount: p.listen_num || 0,
  }));

  return {
    playlists,
    hasMore: false,
    count: playlists.length,
  };
}

// ─── 歌单详情 ─────────────────────────────────────────────

async function getPlaylistDetail(disstid, cookie = '') {
  const params = new URLSearchParams({
    type: '1',
    utf8: '1',
    disstid: disstid,
    loginUin: '0',
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: '0',
    platform: 'yqq.json',
    needNewCode: '0',
  });

  const cookieStr = normalizeCookie(cookie);
  const res = await qqFetch(`https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?${params.toString()}`, {
    headers: {
      Referer: 'https://y.qq.com/n/yqq/playlist',
      ...(cookieStr ? { Cookie: cookieStr } : {}),
    },
  });

  const text = await res.text();
  const data = parseQQJsonPayload(text);
  const code = Number(data?.code);
  const subcode = Number(data?.subcode);
  const upstreamMessage = pickQQApiMessage(data);

  const tags = [];
  if (Number.isFinite(code) && code !== 0) tags.push(`code=${code}`);
  if (Number.isFinite(subcode) && subcode !== 0) tags.push(`subcode=${subcode}`);
  const suffix = tags.length ? ` (${tags.join(', ')})` : '';

  if (Number.isFinite(code) && code !== 0) {
    const reason = upstreamMessage || 'QQ歌单不存在或无访问权限';
    throw new Error(`${reason}${suffix}`);
  }

  if (!data.cdlist || !data.cdlist[0]) {
    const reason = upstreamMessage || 'QQ歌单详情为空，可能歌单不存在或无访问权限';
    throw new Error(`${reason}${suffix}`);
  }

  const cd = data.cdlist[0];
  const tracks = (cd.songlist || []).map(t => ({
    id: String(t.songmid || t.mid || t.songid),
    songId: t.songid,
    name: t.songname || t.name || '',
    artist: getArtists(t.singer),
    duration: getDurationSeconds(t.interval || t.duration || 0),
    cover: getCoverUrl(t.album || { mid: t.albummid }),
    mid: t.songmid || t.mid || '',
    mediaMid: t.strMediaMid || t.songmid || t.mid || '',
  }));

  return {
    id: String(disstid),
    name: cd.dissname || cd.nick || '',
    cover: cd.logo || cd.dir_pic_url2 || '',
    songCount: cd.songnum || cd.total_song_num || tracks.length,
    tracks,
  };
}

// ─── 歌曲 URL ─────────────────────────────────────────────

const QQ_QUALITY_MAP = {
  low: { s: 'M500', e: '.mp3' },
  medium: { s: 'M800', e: '.mp3' },
  high: { s: 'M800', e: '.mp3' },
  lossless: { s: 'F000', e: '.flac' },
};

// maxAttempts 默认 3 以保持旧调用方行为；上游明确回复「无 purl」是确定性结果，
// 重试同样的请求不会改变它，调用方可以传 1 省掉两次无效往返。
async function getSongResource(songMid, cookie = '', qualityOverride, maxAttempts = 3) {
  const uin = extractUin(cookie) || '0';
  const musicKey = extractMusicKey(cookie);

  const envQuality = String(qualityOverride ?? globalThis.process?.env?.MUSIC_QUALITY ?? '').toLowerCase().trim();
  const quality = QQ_QUALITY_MAP[envQuality] || QQ_QUALITY_MAP.low;

  const mediaMid = songMid;
  const file = `${quality.s}${songMid}${mediaMid}${quality.e}`;
  const guid = String(Math.floor(Math.random() * 10000000));

  const reqData = {
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        filename: [file],
        guid: guid,
        songmid: [songMid],
        songtype: [0],
        uin: uin,
        loginflag: 1,
        platform: '20',
      },
    },
    comm: {
      uin: uin ? parseInt(uin) : 0,
      format: 'json',
      ct: 19,
      cv: 0,
      ...(musicKey ? { authst: musicKey } : {}),
    },
  };

  const params = new URLSearchParams({
    '-': 'getplaysongvkey',
    g_tk: '5381',
    loginUin: uin,
    hostUin: '0',
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    platform: 'yqq.json',
    needNewCode: '0',
    data: JSON.stringify(reqData),
  });

  const cookieStr = normalizeCookie(cookie);

  let purl = '';
  let domain = '';
  let attempts = 0;

  while (!purl && attempts < maxAttempts) {
    attempts++;
    try {
      const res = await qqFetch(`${MUSICU_FCG}?${params.toString()}`, {
        headers: {
          ...(cookieStr ? { Cookie: cookieStr } : {}),
        },
      });
      const result = await res.json();

      const midurlinfo = result.req_0?.data?.midurlinfo?.[0];
      if (midurlinfo?.purl) {
        purl = midurlinfo.purl;
      } else {
        const code = result.req_0?.code ?? result.code;
        console.warn(`[QQ歌曲URL] 尝试 ${attempts}/${maxAttempts} songMid=${songMid} 失败: code=${code}`);
      }
      if (!domain && result.req_0?.data?.sip) {
        domain = result.req_0.data.sip.find(i => !i.startsWith('http://ws')) || result.req_0.data.sip[0] || '';
      }
    } catch (e) {
      console.error(`[QQ歌曲URL] 尝试 ${attempts}/${maxAttempts} songMid=${songMid} 异常:`, e.message);
    }
  }

  if (!purl) {
    console.warn(`[QQ歌曲URL] 全部失败 songMid=${songMid} uin=${uin} musicKey=${musicKey ? '有' : '无'}`);
    return null;
  }
  return { url: `${domain}${purl}`, format: quality.e === '.flac' ? 'flac' : 'mp3',
    bitrate: quality.s === 'M500' ? 128000 : quality.s === 'M800' ? 320000 : null,
    quality: envQuality || 'low', expiresAt: Date.now() + 90000, trial: false };
}

async function getSongUrl(songMid, cookie = '', qualityOverride, maxAttempts = 3) {
  return (await getSongResource(songMid, cookie, qualityOverride, maxAttempts))?.url || null;
}

// ─── 导出 ─────────────────────────────────────────────────

module.exports = {
  createQRCode,
  checkQRCode,
  checkLoginStatus,
  getUserPlaylists,
  getPlaylistDetail,
  getSongUrl,
  getSongResource,
  extractUin,
  extractUinFromRedirectUrl,
  extractMusicKey,
  buildQQAvatarUrl,
  normalizeCookie,
  parseCookieString,
  parsePtuiCallbackPayload,
};
