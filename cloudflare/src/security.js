const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_PLAYBACK_TTL_SECONDS = 48 * 60 * 60;

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

async function deriveKey(env, purpose, algorithm, usages) {
  const seed = encoder.encode(`MusicForUrl:${purpose}:${requireSecret(env)}`);
  const bytes = await crypto.subtle.digest('SHA-256', seed);
  return crypto.subtle.importKey('raw', bytes, algorithm, false, usages);
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

function sessionToken(request, platform, url) {
  return request.headers.get(platform === 'qq' ? 'x-qq-token' : 'x-token') ||
    url.searchParams.get(platform === 'qq' ? 'qqtoken' : 'token') || '';
}

async function getSessionUser(env, request, platform, url) {
  const token = sessionToken(request, platform, url);
  if (!token || token.length > 256) return null;
  const tokenHash = await sha256Hex(token);
  return env.DB.prepare(`
    SELECT * FROM users
    WHERE platform = ? AND token_hash = ? AND token_expires_at_ms > ?
  `).bind(platform, tokenHash, Date.now()).first();
}

async function logout(env, request, platform, url, body) {
  const token = sessionToken(request, platform, url) ||
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
  const payload = {
    v: 1,
    s: user.platform,
    u: user.id,
    p: String(playlistId),
    h: user.token_hash,
    e: Math.floor(Date.now() / 1000) + playbackTtlSeconds(env),
  };
  const content = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC', await signingKey(env, 'sign'), encoder.encode(content)
  ));
  return `${content}.${toBase64Url(signature)}`;
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
      !Number.isInteger(payload.u) || payload.u <= 0 ||
      !Number.isFinite(payload.e) || payload.e <= Math.floor(Date.now() / 1000) ||
      typeof payload.h !== 'string'
    ) return null;
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
  logout, playbackTtlSeconds, requireSecret, sha256Hex,
};
