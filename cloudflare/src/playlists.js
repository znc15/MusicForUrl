import qqmusic from '../../lib/qqmusic.js';
import policy from '../../lib/player-policy.js';
import * as netease from './netease.js';
import * as kugou from './upstream/kugou.js';
import * as kuwo from './upstream/kuwo.js';
import { decryptCookie } from './security.js';
import { mp3Quality } from './audio-quality.js';
import { PLATFORMS, platform as platformOf } from './platforms.js';

const CACHE_TTL_SECONDS = 24 * 60 * 60;
const PARTIAL_CACHE_TTL_SECONDS = 60;
const PLAYLIST_CACHE_VERSION = 2;
const PARTIAL_REASONS = new Set(['upstream_page_failed', 'platform_limit', 'missing_tracks']);
// 游客歌单没有 users 行可以挂靠，因此不走 D1，改用 Cache API。
const GUEST_CACHE_ORIGIN = 'https://playlist.mfu.internal/';

function adapter(platform) {
  if (platform === 'qq') return qqmusic;
  if (platform === 'kugou') return kugou;
  if (platform === 'kuwo') return kuwo;
  return netease;
}

function validPlaylistId(value, platform = 'netease') {
  return (platformOf(platform)?.playlistIdPattern || /^\d{1,20}$/).test(String(value || ''));
}

function validSongId(value, platform = 'netease') {
  return (platformOf(platform)?.songIdPattern || /^\d{1,20}$/).test(String(value || ''));
}

/** 歌单链接的形状按平台各不相同，解析规则集中在这里，便于测试与扩展。 */
const PLAYLIST_URL_RULES = {
  netease: [/\/playlist\/(\d{1,20})(?:\/|$)/, /\/playlist\?id=(\d{1,20})/],
  qq: [/\/playlist\/(\d{1,20})(?:\/|$)/, /\/taoge\/detail\/(\d{1,20})/],
  kugou: [/\/special\/single\/(\d{1,20})/, /\/plist\/list\/(\d{1,20})/, /\/songlist\/(\d{1,20})/],
  kuwo: [/\/playlist_detail\/(\d{1,20})/, /\/playlist\/(\d{1,20})/],
};

// 查询参数也按平台区分，避免把别的平台的参数误当成歌单 ID
const PLAYLIST_QUERY_KEYS = {
  netease: ['id'],
  qq: ['id', 'dissid'],
  kugou: ['id', 'listid', 'specialid'],
  kuwo: ['id', 'pid'],
};

function parsePlaylistId(input, platform = 'netease') {
  const value = String(input || '').trim();
  if (validPlaylistId(value, platform)) return value;
  try {
    const url = new URL(value);
    for (const key of PLAYLIST_QUERY_KEYS[platform] || ['id']) {
      const param = url.searchParams.get(key);
      if (validPlaylistId(param, platform)) return param;
    }
    for (const rule of PLAYLIST_URL_RULES[platform] || []) {
      const match = url.pathname.match(rule);
      if (match) return match[1];
    }
  } catch (_) {
    // An ID or supported URL is required.
  }
  return null;
}

function normalizedSongs(platform, tracks, legacyCache = false) {
  const idOf = platform === 'qq'
    ? (track) => track?.mid || track?.id
    : platform === 'kugou'
      // 酷狗的复合 ID 已经由适配器拼好，这里不再拆分
      ? (track) => track?.id
      : (track) => track?.id;
  return (Array.isArray(tracks) ? tracks : [])
    .map((track) => ({
      id: String(idOf(track) || ''),
      name: String(track?.name || ''),
      artist: String(track?.artist || ''),
      duration: Number.isFinite(Number(track?.duration)) && Number(track.duration) > 0 ? Number(track.duration) : 0,
      // 旧缓存曾把未知时长填成 180 秒，只保留封装值，不作为统计已知时长。
      durationKnown: !legacyCache && track?.durationKnown !== false
        && Number.isFinite(Number(track?.duration)) && Number(track.duration) > 0,
      cover: String(track?.cover || ''),
    }))
    .filter((song) => validSongId(song.id, platform));
}

