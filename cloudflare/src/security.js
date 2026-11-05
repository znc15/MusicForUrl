import { PLATFORMS, guestUser, platform as platformOf, tokenHeader } from './platforms.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_PLAYBACK_TTL_SECONDS = 48 * 60 * 60;
// 游客播放令牌不绑定任何账号，因此没有可轮换的凭据；这个常量只是让载荷形状保持统一
const GUEST_TOKEN_HASH = 'guest';

function requireSecret(env) {
  const secret = String(env.ENCRYPTION_KEY || '');
  if (
    secret.length < 32 ||
    secret.includes('replace-with-') ||
    secret === 'your-32-character-secret-key-here'
  ) {
    throw new Error('ENCRYPTION_KEY must be a unique secret of at least 32 characters');
  }
  return secret;
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(value || ''))) throw new Error('Invalid base64url');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const keyCache = new Map();

async function deriveKey(env, purpose, algorithm, usages) {
  const secret = requireSecret(env);
  // 派生键在 isolate 内按用途/算法/权限缓存，避免每个请求重算 SHA-256 与 importKey
  const cacheKey = `${secret}\u0000${purpose}\u0000${algorithm.name}\u0000${algorithm.hash || ''}\u0000${usages.join(',')}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;
  const seed = encoder.encode(`MusicForUrl:${purpose}:${secret}`);
  const bytes = await crypto.subtle.digest('SHA-256', seed);
  const promise = crypto.subtle.importKey('raw', bytes, algorithm, false, usages)
    .catch((error) => { keyCache.delete(cacheKey); throw error; });
  keyCache.set(cacheKey, promise);
  if (keyCache.size > 32) keyCache.delete(keyCache.keys().next().value);
  return promise;
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function encryptCookie(env, platform, platformUserId, cookie) {
  const key = await deriveKey(env, 'cookie', { name: 'AES-GCM' }, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = encoder.encode(`${platform}:${platformUserId}`);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData }, key, encoder.encode(String(cookie || ''))
  ));
  return `v1.${toBase64Url(iv)}.${toBase64Url(encrypted)}`;
}

async function decryptCookie(env, user) {
  const [version, ivText, encryptedText] = String(user.cookie_cipher || '').split('.');
  if (version !== 'v1' || !ivText || !encryptedText) throw new Error('Invalid stored cookie');
  const key = await deriveKey(env, 'cookie', { name: 'AES-GCM' }, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: fromBase64Url(ivText),
    additionalData: encoder.encode(`${user.platform}:${user.platform_user_id}`),
  }, key, fromBase64Url(encryptedText));
  return decoder.decode(decrypted);
}

async function createSession(env, platform, profile, cookie) {
  const platformUserId = String(profile.userId || '').trim();
  if (!platformUserId || !cookie) throw new Error('Missing account identity or cookie');
  const now = Date.now();
  const ttlHours = Math.max(1, Math.min(24 * 365, Number(env.TOKEN_TTL_HOURS) || 168));
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const cookieCipher = await encryptCookie(env, platform, platformUserId, cookie);
  const row = await env.DB.prepare(`
    INSERT INTO users (
      platform, platform_user_id, nickname, avatar, vip_type, cookie_cipher,
      token_hash, token_expires_at_ms, created_at_ms, last_login_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (platform, platform_user_id) DO UPDATE SET
      nickname = excluded.nickname,
      avatar = excluded.avatar,
      vip_type = excluded.vip_type,
      cookie_cipher = excluded.cookie_cipher,
      token_hash = excluded.token_hash,
      token_expires_at_ms = excluded.token_expires_at_ms,
      last_login_at_ms = excluded.last_login_at_ms
    RETURNING id
  `).bind(
    platform, platformUserId, String(profile.nickname || ''), String(profile.avatar || ''),
    Number(profile.vipType) || 0, cookieCipher, tokenHash,
    now + ttlHours * 60 * 60 * 1000, now, now,
  ).first();
  if (!row?.id) throw new Error('Could not save login');
  return { token, userId: row.id };
}

function sessionToken(request, platform) {
  return request.headers.get(tokenHeader(platform)) || '';
}

async function getSessionUser(env, request, platform, url) {
  // 游客平台没有账号体系，任何会话令牌都不成立
  if (!PLATFORMS[platform]?.account) return null;
  const token = sessionToken(request, platform);
  if (!token || token.length > 256) return null;
  const tokenHash = await sha256Hex(token);
  return env.DB.prepare(`
    SELECT * FROM users
    WHERE platform = ? AND token_hash = ? AND token_expires_at_ms > ?
  `).bind(platform, tokenHash, Date.now()).first();
}

async function logout(env, request, platform, url, body) {
  const token = sessionToken(request, platform) ||
    (platform === 'qq' ? body?.qqtoken : body?.token) || '';
  if (!token || token.length > 256) return;
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare(`
    UPDATE users SET token_hash = ?, token_expires_at_ms = 0, cookie_cipher = ''
    WHERE platform = ? AND token_hash = ?
  `).bind(`revoked:${randomToken()}`, platform, tokenHash).run();
}

function playbackTtlSeconds(env) {
  const configured = Number(env.PLAYBACK_TOKEN_TTL_SECONDS);
  if (!Number.isFinite(configured) || configured <= 0) return 24 * 60 * 60;
  return Math.max(60, Math.min(MAX_PLAYBACK_TTL_SECONDS, Math.floor(configured)));
}

async function signingKey(env, usage) {
  return deriveKey(env, 'playback', { name: 'HMAC', hash: 'SHA-256' }, [usage]);
}

async function createPlaybackToken(env, user, playlistId) {
  const guest = !!user.guest || !PLATFORMS[user.platform]?.account;
  const payload = {
    v: 1,
    s: user.platform,
    // 游客令牌的 u 固定为 0：没有 users 行可挂靠，也就没有登出可以撤销的东西
    u: guest ? 0 : user.id,
    p: String(playlistId),
    h: guest ? GUEST_TOKEN_HASH : user.token_hash,
    e: Math.floor(Date.now() / 1000) + playbackTtlSeconds(env),
  };
  const content = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC', await signingKey(env, 'sign'), encoder.encode(content)
  ));
  return `${content}.${toBase64Url(signature)}`;
}

// Only used for tokens minted by this service; authorization still verifies
// the signature through getPlaybackUser on every playback request.
function playbackTokenExpiresAt(token) {
  return JSON.parse(decoder.decode(fromBase64Url(token.split('.')[0]))).e * 1000;
}

async function getPlaybackUser(env, token, platform, playlistId) {
  try {
    const [content, signature, extra] = String(token || '').split('.');
    if (!content || !signature || extra || token.length > 1024) return null;
    const valid = await crypto.subtle.verify(
      'HMAC', await signingKey(env, 'verify'), fromBase64Url(signature), encoder.encode(content)
    );
    if (!valid) return null;
    const payload = JSON.parse(decoder.decode(fromBase64Url(content)));
    if (
      payload.v !== 1 || payload.s !== platform || String(payload.p) !== String(playlistId) ||
      !Number.isInteger(payload.u) || payload.u < 0 ||
      !Number.isFinite(payload.e) || payload.e <= Math.floor(Date.now() / 1000) ||
      typeof payload.h !== 'string'
    ) return null;
    // 游客令牌只验签，不查库：每个音频分片请求因此省掉一次 D1 读取。
    // 不能按平台的 account 标记判断：酷狗可以登录，但未登录签发的仍是游客令牌。
    if (payload.h === GUEST_TOKEN_HASH) {
      return payload.u === 0 ? guestUser(platform) : null;
    }
    if (payload.u <= 0) return null;
    return env.DB.prepare(`
      SELECT * FROM users
      WHERE id = ? AND platform = ? AND token_hash = ? AND token_expires_at_ms > ?
    `).bind(payload.u, platform, payload.h, Date.now()).first();
  } catch (_) {
    return null;
  }
}

export {
  createPlaybackToken, createSession, decryptCookie, getPlaybackUser, getSessionUser,
  logout, playbackTokenExpiresAt, playbackTtlSeconds, requireSecret, sha256Hex,
};
