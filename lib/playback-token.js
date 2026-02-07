const crypto = require('crypto');
const { getKey } = require('./crypto');

const LEGACY_TOKEN_RE = /^[a-f0-9]{32}$/i;
const MAX_PLAYBACK_TOKEN_TTL_SECONDS = 48 * 60 * 60;

function getPlaybackTokenTtlSeconds() {
  const raw = parseInt(process.env.PLAYBACK_TOKEN_TTL_SECONDS, 10);
  if (!Number.isFinite(raw)) return 300;
  if (raw < 30) return 30;
  if (raw > MAX_PLAYBACK_TOKEN_TTL_SECONDS) return MAX_PLAYBACK_TOKEN_TTL_SECONDS;
  return raw;
}

function toBase64Url(input) {
  return Buffer.from(input).toString('base64url');
}

function fromBase64Url(input) {
  return Buffer.from(String(input), 'base64url').toString('utf8');
}

function signPayload(payloadB64) {
  return crypto.createHmac('sha256', getKey()).update(payloadB64).digest('base64url');
}

function createPlaybackToken({ userId, playlistId, ttlSeconds, nowMs }) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new Error('Invalid userId');
  }

  const pid = String(playlistId || '').trim();
  if (!pid || !/^\d+$/.test(pid)) {
    throw new Error('Invalid playlistId');
  }

  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const hasCustomTtl = Number.isFinite(ttlSeconds);
  const ttl = hasCustomTtl ? Math.floor(ttlSeconds) : getPlaybackTokenTtlSeconds();
  const minTtl = hasCustomTtl ? 1 : 30;
  const safeTtl = Math.max(minTtl, Math.min(MAX_PLAYBACK_TOKEN_TTL_SECONDS, ttl));

  const payload = {
    u: uid,
    p: pid,
    e: Math.floor(now / 1000) + safeTtl
  };

  const payloadB64 = toBase64Url(JSON.stringify(payload));
  const signatureB64 = signPayload(payloadB64);
  return `${payloadB64}.${signatureB64}`;
}

function isLegacyToken(token) {
  return LEGACY_TOKEN_RE.test(String(token || ''));
}

function verifyPlaybackToken(token, { playlistId, nowMs } = {}) {
  const raw = String(token || '').trim();
  if (!raw || raw.length > 1024) {
    return { ok: false, reason: 'bad-token' };
  }

  const parts = raw.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: 'bad-format' };
  }

  const [payloadB64, sigB64] = parts;

  let expectedSig;
  try {
    expectedSig = signPayload(payloadB64);
  } catch (_) {
    return { ok: false, reason: 'sign-failed' };
  }

  const provided = Buffer.from(sigB64);
  const expected = Buffer.from(expectedSig);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'bad-signature' };
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64Url(payloadB64));
  } catch (_) {
    return { ok: false, reason: 'bad-payload' };
  }

  const uid = Number(payload && payload.u);
  const pid = String(payload && payload.p ? payload.p : '');
  const exp = Number(payload && payload.e);

  if (!Number.isInteger(uid) || uid <= 0) {
    return { ok: false, reason: 'bad-user' };
  }
  if (!pid || !/^\d+$/.test(pid)) {
    return { ok: false, reason: 'bad-playlist' };
  }
  if (!Number.isFinite(exp) || exp <= 0) {
    return { ok: false, reason: 'bad-expiry' };
  }

  const nowSec = Math.floor((Number.isFinite(nowMs) ? nowMs : Date.now()) / 1000);
  if (exp <= nowSec) {
    return { ok: false, reason: 'expired' };
  }

  const expectedPlaylistId = playlistId == null ? '' : String(playlistId).trim();
  if (expectedPlaylistId && expectedPlaylistId !== pid) {
    return { ok: false, reason: 'playlist-mismatch' };
  }

  return {
    ok: true,
    userId: uid,
    playlistId: pid,
    expiresAt: exp
  };
}

module.exports = {
  createPlaybackToken,
  verifyPlaybackToken,
  isLegacyToken,
  getPlaybackTokenTtlSeconds
};