// 游客歌单缓存在 Cache API：键里没有用户维度，因为公开歌单对所有访客都一样。
function guestCacheUsable() {
  return typeof caches !== 'undefined' && !!caches.default;
}

async function readGuestCache(platform, playlistId) {
  if (!guestCacheUsable()) return null;
  try {
    const hit = await caches.default.match(`${GUEST_CACHE_ORIGIN}${platform}/${playlistId}`);
    if (!hit) return null;
    const payload = await hit.json();
    return Array.isArray(payload?.tracks) ? payload : null;
  } catch (error) {
    console.warn('[Playlist cache read]', error.message);
    return null;
  }
}

async function writeGuestCache(env, ctx, platform, playlistId, playlist) {
  if (!guestCacheUsable()) return;
  const ttl = cacheTtl(env, playlist);
  const response = new Response(JSON.stringify({ ...playlist, cacheVersion: PLAYLIST_CACHE_VERSION }), {
    headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttl}` },
  });
  const put = caches.default.put(`${GUEST_CACHE_ORIGIN}${platform}/${playlistId}`, response)
    .catch((error) => console.warn('[Playlist cache write]', error.message));
  if (ctx?.waitUntil) ctx.waitUntil(put);
  else await put;
}

function normalizePlaylist(platform, playlistId, playlist, tracks) {
  const reportedCount = Number(playlist.totalCount ?? playlist.songCount);
  const totalCount = Math.max(Number.isFinite(reportedCount) ? Math.max(0, Math.floor(reportedCount)) : 0, tracks.length);
  const partialReason = tracks.length >= totalCount ? null
    : PARTIAL_REASONS.has(playlist.partialReason) ? playlist.partialReason : 'missing_tracks';
  return policy.markNormalized({
    id: String(playlistId),
    name: String(playlist.name || ''),
    cover: String(playlist.cover || ''),
    songCount: totalCount,
    totalCount,
    includedCount: tracks.length,
    partialReason,
    tracks,
  }, platform);
}

function cacheTtl(env, playlist) {
  if (playlist.partialReason) return PARTIAL_CACHE_TTL_SECONDS;
  return Math.max(60, Math.min(7 * CACHE_TTL_SECONDS, Number(env.CACHE_TTL) || CACHE_TTL_SECONDS));
}

async function getPlaylist(env, user, playlistId, ctx, { refreshPartial = false } = {}) {
  const platform = user.platform;

  if (user.guest) {
    const cached = await readGuestCache(platform, playlistId);
    if (cached) {
      const legacy = cached.cacheVersion !== PLAYLIST_CACHE_VERSION;
      const value = normalizePlaylist(platform, playlistId, cached, normalizedSongs(platform, cached.tracks, legacy));
      // 旧版部分结果可能还剩一天 TTL，首次访问即刷新；新版媒体请求复用一分钟缓存。
      if (!value.partialReason || (!legacy && !refreshPartial)) return value;
    }
    const fetched = await adapter(platform).getPlaylistDetail(playlistId, '', env);
    const tracks = normalizedSongs(platform, fetched.tracks);
    const playlist = normalizePlaylist(platform, playlistId, fetched, tracks);
    await writeGuestCache(env, ctx, platform, playlistId, playlist);
    return playlist;
  }

  const cached = await env.DB.prepare(`
    SELECT * FROM playlists WHERE user_id = ? AND playlist_id = ? AND expires_at_ms > ?
  `).bind(user.id, playlistId, Date.now()).first();
  if (cached) {
    try {
      const payload = JSON.parse(cached.songs_json);
      const legacy = Array.isArray(payload);
      const tracks = legacy ? payload : payload?.cacheVersion === PLAYLIST_CACHE_VERSION ? payload.tracks : null;
      if (Array.isArray(tracks)) {
        const value = normalizePlaylist(platform, playlistId, {
          name: cached.name, cover: cached.cover, songCount: cached.song_count,
          ...(legacy ? {} : { totalCount: payload.totalCount, partialReason: payload.partialReason }),
        }, normalizedSongs(platform, tracks, legacy));
        if (!value.partialReason || (!legacy && !refreshPartial)) return value;
      }
    } catch (_) {
      // Refresh a damaged cache entry.
    }
  }

  const cookie = await decryptCookie(env, user);
  const fetched = await adapter(platform).getPlaylistDetail(playlistId, cookie, env);
  const tracks = normalizedSongs(platform, fetched.tracks);
  const playlist = normalizePlaylist(platform, playlistId, fetched, tracks);
  const ttl = cacheTtl(env, playlist);
  await env.DB.prepare(`
    INSERT INTO playlists (user_id, playlist_id, name, cover, song_count, songs_json, expires_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, playlist_id) DO UPDATE SET
      name = excluded.name,
      cover = excluded.cover,
      song_count = excluded.song_count,
      songs_json = excluded.songs_json,
      expires_at_ms = excluded.expires_at_ms
  `).bind(
    user.id, playlistId, String(playlist.name || ''), String(playlist.cover || ''),
    playlist.totalCount, JSON.stringify({ cacheVersion: PLAYLIST_CACHE_VERSION,
      totalCount: playlist.totalCount, partialReason: playlist.partialReason, tracks }), Date.now() + ttl * 1000,
  ).run();
  return playlist;
}

function titleOf(song) {
  return `${song.artist ? `${song.artist} - ` : ''}${song.name || song.id}`
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function durationOf(song) {
  let seconds = Number(song.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) seconds = 180;
  if (seconds > 10000) seconds /= 1000;
  return Math.max(1, Math.min(1800, Math.round(seconds)));
}

/** M3U8 里的分片前缀必须与平台一一对应；这里沿用注册表的路径前缀。 */
function segmentPrefix(platform) {
  return `${platformOf(platform)?.prefix || '/api'}/song`;
}

function streamPrefix(platform) {
  return `${platformOf(platform)?.prefix || '/api'}/playlist`;
}

function buildLitePlaylist(request, platform, token, playlistId, tracks) {
  // 传入的曲目已经由 getPlaylist 归一化过，这里只做一次廉价过滤，不再整体重映射
  const songs = (Array.isArray(tracks) ? tracks : []).filter((song) => validSongId(song?.id, platform));
  const targetDuration = Math.max(10, ...songs.map(durationOf));
  const origin = new URL(request.url).origin;
  const prefix = segmentPrefix(platform);
  const lines = [
    '#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${targetDuration}`,
    '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  for (const [index, song] of songs.entries()) {
    if (index) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXTINF:${durationOf(song).toFixed(3)},${titleOf(song)}`);
    lines.push(`${origin}${prefix}/${encodeURIComponent(token)}/${encodeURIComponent(song.id)}.mp3?playlist=${encodeURIComponent(playlistId)}&hls=1`);
  }
  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

function allowedAudioUrl(rawUrl, platform) {
  const pattern = platformOf(platform)?.audioHosts;
  if (!pattern) return null;
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (!pattern.test(host) || !['http:', 'https:'].includes(url.protocol)) return null;
    url.protocol = 'https:';
    return url.toString();
  } catch (_) {
    return null;
  }
}

async function songUrl(env, user, songId) {
  const cookie = user.guest ? '' : await decryptCookie(env, user);
  const upstream = adapter(user.platform);
  const url = user.platform === 'qq'
    ? await qqmusic.getSongUrl(songId, cookie, mp3Quality(env.MUSIC_QUALITY), 1)
    : upstream.getSongUrl
      ? await upstream.getSongUrl(songId, cookie, env)
      : (await upstream.getSongResource(songId, cookie, env))?.url;
  return allowedAudioUrl(url, user.platform);
}

export {
  PLAYLIST_URL_RULES, adapter, allowedAudioUrl, buildLitePlaylist, getPlaylist, parsePlaylistId,
  segmentPrefix, streamPrefix, songUrl, validPlaylistId, validSongId,
};
