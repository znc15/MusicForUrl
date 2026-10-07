const crypto = require('node:crypto');
const { getKey } = require('./crypto');
const hash = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const sign = text => crypto.createHmac('sha256', 'player-v1:' + getKey()).update(text).digest('base64url');

function mint(user, playlistId) {
  const data = Buffer.from(JSON.stringify({ s: user.platform, u: user.id, p: String(playlistId),
    h: hash(user.token), e: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url');
  return 'p1.' + data + '.' + sign(data);
}

function verify(token, platform, playlistId, lookup) {
  try {
    if (typeof token !== 'string' || token.length > 1024) return null;
    const [version, data, signature, extra] = token.split('.');
    if (version !== 'p1' || extra || !data || !signature) return null;
    const actual = Buffer.from(signature), expected = Buffer.from(sign(data));
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (payload.s !== platform || payload.p !== String(playlistId) || !Number.isInteger(payload.u)
      || !Number.isFinite(payload.e) || payload.e <= Math.floor(Date.now() / 1000)) return null;
    const user = lookup(platform, payload.u);
    if (!user?.token || payload.h !== hash(user.token)) return null;
    return user;
  } catch (_) { return null; }
}

module.exports = { mint, verify, hash };
