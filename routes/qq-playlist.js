const express = require('express');
const router = express.Router();
const qqmusic = require('../lib/qqmusic');
const { decrypt } = require('../lib/crypto');
const { playlistOps, qqUserOps } = require('../lib/db');
const { qqAuth } = require('../lib/qq-auth-middleware');
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

function isLikelyToken(token) {
  return typeof token === 'string' && token.length > 0 && token.length <= 1024;
}

function resolveQQUserFromAccessToken(token, playlistId) {
  const raw = String(token || '');
  if (isLegacyToken(raw)) {
    return qqUserOps.getByToken.get(raw) || null;
  }
  const expectedPlaylistId = playlistId == null ? '' : String(playlistId).trim();
  const verified = verifyPlaybackToken(raw, expectedPlaylistId ? { playlistId: expectedPlaylistId } : {});
  if (!verified.ok) return null;
  return qqUserOps.getById.get(verified.userId) || null;
}

function getBaseUrl(req) {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, '');
  }
  return `${req.protocol}://${req.get('host')}`;
}

function parseQQPlaylistId(input) {
  if (!input) return null;
  const str = String(input).trim();
  if (!str) return null;
  if (/^\d+$/.test(str)) return str;

  // https://y.qq.com/n/ryqq/playlist/1234567890
  const m1 = str.match(/\/playlist\/(\d+)/);
  if (m1) return m1[1];

  // https://i.y.qq.com/n2/m/share/details/taoge.html?id=1234567890
  const m2 = str.match(/[?&]id=(\d+)/);
  if (m2) return m2[1];

  return null;
}

function toSqliteDatetime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function buildQQLiteM3u8(baseUrl, token, playlistId, tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  const segments = [];
  for (const track of list) {
    // QQ 音乐使用 mid 作为标识
    const mid = track && (track.mid || track.id) ? String(track.mid || track.id) : '';
    if (!mid) continue;

    const duration = normalizeDurationSeconds(track.duration);
    const title = sanitizeM3uTitle(`${track.artist ? track.artist + ' - ' : ''}${track.name || mid}`);
    const url =
      `${baseUrl}/api/qq/song/${encodeURIComponent(token)}/${encodeURIComponent(mid)}?playlist=${encodeURIComponent(playlistId)}`;
    segments.push({ duration, title, url });
  }
  return buildLiteM3u8({ segments });
}

async function ensureQQPlaylistCached(playlistId, cookie) {
  try {
    playlistOps.clearExpired.run();
  } catch (_) {}

  // 使用 qq: 前缀区分
  const cacheKey = `qq:${playlistId}`;
  const cached = playlistOps.get.get(cacheKey);
  if (cached) {
    try {
      const songs = JSON.parse(cached.songs || '[]');
      if (Array.isArray(songs)) {
        return { playlist: cached, tracks: songs };
      }
    } catch (_) {}
  }

  const playlist = await qqmusic.getPlaylistDetail(playlistId, cookie);
  const ttlSec = parseInt(process.env.CACHE_TTL) || 86400;
  const expiresAt = toSqliteDatetime(new Date(Date.now() + ttlSec * 1000));

  playlistOps.set.run({
    playlist_id: cacheKey,
    name: playlist.name || '',
    cover: playlist.cover || '',
    song_count: playlist.songCount || 0,
    songs: JSON.stringify(playlist.tracks || []),
    expires_at: expiresAt
  });

  return {
    playlist: { playlist_id: cacheKey, name: playlist.name, cover: playlist.cover },
    tracks: playlist.tracks || []
  };
}

// ─── Lite M3U8 ────────────────────────────────────────────

