const express = require('express');
const router = express.Router();
const netease = require('../lib/netease');
const { decrypt } = require('../lib/crypto');
const { playlistOps, userOps } = require('../lib/db');
const {
  buildLiteM3u8,
  normalizeDurationSeconds,
  sanitizeM3uTitle
} = require('../lib/lite-m3u8');
const {
  createPlaybackToken,
  verifyPlaybackToken,
  isLegacyToken
} = require('../lib/playback-token');
const { auth } = require('../lib/auth');

function isValidNumericId(id) {
  return typeof id === 'string' && /^\d+$/.test(id) && id.length <= 20;
}

function isLikelyToken(token) {
  return typeof token === 'string' && token.length > 0 && token.length <= 1024;
}

function resolveUserFromAccessToken(token, playlistId) {
  const raw = String(token || '');
  if (isLegacyToken(raw)) {
    return userOps.getByToken.get(raw) || null;
  }

  const verified = verifyPlaybackToken(raw, { playlistId: String(playlistId || '') });
  if (!verified.ok) return null;
  return userOps.getById.get(verified.userId) || null;
}

function getBaseUrl(req) {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, '');
  }
  
  return `${req.protocol}://${req.get('host')}`;
}

function parsePlaylistId(input) {
  if (!input) return null;
  const str = String(input).trim();
  if (!str) return null;
  if (/^\d+$/.test(str)) return str;

  const m1 = str.match(/(?:\?|&)id=(\d{1,20})/);
  if (m1) return m1[1];

  const m2 = str.match(/\/playlist\/(\d{1,20})/);
  if (m2) return m2[1];

  return null;
}

function toSqliteDatetime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function buildNeteaseLiteM3u8(baseUrl, token, playlistId, tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  const segments = [];
  for (const track of list) {
    const id = track && track.id != null ? String(track.id) : '';
    if (!/^\d+$/.test(id)) continue;

    const duration = normalizeDurationSeconds(track.duration);
    const title = sanitizeM3uTitle(`${track.artist ? track.artist + ' - ' : ''}${track.name || id}`);
    const url =
      `${baseUrl}/api/song/${encodeURIComponent(token)}/${encodeURIComponent(id)}.mp3?playlist=${encodeURIComponent(playlistId)}`;
    segments.push({ duration, title, url });
  }
  return buildLiteM3u8({ segments });
}

async function ensurePlaylistCached(playlistId, cookie) {
  try {
    playlistOps.clearExpired.run();
  } catch (_) {}

  const cached = playlistOps.get.get(playlistId);
  if (cached) {
    try {
      const songs = JSON.parse(cached.songs || '[]');
      if (Array.isArray(songs)) {
        return { playlist: cached, tracks: songs };
      }
    } catch (_) {}
  }

  const playlist = await netease.getPlaylistDetail(playlistId, cookie);
  const ttlSec = parseInt(process.env.CACHE_TTL) || 86400;
  const expiresAt = toSqliteDatetime(new Date(Date.now() + ttlSec * 1000));

  playlistOps.set.run({
    playlist_id: String(playlistId),
    name: playlist.name || '',
    cover: playlist.cover || '',
    song_count: playlist.songCount || 0,
    songs: JSON.stringify(playlist.tracks || []),
    expires_at: expiresAt
  });

  return { playlist: { playlist_id: String(playlistId), name: playlist.name, cover: playlist.cover }, tracks: playlist.tracks || [] };
}

router.get('/m3u8/:token/:playlistId/stream.m3u8', async (req, res) => {
  const token = String(req.params.token || '');
  const playlistId = String(req.params.playlistId || '');

  if (!isLikelyToken(token)) {
    return res.status(400).type('text/plain').send('Invalid token');
  }
  if (!isValidNumericId(playlistId)) {
    return res.status(400).type('text/plain').send('Invalid playlist id');
  }

  const ua = req.headers['user-agent'] || '';
  const ip = req.ip || req.connection?.remoteAddress || '';
  console.log(`[M3U8 请求] 网易歌单=${playlistId} IP=${ip} UA=${ua}`);

  const user = resolveUserFromAccessToken(token, playlistId);
  if (!user) {
    console.log(`[M3U8 请求] token 验证失败: ${token.slice(0, 20)}...`);
    return res.status(401).type('text/plain').send('Token expired');
  }

  try {
    const cookie = decrypt(user.cookie);
    const { tracks } = await ensurePlaylistCached(playlistId, cookie);

    const baseUrl = getBaseUrl(req);
    const m3u8 = buildNeteaseLiteM3u8(baseUrl, token, playlistId, tracks);

    console.log(`[M3U8 响应] 歌单=${playlistId} 曲目数=${tracks.length} 大小=${m3u8.length}字节`);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(m3u8);
  } catch (e) {
    console.error('生成 lite m3u8 失败:', e);
    res.status(500).type('text/plain').send('Failed to build m3u8');
  }
});

