const express = require('express');
const router = express.Router();
const qqmusic = require('../lib/qqmusic');
const { decrypt } = require('../lib/crypto');
const { qqUserOps, playLogOps, playlistOps } = require('../lib/db');
const { verifyPlaybackToken, isLegacyToken } = require('../lib/playback-token');

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

router.get('/:token/:songMid', async (req, res) => {
  const { token, songMid } = req.params;
  const { playlist } = req.query;

  if (!isLikelyToken(token)) {
    return res.status(400).json({ error: '无效的token格式' });
  }
  if (!songMid || songMid.length > 30) {
    return res.status(400).json({ error: '无效的歌曲ID' });
  }

  const playlistKey = String(playlist || '').trim();
  const expectedPlaylistId = /^\d+$/.test(playlistKey) ? playlistKey : undefined;
  const user = resolveQQUserFromAccessToken(token, expectedPlaylistId);
  if (!user) {
    return res.status(401).json({ error: '无效的访问令牌' });
  }

  try {
    const cacheKey = `qq:${user.id}:${songMid}`;
    const cached = urlCache.get(cacheKey);

    if (cached && cached.expires > Date.now()) {
      logPlay(user.id, songMid, playlist);
      return res.redirect(302, cached.url);
    }

    const cookie = decrypt(user.cookie);
    const url = await qqmusic.getSongUrl(songMid, cookie);

    if (!url) {
      return res.status(404).json({ error: '无法获取歌曲，可能无版权或需要VIP' });
    }

    urlCache.set(cacheKey, {
      url,
      expires: Date.now() + CACHE_DURATION
    });
    evictOldestUrlCache();

    logPlay(user.id, songMid, playlist);

    res.redirect(302, url);
  } catch (e) {
    console.error('获取QQ音乐歌曲URL失败:', e);
    res.status(500).json({ error: '获取歌曲失败' });
  }
});

async function logPlay(userId, songMid, playlistId) {
  try {
    let songName = '未知';
    let artist = '未知';

    if (playlistId) {
      const cacheKey = `qq:${playlistId}`;
      const cached = playlistOps.get.get(cacheKey);
      if (cached) {
        try {
          const songs = JSON.parse(cached.songs);
          const song = Array.isArray(songs) ? songs.find(s =>
            String(s.mid) === String(songMid) || String(s.id) === String(songMid)
          ) : null;
          if (song) {
            songName = song.name || songName;
            artist = song.artist || artist;
          }
        } catch (parseErr) {
          console.error(`[播放记录] QQ音乐歌单缓存损坏 ${playlistId}:`, parseErr.message);
        }
      }
    }

    playLogOps.log.run({
      user_id: userId,
      playlist_id: playlistId ? `qq:${playlistId}` : null,
      song_id: `qq:${songMid}`,
      song_name: songName,
      artist: artist
    });
  } catch (e) {
    console.error('记录QQ音乐播放失败:', e);
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
