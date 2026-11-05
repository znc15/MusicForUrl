import { requireSecret, sha256Hex } from './security.js';

const PLAY_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PLAY_LOG_DEDUP_MS = 5 * 60 * 1000;
const PLAY_LOG_MAX_PER_MINUTE = 12;
const RANKING_CACHE_MS = 5 * 60 * 1000;
const RANKING_STALE_MS = 60 * 60 * 1000;
const rankingCaches = new WeakMap();

// Guest keys use the Cloudflare-provided address, never X-Forwarded-For.
// Only a secret-salted hash is stored. Shared networks may share this request
// admission identity; it is not used for the registered-account metric.
async function playbackActor(env, user, request) {
  if (!user.guest && user.id > 0) return `user:${user.id}`;
  const address = request?.headers.get('cf-connecting-ip') || 'unknown';
  const agent = (request?.headers.get('user-agent') || '').slice(0, 512);
  return `guest:${user.platform}:` + await sha256Hex([requireSecret(env), address, agent].join('\n'));
}

// One guarded INSERT, with trigger updates in the same database transaction.
// The numeric-user signature remains usable by existing callers.
async function recordPlayback(env, user, playlistId, song, now = Date.now(), options = {}) {
  if (typeof user !== 'object') user = await env.DB.prepare('SELECT id, platform FROM users WHERE id = ?').bind(user).first();
  if (!user) return null;
  const actor = await playbackActor(env, user, options.request);
  const seconds = Number(song?.duration);
  const durationMs = song?.durationKnown !== false && Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds * 1000) : 0;
  const surface = ['player', 'hls', 'redirect'].includes(options.surface) ? options.surface : 'player';
  return await env.DB.prepare(`
    INSERT INTO playback_events (actor_key, user_id, platform, playlist_id, song_id, song_name, artist, duration_ms, surface, played_at_ms)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM playback_events WHERE actor_key = ? AND playlist_id = ? AND song_id = ? AND played_at_ms >= ?
    ) AND (
      SELECT COUNT(*) FROM playback_events WHERE actor_key = ? AND played_at_ms >= ?
    ) < ?
    RETURNING id, played_at_ms
  `).bind(actor, user.guest ? null : user.id, user.platform, String(playlistId), String(song.id),
    String(song.name || ''), String(song.artist || ''), durationMs, surface, now,
    actor, String(playlistId), String(song.id), now - PLAY_LOG_DEDUP_MS,
    actor, now - 60000, PLAY_LOG_MAX_PER_MINUTE).first() || null;
}

async function prunePlaybackLogs(env, now = Date.now()) {
  // Personal aggregates remain compatible; precise ranks use separate events.
  return Promise.all([
    env.DB.prepare('DELETE FROM play_stats WHERE last_played_at_ms < ?').bind(now - PLAY_LOG_RETENTION_MS).run(),
    env.DB.prepare('DELETE FROM playback_events WHERE played_at_ms < ?').bind(now - PLAY_LOG_RETENTION_MS).run(),
  ]);
}

async function readPlaybackRanking(env, { userId = null, platform = null, limit = 10, now = Date.now() } = {}) {
  const conditions = ['played_at_ms >= ?'];
  const params = [now - PLAY_LOG_RETENTION_MS];
  if (userId !== null) { conditions.push('user_id = ?'); params.push(userId); }
  if (platform !== null) { conditions.push('platform = ?'); params.push(platform); }
  const rows = await env.DB.prepare(`
    SELECT platform, song_id, MAX(song_name) AS song_name, MAX(artist) AS artist, COUNT(*) AS play_count
    FROM playback_events WHERE ${conditions.join(' AND ')}
    GROUP BY platform, song_id ORDER BY play_count DESC, platform, song_id LIMIT ?
  `).bind(...params, Math.min(50, Math.max(1, Number(limit) || 10))).all();
  const totals = await env.DB.prepare('SELECT started_at_ms FROM playback_totals WHERE id = 1').first();
  return { data: (rows.results || []).map(row => ({ platform: row.platform, songId: row.song_id,
    songName: row.song_name, artist: row.artist, playCount: row.play_count })),
  windowDays: 30, startedAt: totals?.started_at_ms ?? null, since: Math.max(now - PLAY_LOG_RETENTION_MS, totals?.started_at_ms || 0) };
}

// Public ranking is shared for five minutes at the edge. All requested limits
// reuse the same top-50 snapshot; private account rankings stay separate.
async function readGlobalPlaybackRanking(env, ctx, limit = 10) {
  limit = Math.min(50, Math.max(1, Math.floor(Number(limit) || 10)));
  const select = value => ({ ...value, data: value.data.slice(0, limit) });
  const key = 'https://stats.mfu.internal/v2/top';
  let entry = rankingCaches.get(env.DB);
  if (!entry) rankingCaches.set(env.DB, entry = { value: null, pending: null });
  if (entry.pending) return select(await entry.pending);
  if (entry.value && Date.now() - entry.value.updatedAt < RANKING_CACHE_MS) return select(entry.value);
  entry.pending = (async () => {
    const edge = typeof caches !== 'undefined' ? caches.default : null;
    if (!entry.value && edge) {
      try {
        const hit = await edge.match(key);
        if (hit) entry.value = await hit.json();
      } catch (_) { /* Cache is optional; D1 remains authoritative. */ }
    }
    if (entry.value && Date.now() - entry.value.updatedAt < RANKING_CACHE_MS) return entry.value;
    try {
      const value = { ...await readPlaybackRanking(env, { limit: 50 }), updatedAt: Date.now(), stale: false };
      entry.value = value;
      if (edge) {
        const put = edge.put(key, Response.json(value, { headers: { 'cache-control': `max-age=${RANKING_STALE_MS / 1000}` } })).catch(() => {});
        if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
      }
      return value;
    } catch (_) {
      if (entry.value && Date.now() - entry.value.updatedAt < RANKING_STALE_MS) return { ...entry.value, stale: true };
      throw Object.assign(new Error('排行榜暂时不可用，请稍后重试'), { status: 503 });
    }
  })();
  try { return select(await entry.pending); } finally { entry.pending = null; }
}

export { PLAY_LOG_DEDUP_MS, PLAY_LOG_MAX_PER_MINUTE, PLAY_LOG_RETENTION_MS,
  playbackActor, prunePlaybackLogs, readPlaybackRanking, readGlobalPlaybackRanking, recordPlayback };
