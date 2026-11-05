// 酷狗 Web 扫码登录。
//
// 能力边界：
//   ✅ 生成二维码 / 轮询扫码状态 / 拿到 token 与 userid（公开的 Web 登录接口）。
//   ⚠️ 登录只解决「账号身份」。酷狗的移动端取链接口（getSongInfo）完全不读登录态，
//      要让会员/付费曲目可播必须走 /v5/url 或 /v6/priv_url，而它们要求先做设备注册
//      （AES-CBC + RSA PKCS#1 v1.5，WebCrypto 不支持后者）。因此这里的登录不会改变
//      音源解析结果；适配器仍然按游客接口取链。
//
// 签名：md5(salt + 按 key 排序的 k=v 串 + body + salt)。WebCrypto 不提供 MD5，
// 所以用同目录下的纯 JS 实现。

import { md5Hex } from './md5.js';
import { upstreamRequest } from './request.js';

const LOGIN_ORIGIN = 'https://login-user.kugou.com';
const WEB_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const WEB_APPID = 1001;
const CHECK_APPID = 1005;
const SRC_APPID = 2919;
const CLIENT_VERSION = 20489;
const QR_TEXT = 'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=1005&';
const LOGIN_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1';

class KugouLoginError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'KugouLoginError';
    this.status = status;
  }
}

// 设备标识只需要在同一个 isolate 内保持稳定；登录接口不校验它是否已注册。
let deviceMid = '';
function mid() {
  if (!deviceMid) {
    deviceMid = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return deviceMid;
}

function signature(params, body = '') {
  const sorted = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('');
  return md5Hex(`${WEB_SALT}${sorted}${body}${WEB_SALT}`);
}

function webParams(extra) {
  return {
    appid: WEB_APPID,
    plat: 4,
    srcappid: SRC_APPID,
    dfid: '-',
    mid: mid(),
    uuid: '-',
    clientver: CLIENT_VERSION,
    clienttime: Math.floor(Date.now() / 1000),
    ...extra,
  };
}

async function call(path, params) {
  const query = { ...params, signature: signature(params) };
  const url = `${LOGIN_ORIGIN}${path}?${new URLSearchParams(query).toString()}`;
  const response = await upstreamRequest(url, {
    headers: { 'user-agent': LOGIN_UA, accept: 'application/json, text/plain, */*' },
    redirect: 'follow',
  });
  if (!response.ok) throw new KugouLoginError(`酷狗登录接口返回 ${response.status}`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new KugouLoginError('酷狗登录接口返回了非 JSON 内容');
  }
}

/** 生成扫码登录用的二维码：key 用于轮询，qrimg 是可直接渲染的 PNG data URL。 */
async function createQRCode() {
  const body = await call('/v2/qrcode', webParams({ type: 1, qrcode_txt: QR_TEXT }));
  const key = body?.data?.qrcode;
  const qrimg = body?.data?.qrcode_img;
  if (body?.status !== 1 || !key || !qrimg) {
    throw new KugouLoginError(typeof body?.data === 'string' ? body.data : '获取酷狗二维码失败');
  }
  return { key: String(key), qrimg: String(qrimg) };
}

/**
 * 轮询扫码状态，映射成前端统一的 801/802/803/800：
 * 上游 data.status：0 过期、1 等待扫码、2 已扫码待确认、4 已确认并返回凭据。
 */
async function checkQRCode(key) {
  const body = await call('/v2/get_userinfo_qrcode', webParams({ appid: CHECK_APPID, qrcode: key }));
  const data = body?.data;
  if (!data || typeof data !== 'object') {
    return { code: 804, message: typeof data === 'string' ? data : '酷狗登录状态异常' };
  }
  const status = Number(data.status);
  if (status === 1) return { code: 801, message: '等待扫码' };
  if (status === 2) return { code: 802, message: '已扫码，请在手机上确认' };
  if (status === 4) {
    const token = String(data.token || '').trim();
    const userId = String(data.userid || '').trim();
    if (!token || !userId) return { code: 804, message: '酷狗未返回登录凭据' };
    // 资料字段是否随扫码确认一起返回未经实测；有就带上，没有则由调用方回退到平台名
    return {
      code: 803,
      cookie: `token=${token}; userid=${userId}`,
      token,
      userId,
      nickname: String(data.nickname || data.nick_name || '').trim(),
      avatar: String(data.pic || data.avatar || '').trim(),
    };
  }
  if (status === 0) return { code: 800, message: '二维码已过期，请刷新' };
  return { code: 804, message: '酷狗登录状态异常' };
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
 * 校验并读取登录态。酷狗的 Web 资料接口要求 RSA PKCS#1 v1.5，Worker 里做不了，
 * 因此这里只确认扫码得到的 token/userid 形状；昵称留空，由前端回退到平台名。
 */
function checkLoginStatus(cookie) {
  const map = cookieMap(cookie);
  const token = map.token || '';
  const userId = map.userid || '';
  if (!token || !/^\d{1,20}$/.test(userId)) return { logged: false };
  return { logged: true, userId, nickname: '', avatar: '', vipType: 0 };
}

export { KugouLoginError, checkLoginStatus, checkQRCode, createQRCode };
