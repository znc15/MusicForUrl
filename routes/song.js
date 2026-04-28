const express = require('express');
const router = express.Router();
const netease = require('../lib/netease');
const { decrypt } = require('../lib/crypto');
const { userOps, playLogOps, playlistOps } = require('../lib/db');
const { verifyPlaybackToken, isLegacyToken } = require('../lib/playback-token');

function isValidNumericId(id) {
  return typeof id === 'string' && /^\d+$/.test(id) && id.length <= 20;
}

function isLikelyToken(token) {
  return typeof token === 'string' && token.length > 0 && token.length <= 1024;
}

// 网易云 CDN 返回的 URL 可能是 http://，在 HTTPS 站点下会被 mixed content 阻止
function ensureHttpsUrl(url) {
  if (!url) return url;
  return url.replace(/^http:\/\//, 'https://');
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

const urlCache = new Map();
const CACHE_DURATION = 10 * 60 * 1000;
const URL_CACHE_MAX = 2000;

function evictOldestUrlCache() {
  if (urlCache.size <= URL_CACHE_MAX) return;
  
  const toEvict = Math.ceil(urlCache.size * 0.2);
  const entries = Array.from(urlCache.entries())
    .sort((a, b) => a[1].expires - b[1].expires)
    .slice(0, toEvict);
  
  for (const [key] of entries) {
    urlCache.delete(key);
  }
}

// FFmpeg/VLC 的 HLS 解析器会检查 segment URL 扩展名，
// 不在允许列表中的会被拒绝。同时注册带 .mp3 后缀和无后缀两种路由。
router.get('/:token/:songId.mp3', handleSongRequest);
router.get('/:token/:songId', handleSongRequest);

async function handleSongRequest(req, res) {
  const token = req.params.token;
  const songId = req.params.songId;
  const { playlist } = req.query;
  
  if (!isLikelyToken(token)) {
    return res.status(400).json({ error: '无效的token格式' });
  }
  if (!isValidNumericId(songId)) {
    return res.status(400).json({ error: '无效的歌曲ID' });
  }
  if (playlist && !isValidNumericId(playlist)) {
    return res.status(400).json({ error: '无效的歌单ID' });
  }
  if (!playlist && !isLegacyToken(token)) {
    return res.status(400).json({ error: '签名链接缺少歌单ID' });
  }
  
  const user = resolveUserFromAccessToken(token, playlist);
  if (!user) {
    return res.status(401).json({ error: '无效的访问令牌' });
  }
  
  try {
    const cacheKey = `${user.id}:${songId}`;
    const cached = urlCache.get(cacheKey);
    
    if (cached && cached.expires > Date.now()) {
      logPlay(user.id, songId, playlist);
      return res.redirect(302, ensureHttpsUrl(cached.url));
    }

    const cookie = decrypt(user.cookie);
    const url = await netease.getSongUrl(songId, cookie);

    if (!url) {
      return res.status(404).json({ error: '无法获取歌曲，可能无版权或需要VIP' });
    }

    const httpsUrl = ensureHttpsUrl(url);
    urlCache.set(cacheKey, {
      url: httpsUrl,
      expires: Date.now() + CACHE_DURATION
    });
    evictOldestUrlCache();

    logPlay(user.id, songId, playlist);

    res.redirect(302, httpsUrl);
  } catch (e) {
    console.error('获取歌曲URL失败:', e);
    res.status(500).json({ error: '获取歌曲失败' });
  }
}

async function logPlay(userId, songId, playlistId) {
  try {
    let songName = '未知';
    let artist = '未知';
    
    if (playlistId) {
      const cached = playlistOps.get.get(playlistId);
      if (cached) {
        try {
          const songs = JSON.parse(cached.songs);
          const song = Array.isArray(songs) ? songs.find(s => String(s.id) === String(songId)) : null;
          if (song) {
            songName = song.name || songName;
            artist = song.artist || artist;
          }
        } catch (parseErr) {
          console.error(`[播放记录] 歌单缓存损坏 ${playlistId}:`, parseErr.message);
        }
      }
    }

    playLogOps.log.run({
      user_id: userId,
      playlist_id: playlistId || null,
      song_id: songId,
      song_name: songName,
      artist: artist
    });
  } catch (e) {
    console.error('记录播放失败:', e);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of urlCache.entries()) {
    if (value.expires < now) {
      urlCache.delete(key);
    }
  }
}, 5 * 60 * 1000);

module.exports = router;
