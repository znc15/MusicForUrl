const express = require('express');
const router = express.Router();
const netease = require('../lib/netease');
const { decrypt } = require('../lib/crypto');
const { playlistOps } = require('../lib/db');
const { auth } = require('../lib/auth');

function isValidNumericId(id) {
  return typeof id === 'string' && /^\d+$/.test(id) && id.length <= 20;
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

  const baseUrl = getBaseUrl(req);
  const url = `${baseUrl}/api/hls/${req.token}/${playlistId}/stream.m3u8`;

  res.json({ success: true, data: { url } });

  try {
    const token = req.token;
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