router.get('/user', auth, async (req, res) => {
  const rawLimit = parseInt(req.query.limit, 10);
  const rawOffset = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 30;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  
  try {
    const cookie = decrypt(req.user.cookie);
    const result = await netease.getUserPlaylists(req.user.netease_id, cookie, 0, 1000);
    const all = Array.isArray(result.playlists) ? result.playlists : [];
    const total = Number.isFinite(result.count) ? result.count : all.length;
    const pageData = all.slice(offset, offset + limit);
    
    res.json({
      success: true,
      data: pageData,
      total
    });
  } catch (e) {
    console.error('获取用户歌单失败:', e);
    res.status(500).json({ success: false, message: e.message || '获取歌单失败' });
  }
});

router.get('/parse', auth, async (req, res) => {
  const input = req.query.url;
  const playlistId = parsePlaylistId(input);

  if (!playlistId || !isValidNumericId(playlistId)) {
    return res.status(400).json({ success: false, message: '无效的歌单链接或ID' });
  }

  try {
    try {
      playlistOps.clearExpired.run();
    } catch (_) {}

    const cached = playlistOps.get.get(playlistId);
    if (cached) {
      return res.json({
        success: true,
        data: {
          id: cached.playlist_id,
          name: cached.name,
          cover: cached.cover,
          songCount: cached.song_count
        }
      });
    }

    const cookie = decrypt(req.user.cookie);
    const playlist = await netease.getPlaylistDetail(playlistId, cookie);

    const ttlSec = parseInt(process.env.CACHE_TTL) || 86400;
    const expiresAt = toSqliteDatetime(new Date(Date.now() + ttlSec * 1000));

    playlistOps.set.run({
      playlist_id: String(playlistId),
      name: playlist.name || '',
      cover: playlist.cover || '',
      song_count: playlist.songCount || 0,
      songs: JSON.stringify(playlist.tracks || []),
      expires_at: expiresAt
    });

    res.json({
      success: true,
      data: {
        id: String(playlistId),
        name: playlist.name,
        cover: playlist.cover,
        songCount: playlist.songCount
      }
    });
  } catch (e) {
    console.error('解析歌单失败:', e);
    res.status(500).json({ success: false, message: e.message || '解析歌单失败' });
  }
});

router.get('/url', auth, (req, res) => {
  const playlistId = String(req.query.id || '');

  if (!isValidNumericId(playlistId)) {
    return res.status(400).json({ success: false, message: '无效的歌单ID' });
  }

  const playbackToken = createPlaybackToken({
    userId: req.user.id,
    playlistId
  });

  const baseUrl = getBaseUrl(req);
  const hlsUrl = `${baseUrl}/api/hls/${encodeURIComponent(playbackToken)}/${playlistId}/stream.m3u8`;
  const liteUrl = `${baseUrl}/api/playlist/m3u8/${encodeURIComponent(playbackToken)}/${playlistId}/stream.m3u8`;
  const mp4Url = `${baseUrl}/api/mp4/${encodeURIComponent(playbackToken)}/${playlistId}/{songId}.mp4`;

  res.json({
    success: true,
    data: {
      url: hlsUrl,
      urls: [
        {
          type: 'hls',
          label: 'HLS 转码（VRChat 推荐）',
          url: hlsUrl,
          note: 'VRChat 兼容性最佳，带封面视频。首次播放需等待转码，后续自动缓存。'
        },
        {
          type: 'mp4',
          label: 'MP4 封面视频（VRChat 单曲）',
          url: mp4Url,
          note: '封面图 + 音频直封 MP4，无需重编码音频。按单曲生成，首次需等待，后续自动缓存。'
        },
        {
          type: 'lite',
          label: '轻量 M3U8（仅音频）',
          url: liteUrl,
          note: '无需转码，即时播放。VRChat 可能不支持，建议在支持 HLS 直播流的播放器中使用。'
        }
      ],
      default: 'hls'
    }
  });

  const preloadParam = String(req.query.preload || '').toLowerCase();
  const doPreload = preloadParam === '1' || preloadParam === 'true';
  if (!doPreload) return;

  try {
    const token = playbackToken;
    const port = process.env.PORT || 3000;
    const preloadBase = process.env.PRELOAD_BASE_URL || `http://127.0.0.1:${port}`;

    setImmediate(() => {
      try {
        fetch(`${preloadBase}/api/hls/${encodeURIComponent(token)}/${encodeURIComponent(playlistId)}/preload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: 1 })
        }).catch(() => {});
      } catch (_) {}
    });
  } catch (_) {}
});

module.exports = router;