router.get('/m3u8/:token/:playlistId/lite.m3u8', async (req, res) => {
  const token = String(req.params.token || '');
  const playlistId = String(req.params.playlistId || '');

  if (!isLikelyToken(token)) {
    return res.status(400).type('text/plain').send('Invalid token');
  }
  if (!/^\d+$/.test(playlistId)) {
    return res.status(400).type('text/plain').send('Invalid playlist id');
  }

  const ua = req.headers['user-agent'] || '';
  const ip = req.ip || req.connection?.remoteAddress || '';
  console.log(`[M3U8 请求] QQ 歌单=${playlistId} IP=${ip} UA=${ua}`);

  const user = resolveQQUserFromAccessToken(token, playlistId);
  if (!user) {
    console.log(`[M3U8 请求] token 验证失败: ${token.slice(0, 20)}...`);
    return res.status(401).type('text/plain').send('Token expired');
  }

  try {
    const cookie = decrypt(user.cookie);
    const { tracks } = await ensureQQPlaylistCached(playlistId, cookie);

    const baseUrl = getBaseUrl(req);
    const m3u8 = buildQQLiteM3u8(baseUrl, token, playlistId, tracks);

    console.log(`[M3U8 响应] 歌单=${playlistId} 曲目数=${tracks.length} 大小=${m3u8.length}字节`);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(m3u8);
  } catch (e) {
    console.error('生成QQ音乐 lite m3u8 失败:', e);
    res.status(500).type('text/plain').send('Failed to build m3u8');
  }
});

// ─── 用户歌单 ─────────────────────────────────────────────

router.get('/user', qqAuth, async (req, res) => {
  const rawLimit = parseInt(req.query.limit, 10);
  const rawOffset = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 30;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  try {
    const cookie = decrypt(req.qqUser.cookie);
    const result = await qqmusic.getUserPlaylists(req.qqUser.qq_uin, cookie);
    const all = Array.isArray(result.playlists) ? result.playlists : [];
    const total = Number.isFinite(result.count) ? result.count : all.length;
    const pageData = all.slice(offset, offset + limit);

    res.json({
      success: true,
      data: pageData,
      total
    });
  } catch (e) {
    console.error('获取QQ音乐用户歌单失败:', e);
    res.status(500).json({ success: false, message: e.message || '获取歌单失败' });
  }
});

// ─── 歌单解析 ─────────────────────────────────────────────

router.get('/parse', qqAuth, async (req, res) => {
  const input = req.query.url;
  const playlistId = parseQQPlaylistId(input);

  if (!playlistId) {
    return res.status(400).json({ success: false, message: '无效的QQ音乐歌单链接或ID' });
  }

  try {
    try {
      playlistOps.clearExpired.run();
    } catch (_) {}

    const cacheKey = `qq:${playlistId}`;
    const cached = playlistOps.get.get(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: {
          id: playlistId,
          name: cached.name,
          cover: cached.cover,
          songCount: cached.song_count
        }
      });
    }

    const cookie = decrypt(req.qqUser.cookie);
    const playlist = await qqmusic.getPlaylistDetail(playlistId, cookie);

    const ttlSec = parseInt(process.env.CACHE_TTL) || 86400;
    const expiresAt = toSqliteDatetime(new Date(Date.now() + ttlSec * 1000));

    playlistOps.set.run({
      playlist_id: cacheKey,
      name: playlist.name || '',
      cover: playlist.cover || '',
      song_count: playlist.songCount || 0,
      songs: JSON.stringify(playlist.tracks || []),
      expires_at: expiresAt
    });

    res.json({
      success: true,
      data: {
        id: playlistId,
        name: playlist.name,
        cover: playlist.cover,
        songCount: playlist.songCount
      }
    });
  } catch (e) {
    console.error('解析QQ音乐歌单失败:', e);
    res.status(500).json({ success: false, message: e.message || '解析歌单失败' });
  }
});

// ─── 生成播放链接 ──────────────────────────────────────────

router.get('/url', qqAuth, (req, res) => {
  const playlistId = String(req.query.id || '');

  if (!/^\d+$/.test(playlistId)) {
    return res.status(400).json({ success: false, message: '无效的歌单ID' });
  }

  const playbackToken = createPlaybackToken({
    userId: req.qqUser.id,
    playlistId
  });

  const baseUrl = getBaseUrl(req);
  const liteUrl = `${baseUrl}/api/qq/playlist/m3u8/${encodeURIComponent(playbackToken)}/${playlistId}/lite.m3u8`;

  res.json({
    success: true,
    data: {
      url: liteUrl,
      urls: [
        {
          type: 'lite',
          label: '轻量 M3U8（QQ音乐）',
          url: liteUrl,
          note: '大部分 VRChat 播放器可用；但不会显示视频画面（仅音频），兼容性仍取决于播放器实现。'
        }
      ],
      default: 'lite'
    }
  });
});

module.exports = router;
