// 酷我音乐账号登录（账号密码 / 手机短信）。
//
// 酷我没有扫码登录：站点的登录弹窗只有「账号密码」与「手机短信」两条流程
// （另有微信 / QQ OAuth，回调 Cookie 落在 .kuwo.cn，服务端接不了）。
//
// 流程：
//   1. GET /api/common/captcha/getcode → { img: PNG data URL, token }
//      同一次响应还会下发匿名会话 Cookie（Hm_Iuvt_*），图形验证码 token 与它绑定。
//   2. POST /api/www/login/loginByKw      { userIp, uname, password, verifyCode, verifyCodeToken }
//      或 POST /api/sms/mobileLoginCode   { verifyCode, verifyCodeToken, mobile }
//         → 短信验证码登录 POST /api/www/login/loginByMobile { mobile, verifyCode, smsCode, tm }
//   3. 登录成功的响应直接在 JSON 里返回 cookies 映射（跨域也能读到）。
//
// wapi.kuwo.cn 的登录接口不需要 Web 端的 Secret 签名；www.kuwo.cn 的 /api/* 需要，
// 但图形验证码与短信发送这两个端点实测直接可用（2026-10）。

import { upstreamRequest } from './request.js';

const WWW_ORIGIN = 'https://www.kuwo.cn';
const WAPI_ORIGIN = 'https://wapi.kuwo.cn';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

class KuwoLoginError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'KuwoLoginError';
    this.status = status;
  }
}

function headers(cookie, extra = {}) {
  return {
    'user-agent': DESKTOP_UA,
    accept: 'application/json, text/plain, */*',
    referer: `${WWW_ORIGIN}/`,
    ...(cookie ? { cookie } : {}),
    ...extra,
  };
}

// Workers 里 getSetCookie 是新接口，回退到单值读取以兼容旧运行时
function setCookies(response) {
  const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  if (list.length) return list;
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

function cookiePairs(list) {
  return list.map((value) => String(value).split(';')[0].trim()).filter(Boolean).join('; ');
}

function withQuery(path) {
  const params = new URLSearchParams({
    reqId: crypto.randomUUID(), httpsStatus: '1',
  });
  return `${path}?${params.toString()}`;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new KuwoLoginError('酷我登录接口返回了非 JSON 内容');
  }
}

/** 取一张图形验证码：img 可直接给 <img>，token 与 cookie 必须原样带回登录请求。 */
async function captcha() {
  const response = await upstreamRequest(`${WWW_ORIGIN}/api/common/captcha/getcode`, { headers: headers() });
  if (!response.ok) throw new KuwoLoginError(`酷我验证码接口返回 ${response.status}`);
  const body = await readJson(response);
  const img = body?.data?.img;
  const token = body?.data?.token;
  if (!img || !token) throw new KuwoLoginError('获取酷我验证码失败');
  return { img: String(img), token: String(token), cookie: cookiePairs(setCookies(response)) };
}

const ERROR_MESSAGES = {
  '-10001': '用户名或密码错误，请重新输入',
  '-102': '图形验证码错误，请刷新后重试',
  1108: '短信验证码错误，请重新输入',
  1107: '短信验证码已过期，请重新输入',
  1100: '请输入符合中国大陆的手机号',
  1157: '请勿在 30 天内频繁注册',
};

function messageOf(body) {
  const code = String(body?.code ?? '');
  return ERROR_MESSAGES[code] || String(body?.msg || '').trim() || '酷我登录失败';
}

function cookiesOf(body) {
  const map = body?.data?.cookies;
  if (!map || typeof map !== 'object') return null;
  const pairs = Object.entries(map)
    .filter(([key, value]) => key && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`);
  return pairs.length ? { map, cookie: pairs.join('; ') } : null;
}

function decode(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch (_) {
    return String(value || '');
  }
}

/** 把登录响应里的 cookies 映射变成账号资料。 */
function profileOf(cookies) {
  const map = cookies || {};
  const userId = String(map.userid || '').trim();
  if (!/^\d{1,20}$/.test(userId)) throw new KuwoLoginError('酷我登录成功但未返回用户 ID', 401);
  return {
    userId,
    nickname: decode(map.uname3 || map.username) || `酷我用户${userId}`,
    avatar: decode(map.pic3),
    vipType: Number(map.vip_type || map.vipType) || 0,
  };
}

async function postLogin(path, payload, cookie) {
  const response = await upstreamRequest(withQuery(path), {
    method: 'POST',
    headers: headers(cookie, { 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new KuwoLoginError(`酷我登录接口返回 ${response.status}`);
  return readJson(response);
}

async function loginByPassword({ uname, password, verifyCode, verifyCodeToken, cookie }) {
  const body = await postLogin(`${WAPI_ORIGIN}/api/www/login/loginByKw`, {
    userIp: '', uname, password, verifyCode, verifyCodeToken,
  }, cookie);
  if (Number(body?.code) !== 200) throw new KuwoLoginError(messageOf(body), 401);
  const result = cookiesOf(body);
  if (!result) throw new KuwoLoginError('酷我登录成功但没有返回会话 Cookie', 401);
  return { cookie: result.cookie, profile: profileOf(result.map) };
}

/** 发送短信验证码。成功时返回 tm，登录步骤要原样带回。 */
async function sendSms({ mobile, verifyCode, verifyCodeToken, cookie }) {
  const body = await postLogin(`${WWW_ORIGIN}/api/sms/mobileLoginCode`, {
    verifyCode, verifyCodeToken, mobile, userIp: '',
  }, cookie);
  if (Number(body?.code) !== 200) throw new KuwoLoginError(messageOf(body), 401);
  return { tm: String(body?.data?.tm ?? '') };
}

async function loginBySms({ mobile, verifyCode, smsCode, tm, cookie }) {
  const body = await postLogin(`${WAPI_ORIGIN}/api/www/login/loginByMobile`, {
    mobile, verifyCode, smsCode, tm,
  }, cookie);
  if (Number(body?.code) !== 200) throw new KuwoLoginError(messageOf(body), 401);
  const result = cookiesOf(body);
  if (!result) throw new KuwoLoginError('酷我登录成功但没有返回会话 Cookie', 401);
  return { cookie: result.cookie, profile: profileOf(result.map) };
}

function cookieMap(cookie) {
  const map = {};
  for (const part of String(cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    map[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return map;
}

/**
 * 校验粘贴的浏览器 Cookie。真正的登录接口会返回 cookies 映射，不需要走这里；
 * 这里只服务于 /auth/login/cookie，因此要求 `userid` 与 sid/websid 同时存在。
 */
function checkLoginStatus(cookie) {
  const map = cookieMap(cookie);
  const userId = map.userid || '';
  const session = map.sid || map.websid || '';
  if (!/^\d{1,20}$/.test(userId) || !session) return { logged: false };
  return {
    logged: true,
    userId,
    nickname: decode(map.uname3 || map.username),
    avatar: decode(map.pic3),
    vipType: 0,
  };
}

export {
  KuwoLoginError, captcha, checkLoginStatus, loginByPassword, loginBySms, profileOf, sendSms,
};
