import { PLAY_LOG_RETENTION_MS } from './playback-history.js';

const STATS_KEYS = ['parsedSongs', 'generatedLinks', 'plays', 'playDurationMs', 'listeners', 'songs', 'playlists'];
const SNAPSHOT_KEYS = ['listeners', 'songs', 'playlists'];
const refreshing = new WeakMap();

function refreshMinutes(env) {
  const value = Number(env?.STATS_REFRESH_MINUTES);
  return Number.isInteger(value) && value >= 5 ? value : 60;
}

async function bumpParsedSongs(env, songCount, links = 0) {
  const now = Date.now();
  const rows = [['parsedSongs', songCount], ['generatedLinks', links]]
    .filter(([, value]) => Number.isFinite(Number(value)) && Number(value) > 0);
  if (!rows.length) return;
  try {
    await env.DB.batch(rows.map(([key, value]) => env.DB.prepare(`
      INSERT INTO site_stats (key, value, updated_at_ms) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = site_stats.value + excluded.value, updated_at_ms = excluded.updated_at_ms
    `).bind(key, Math.floor(Number(value)), now)));
  } catch (_) { console.warn('[Stats] counter_write_failed'); }
}

// Only the account/catalog snapshot is TTL cached. Lifetime counts are durable
// counters, never recomputed from the 30-day event retention window.
async function refreshSiteStats(env) {
  const now = Date.now();
  const derived = await env.DB.prepare(`
    SELECT COUNT(*) AS songs FROM (
      SELECT platform, song_id FROM playback_events WHERE played_at_ms >= ? GROUP BY platform, song_id
    )
  `).bind(now - PLAY_LOG_RETENTION_MS).first();
  const playlists = await env.DB.prepare(`
    SELECT COUNT(*) AS playlists FROM (
      SELECT platform, playlist_id FROM playback_events WHERE played_at_ms >= ? GROUP BY platform, playlist_id
    )
  `).bind(now - PLAY_LOG_RETENTION_MS).first();
  const users = await env.DB.prepare('SELECT COUNT(*) AS total FROM users').first();
  const rows = [['v2:songs', derived?.songs], ['v2:playlists', playlists?.playlists], ['v2:listeners', users?.total]];
  if (rows.some(([, value]) => !Number.isFinite(value) || value < 0)) throw new Error('stats_snapshot_incomplete');
  await env.DB.batch(rows.map(([key, value]) => env.DB.prepare(`
    INSERT INTO site_stats (key, value, updated_at_ms) VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms
  `).bind(key, value, now)));
  return now;
}

async function readRows(env) {
  const result = await env.DB.prepare('SELECT key, value, updated_at_ms FROM site_stats').all();
  const stats = Object.fromEntries(STATS_KEYS.map(key => [key, null]));
  const times = new Map();
  for (const row of result.results || []) {
    const key = row.key.startsWith('v2:') ? row.key.slice(3) : row.key;
    if (!((row.key.startsWith('v2:') && SNAPSHOT_KEYS.includes(key)) || ['parsedSongs', 'generatedLinks'].includes(row.key))) continue;
    if (Number.isFinite(row.value) && row.value >= 0) {
      stats[key] = row.value;
      times.set(key, Number(row.updated_at_ms) || 0);
    }
  }
  // v2-prefixed keys separate precise event snapshots from legacy aggregates,
  // including writes by an older Worker during deploy/rollback transitions.
  const totals = await env.DB.prepare('SELECT * FROM playback_totals WHERE id = 1').first();
  if (!totals) throw new Error('playback_totals_missing');
  Object.assign(stats, { version: 2, startedAt: totals.started_at_ms, plays: totals.plays,
    playDurationMs: totals.duration_ms, knownDurationPlays: totals.known_duration_plays,
    unknownDurationPlays: totals.plays - totals.known_duration_plays,
    playSources: { player: totals.player_plays, hls: totals.hls_plays, redirect: totals.redirect_plays },
    rankingWindowDays: 30, updatedAt: Math.min(...SNAPSHOT_KEYS.map(key => times.get(key) || 0)),
  });
  stats.unknown = STATS_KEYS.filter(key => stats[key] === null);
  stats.stale = !stats.updatedAt || Date.now() - stats.updatedAt >= refreshMinutes(env) * 60000;
  return stats;
}

function unavailable() { return Object.assign(new Error('统计暂时不可用，请稍后重试'), { status: 503 }); }

async function readSiteStats(env) {
  let stats;
  try { stats = await readRows(env); } catch (_) { throw unavailable(); }
  if (!stats.stale) return stats;
  let pending = refreshing.get(env.DB);
  if (!pending) {
    pending = refreshSiteStats(env).finally(() => refreshing.delete(env.DB));
    refreshing.set(env.DB, pending);
  }
  try { await pending; return await readRows(env); }
  catch (_) {
    console.warn('[Stats] snapshot_refresh_failed');
    if (SNAPSHOT_KEYS.every(key => stats[key] === null)) throw unavailable();
    return { ...stats, stale: true };
  }
}

export { STATS_KEYS, bumpParsedSongs, readSiteStats, refreshMinutes, refreshSiteStats };
