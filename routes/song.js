const express = require('express');
const router = express.Router();
const netease = require('../lib/netease');
const { decrypt } = require('../lib/crypto');
const { userOps, playLogOps, playlistOps } = require('../lib/db');

function isValidNumericId(id) {
  return typeof id === 'string' && /^\d+$/.test(id) && id.length <= 20;
}

function isValidToken(token) {
  return typeof token === 'string' && /^[a-f0-9]{32}$/i.test(token);
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

router.get('/:token/:songId', async (req, res) => {
  const { token, songId } = req.params;
  const { playlist } = req.query;
  
  if (!isValidToken(token)) {
    return res.status(400).json({ error: '无效的token格式' });
  }
  if (!isValidNumericId(songId)) {
    return res.status(400).json({ error: '无效的歌曲ID' });
  }
  if (playlist && !isValidNumericId(playlist)) {
    return res.status(400).json({ error: '无效的歌单ID' });
  }
  
  const user = userOps.getByToken.get(token);
  if (!user) {
    return res.status(401).json({ error: '无效的访问令牌' });
  }
  
  try {
    const cacheKey = `${user.id}:${songId}`;
    const cached = urlCache.get(cacheKey);
    
    if (cached && cached.expires > Date.now()) {
      logPlay(user.id, songId, playlist);
      return res.redirect(302, cached.url);
    }
    
    const cookie = decrypt(user.cookie);
    const url = await netease.getSongUrl(songId, cookie);
    
    if (!url) {
      return res.status(404).json({ error: '无法获取歌曲，可能无版权或需要VIP' });
    }
    
    urlCache.set(cacheKey, {
      url,
      expires: Date.now() + CACHE_DURATION
    });
    evictOldestUrlCache();
    
    logPlay(user.id, songId, playlist);
    
    res.redirect(302, url);
  } catch (e) {
    console.error('获取歌曲URL失败:', e);
    res.status(500).json({ error: '获取歌曲失败' });
  }
});

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
