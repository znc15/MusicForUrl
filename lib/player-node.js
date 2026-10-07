const path = require('node:path');
const policy = require('./player-policy');
const { createPlayerApi } = require('./player-api');
const { proxySource, trackTransfer } = require('./player-cache');
const { fileStorage } = require('./player-file-cache');
const tokens = require('./player-token');
const { decrypt } = require('./crypto');
const { db, userOps, qqUserOps } = require('./db');
const providers = { netease: require('./netease'), qq: require('./qqmusic') };
const playlists = new Map(), sources = new Map();
const enabled = process.env.AUDIO_CACHE_ENABLED === 'true';
const storage = enabled ? fileStorage(process.env.PLAYER_CACHE_DIR || path.join(__dirname, '..', 'data', 'player-cache')) : null;

db.exec(`CREATE TABLE IF NOT EXISTS player_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, user_id INTEGER NOT NULL,
  playlist_id TEXT NOT NULL, playlist_name TEXT NOT NULL, playlist_cover TEXT NOT NULL,
  song_id TEXT NOT NULL, song_name TEXT NOT NULL, artist TEXT NOT NULL, played_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS player_events_user_time_idx ON player_events(platform, user_id, played_at_ms DESC);`);

function lookup(platform, id) {
  const user = (platform === 'qq' ? qqUserOps : userOps).getById.get(id);
  if (!user || !user.token || !user.cookie || Date.parse(user.token_expires_at.replace(' ', 'T') + 'Z') <= Date.now()) return null;
  return { ...user, platform, token_hash: tokens.hash(user.token) };
}

async function playlist(user, id) {
  const key = [user.platform, user.id, user.token_hash, id].join(':');
  const hit = playlists.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const data = await providers[user.platform].getPlaylistDetail(id, decrypt(user.cookie));
  if (playlists.size > 500) playlists.delete(playlists.keys().next().value);
  playlists.set(key, { value: data, expires: Date.now() + 300000 }); return data;
}

async function resolve(user, songId, quality, fresh) {
  const key = [user.platform, user.id, user.token_hash, songId, quality].join(':');
  const hit = sources.get(key);
  if (!fresh && hit?.expiresAt > Date.now()) return hit;
  const source = await policy.resolveQuality(
    candidate => providers[user.platform].getSongResource(songId, decrypt(user.cookie), candidate), quality, false);
  source.url = policy.allowedSource(source.url, user.platform);
  if (!source.url) throw new policy.PlayerError('音源地址不受支持', 502);
  source.expiresAt = Math.min(source.expiresAt || Date.now() + 60000, Date.now() + 90000);
  if (sources.size > 2000) sources.delete(sources.keys().next().value);
  sources.set(key, source); return source;
}

function record(user, song, list) {
  const now = Date.now();
  db.transaction(() => {
    db.prepare(`INSERT INTO player_events (platform, user_id, playlist_id, playlist_name, playlist_cover, song_id, song_name, artist, played_at_ms)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS(SELECT 1 FROM player_events WHERE platform = ? AND user_id = ? AND playlist_id = ? AND song_id = ? AND played_at_ms >= ?)
      AND (SELECT COUNT(*) FROM player_events WHERE platform = ? AND user_id = ? AND played_at_ms >= ?) < 12`)
      .run(user.platform, user.id, list.id, list.name, list.cover, song.id, song.name, song.artist, now,
        user.platform, user.id, list.id, song.id, now - 300000, user.platform, user.id, now - 60000);
    db.prepare('DELETE FROM player_events WHERE played_at_ms < ?').run(now - 30 * 86400000);
    db.prepare('DELETE FROM player_events WHERE platform = ? AND user_id = ? AND id NOT IN (SELECT id FROM player_events WHERE platform = ? AND user_id = ? ORDER BY played_at_ms DESC, id DESC LIMIT 1000)')
      .run(user.platform, user.id, user.platform, user.id);
  })();
}

function createNodePlayer(ctx) {
  return createPlayerApi({
    capabilities: () => policy.capabilities('server', process.env.MUSIC_QUALITY, enabled),
    session(req, platform) {
      const token = req.headers.get(platform === 'qq' ? 'x-qq-token' : 'x-token');
      if (!token || token.length > 256) return null;
      const user = (platform === 'qq' ? qqUserOps : userOps).getByToken.get(token);
      return user ? lookup(platform, user.id) : null;
    },
    verifyGrant: (grant, platform, id) => tokens.verify(grant, platform, id, lookup),
    mintGrant: tokens.mint, playlist, resolve,
    async cover(req, user, url) {
      const source = policy.allowedSource(url, user.platform, true);
      if (!source) return new Response(await require('node:fs/promises').readFile(path.join(__dirname, '..', 'public', 'placeholder.svg')),
        { headers: { 'content-type': 'image/svg+xml' } });
      return proxySource(req, { source, platform: user.platform, storage,
        key: 'cover/v2/' + tokens.hash(source), ttl: 86400, ctx, image: true });
    },
    async media(req, user, song, id, source) {
      const key = 'audio/v2/' + tokens.hash([user.platform, user.id, user.token_hash, song.id,
        source.quality, source.format, source.bitrate, !!source.trial, new URL(source.url).pathname].join(':'));
      const response = await proxySource(req, { source: source.url, platform: user.platform, key, storage, ctx });
      return req.method === 'HEAD' ? response : trackTransfer(response, () =>
        ctx.waitUntil(playlist(user, id).then(list => record(user, song, { ...list, id })).catch(error => console.error('[History]', error.message))));
    },
  });
}

function history(platform) {
  return (req, res, next) => {
    if (req.method !== 'GET' || !['/recent', '/top'].includes(req.path)) return next();
    const token = req.headers[platform === 'qq' ? 'x-qq-token' : 'x-token'];
    const user = token ? (platform === 'qq' ? qqUserOps : userOps).getByToken.get(token) : null;
    if (!user) return res.status(401).json({ success: false, message: '请先登录' });
    const cutoff = Date.now() - 30 * 86400000;
    const total = db.prepare('SELECT COUNT(DISTINCT playlist_id) AS total FROM player_events WHERE platform = ? AND user_id = ? AND played_at_ms >= ?').get(platform, user.id, cutoff).total;
    if (!total) return next();
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit) || 20));
    const offset = Math.max(0, Number.parseInt(req.query.offset) || 0);
    if (req.path === '/recent') {
      const rows = db.prepare('SELECT playlist_id, MAX(playlist_name) AS name, MAX(playlist_cover) AS cover, MAX(played_at_ms) AS playedAt, COUNT(*) AS playCount FROM player_events WHERE platform = ? AND user_id = ? AND played_at_ms >= ? GROUP BY playlist_id ORDER BY playedAt DESC LIMIT ? OFFSET ?').all(platform, user.id, cutoff, limit, offset);
      return res.json({ success: true, total, data: rows.map(row => ({ ...row, playlistId: row.playlist_id, playedAt: new Date(row.playedAt).toISOString() })) });
    }
    const rows = db.prepare('SELECT song_id AS songId, MAX(song_name) AS songName, MAX(artist) AS artist, COUNT(*) AS playCount FROM player_events WHERE platform = ? AND user_id = ? AND played_at_ms >= ? GROUP BY song_id ORDER BY playCount DESC LIMIT ?').all(platform, user.id, cutoff, limit);
    return res.json({ success: true, data: rows });
  };
}
const sweep = setInterval(() => db.prepare('DELETE FROM player_events WHERE played_at_ms < ?').run(Date.now() - 30 * 86400000), 3600000);
sweep.unref();
module.exports = { createNodePlayer, lookup, resolve, playlist, history };
