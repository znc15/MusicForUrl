import qqmusic from '../../lib/qqmusic.js';
import * as netease from './netease.js';
import { decryptCookie } from './security.js';

const CACHE_TTL_SECONDS = 24 * 60 * 60;

function adapter(platform) {
  return platform === 'qq' ? qqmusic : netease;
}

function validPlaylistId(value) {
  return /^\d{1,20}$/.test(String(value || ''));
}

function validSongId(value, platform) {
  return platform === 'qq'
    ? /^[A-Za-z0-9]{1,30}$/.test(String(value || ''))
    : /^\d{1,20}$/.test(String(value || ''));
}

function parsePlaylistId(input, platform) {
  const value = String(input || '').trim();
  if (validPlaylistId(value)) return value;
  try {
    const url = new URL(value);
    const param = url.searchParams.get('id');
    if (validPlaylistId(param)) return param;
    const match = url.pathname.match(/\/playlist\/(\d{1,20})(?:\/|$)/);
    if (match) return match[1];
  } catch (_) {
    // An ID or supported URL is required.
  }
  return null;
}

function normalizedSongs(platform, tracks) {
  return (Array.isArray(tracks) ? tracks : [])
    .map((track) => ({
      id: String(platform === 'qq' ? track?.mid || track?.id || '' : track?.id || ''),
      name: String(track?.name || ''),
      artist: String(track?.artist || ''),
      duration: Number(track?.duration) || 180,
      cover: String(track?.cover || ''),
    }))
    .filter((song) => validSongId(song.id, platform));
}

async function getPlaylist(env, user, playlistId) {
  const cached = await env.DB.prepare(`
    SELECT * FROM playlists WHERE user_id = ? AND playlist_id = ? AND expires_at_ms > ?
  `).bind(user.id, playlistId, Date.now()).first();
  if (cached) {
    try {
      const tracks = JSON.parse(cached.songs_json);
      if (Array.isArray(tracks)) {
        return {
          id: playlistId, name: cached.name, cover: cached.cover,
          songCount: cached.song_count, tracks,
        };
      }
    } catch (_) {
      // Refresh a damaged cache entry.
    }
  }

  const cookie = await decryptCookie(env, user);
  const playlist = await adapter(user.platform).getPlaylistDetail(playlistId, cookie);
  const tracks = normalizedSongs(user.platform, playlist.tracks);
  const ttl = Math.max(60, Math.min(7 * CACHE_TTL_SECONDS, Number(env.CACHE_TTL) || CACHE_TTL_SECONDS));
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
    Number(playlist.songCount) || tracks.length, JSON.stringify(tracks), Date.now() + ttl * 1000,
  ).run();
  return {
    id: playlistId,
    name: String(playlist.name || ''),
    cover: String(playlist.cover || ''),
    songCount: Number(playlist.songCount) || tracks.length,
    tracks,
  };
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

function buildLitePlaylist(request, platform, token, playlistId, tracks) {
  const songs = normalizedSongs(platform, tracks);
  const targetDuration = Math.max(10, ...songs.map(durationOf));
  const origin = new URL(request.url).origin;
  const prefix = platform === 'qq' ? '/api/qq/song' : '/api/song';
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
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    const allowed = platform === 'qq'
      ? /(^|\.)(qq\.com|gtimg\.cn|mcobj\.com)$/.test(host)
      : /(^|\.)music\.126\.net$/.test(host);
    if (!allowed || !['http:', 'https:'].includes(url.protocol)) return null;
    url.protocol = 'https:';
    return url.toString();
  } catch (_) {
    return null;
  }
}

async function songUrl(env, user, songId) {
  const cookie = await decryptCookie(env, user);
  const url = user.platform === 'qq'
    ? await qqmusic.getSongUrl(songId, cookie)
    : await netease.getSongUrl(songId, cookie, env);
  return allowedAudioUrl(url, user.platform);
}

export {
  adapter, allowedAudioUrl, buildLitePlaylist, getPlaylist, parsePlaylistId, songUrl,
  validPlaylistId, validSongId,
};
