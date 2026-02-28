const express = require('express');
const router = express.Router();
const netease = require('../lib/netease');
const { decrypt } = require('../lib/crypto');
const { playlistOps, userOps } = require('../lib/db');
const {
  createPlaybackToken,
  verifyPlaybackToken,
  isLegacyToken
} = require('../lib/playback-token');
const { getOrBindBg } = require('../lib/lite-video-bg');
const { auth } = require('../lib/auth');
const DEFAULT_COVER_URL =
  process.env.DEFAULT_COVER_URL ||
  'https://p1.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg';

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

function sanitizeM3uTitle(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildLiteM3u8(baseUrl, token, playlistId, tracks, options = {}) {
  const backgroundImage = typeof options.backgroundImage === 'string' ? options.backgroundImage.trim() : '';
  const list = Array.isArray(tracks) ? tracks : [];
  const durations = list
    .map(t => Math.floor(Number(t?.duration) || 0))
    .filter(n => Number.isFinite(n) && n > 0);

  const target = Math.max(10, ...durations);

  let out = '';
  out += '#EXTM3U\n';
  out += '#EXT-X-VERSION:3\n';
  out += `#EXT-X-TARGETDURATION:${target}\n`;
  out += '#EXT-X-MEDIA-SEQUENCE:0\n';
  out += '#EXT-X-PLAYLIST-TYPE:VOD\n';
  if (backgroundImage) {
    out += '#EXT-X-MFU-MODE:audio-only-lite-video\n';
    out += `#EXT-X-MFU-BACKGROUND:${backgroundImage}\n`;
  }

  for (const track of list) {
    const id = track && track.id != null ? String(track.id) : '';
    if (!/^\d+$/.test(id)) continue;

    const duration = Math.max(0, Math.floor(Number(track.duration) || 0));
    const title = sanitizeM3uTitle(`${track.artist ? track.artist + ' - ' : ''}${track.name || id}`);
    const bgQuery = backgroundImage ? `&bg=${encodeURIComponent(backgroundImage)}` : '';
    const url =
      `${baseUrl}/api/song/${encodeURIComponent(token)}/${encodeURIComponent(id)}?playlist=${encodeURIComponent(playlistId)}${bgQuery}`;
    out += `#EXTINF:${duration},${title}\n`;
    out += `${url}\n`;
  }

  out += '#EXT-X-ENDLIST\n';
  return out;
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

router.get('/m3u8/:token/:playlistId/lite.m3u8', async (req, res) => {
  const token = String(req.params.token || '');
  const playlistId = String(req.params.playlistId || '');

  if (!isLikelyToken(token)) {
    return res.status(400).type('text/plain').send('Invalid token');
  }
  if (!isValidNumericId(playlistId)) {
    return res.status(400).type('text/plain').send('Invalid playlist id');
  }

  const user = resolveUserFromAccessToken(token, playlistId);
  if (!user) {
    return res.status(401).type('text/plain').send('Token expired');
  }

  try {
    const cookie = decrypt(user.cookie);
    const { tracks } = await ensurePlaylistCached(playlistId, cookie);

    const baseUrl = getBaseUrl(req);
    const m3u8 = buildLiteM3u8(baseUrl, token, playlistId, tracks);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(m3u8);
  } catch (e) {
    console.error('生成 lite m3u8 失败:', e);
    res.status(500).type('text/plain').send('Failed to build m3u8');
  }
});

router.get('/m3u8/:token/:playlistId/lite-video.m3u8', async (req, res) => {
  const token = String(req.params.token || '');
  const playlistId = String(req.params.playlistId || '');

  if (!isLikelyToken(token)) {
    return res.status(400).type('text/plain').send('Invalid token');
  }
  if (!isValidNumericId(playlistId)) {
    return res.status(400).type('text/plain').send('Invalid playlist id');
  }

  const user = resolveUserFromAccessToken(token, playlistId);
  if (!user) {
    return res.status(401).type('text/plain').send('Token expired');
  }

  try {
    const cookie = decrypt(user.cookie);
    const { playlist, tracks } = await ensurePlaylistCached(playlistId, cookie);
    const fallbackCover = String(playlist?.cover || DEFAULT_COVER_URL || '');
    const backgroundImage = await getOrBindBg({
      token,
      playlistId,
      source: 'netease',
      fallbackUrl: fallbackCover
    });

    const baseUrl = getBaseUrl(req);
    const m3u8 = buildLiteM3u8(baseUrl, token, playlistId, tracks, { backgroundImage });

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(m3u8);
  } catch (e) {
    console.error('生成 lite-video m3u8 失败:', e);
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

router.get('/url', auth, async (req, res) => {
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
  const liteUrl = `${baseUrl}/api/playlist/m3u8/${encodeURIComponent(playbackToken)}/${playlistId}/lite.m3u8`;
  const liteVideoUrl = `${baseUrl}/api/playlist/m3u8/${encodeURIComponent(playbackToken)}/${playlistId}/lite-video.m3u8`;
  const cachedPlaylist = playlistOps.get.get(playlistId);
  const fallbackCover = String(cachedPlaylist?.cover || DEFAULT_COVER_URL || '');
  let backgroundImage = fallbackCover;
  try {
    const picked = await getOrBindBg({
      token: playbackToken,
      playlistId,
      source: 'netease',
      fallbackUrl: fallbackCover
    });
    if (picked) backgroundImage = picked;
  } catch (_) {}

  res.json({
    success: true,
    data: {
      url: liteUrl,
      urls: [
        {
          type: 'lite',
          label: '轻量 M3U8（优先推荐）',
          url: liteUrl,
          note: '大部分 VRChat 播放器可用；但不会显示视频画面（仅音频），兼容性仍取决于播放器实现。若遇不播放再切换 HLS。'
        },
        {
          type: 'lite_video',
          label: '视频轻量 M3U8（随机背景图）',
          url: liteVideoUrl,
          note: '同一播放链接内固定随机背景图；图片 API 异常会自动回退到歌单封面。'
        },
        {
          type: 'hls',
          label: 'HLS（转码分片，兼容更稳）',
          url: hlsUrl,
          note: '会消耗更多 CPU/磁盘；当轻量模式无法播放时再使用。'
        }
      ],
      default: 'lite',
      backgroundImage
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
module.exports.__testHooks = {
  buildLiteM3u8
};
