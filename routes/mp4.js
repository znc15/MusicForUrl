const express = require('express');
const router = express.Router();
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const netease = require('../lib/netease');
const qqmusic = require('../lib/qqmusic');
const { decrypt } = require('../lib/crypto');
const { userOps, qqUserOps, playlistOps, playLogOps } = require('../lib/db');
const { verifyPlaybackToken, isLegacyToken } = require('../lib/playback-token');

// ─── 工具函数 ──────────────────────────────────────────────

function isValidNumericId(id) {
  return typeof id === 'string' && /^\d+$/.test(id) && id.length <= 20;
}

function isLikelyToken(token) {
  return typeof token === 'string' && token.length > 0 && token.length <= 1024;
}

function resolveUserFromAccessToken(token, playlistId, source = 'netease') {
  const raw = String(token || '');
  const tokenStore = source === 'qq' ? qqUserOps : userOps;
  if (isLegacyToken(raw)) {
    return tokenStore.getByToken.get(raw) || null;
  }
  const verified = verifyPlaybackToken(raw, { playlistId: String(playlistId || '') });
  if (!verified.ok) return null;
  return tokenStore.getById.get(verified.userId) || null;
}

function getSourceFromReq(req) {
  const base = String(req.baseUrl || '');
  if (base.startsWith('/api/qq/mp4')) return 'qq';
  return 'netease';
}

function getSourceAdapter(source) {
  if (source === 'qq') {
    return {
      source: 'qq',
      getSongUrl: (songId, cookie) => qqmusic.getSongUrl(String(songId), cookie),
      getPlaylistDetail: (playlistId, cookie) => qqmusic.getPlaylistDetail(String(playlistId), cookie),
      toPlayLogPlaylistId: (playlistId) => `qq:${String(playlistId)}`,
      toPlayLogSongId: (songId) => `qq:${String(songId)}`
    };
  }
  return {
    source: 'netease',
    getSongUrl: (songId, cookie) => netease.getSongUrl(String(songId), cookie),
    getPlaylistDetail: (playlistId, cookie) => netease.getPlaylistDetail(String(playlistId), cookie),
    toPlayLogPlaylistId: (playlistId) => String(playlistId),
    toPlayLogSongId: (songId) => String(songId)
  };
}

function getPlaylistCacheKey(playlistId, source) {
  if (source === 'qq') return `qq:${String(playlistId || '')}`;
  return String(playlistId || '');
}

function getSongIdForTrack(song, source) {
  if (source === 'qq') {
    return String((song && (song.mid || song.id)) || '').trim();
  }
  return String((song && song.id) || '').trim();
}

function isValidSongIdForSource(songId, source) {
  const raw = String(songId || '').trim();
  if (!raw) return false;
  if (source === 'qq') {
    return /^[A-Za-z0-9]+$/.test(raw) && raw.length <= 64;
  }
  return isValidNumericId(raw);
}

function getBaseUrl(req) {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, '');
  }
  return `${req.protocol}://${req.get('host')}`;
}

// ─── 封面处理 ──────────────────────────────────────────────

const DEFAULT_COVER_URL =
  process.env.DEFAULT_COVER_URL ||
  'https://p1.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg';

const COVER_OUTPUT = {
  width: parseInt(process.env.COVER_WIDTH) || 1920,
  height: parseInt(process.env.COVER_HEIGHT) || 1080
};

function optimizeNeteaseCoverUrl(rawUrl, size = 1080) {
  const url = (rawUrl == null) ? '' : String(rawUrl).trim();
  if (!/^https?:\/\//i.test(url)) return '';
  try {
    const u = new URL(url);
    if (!/^p\d+\.music\.126\.net$/i.test(u.hostname)) return url;
    u.searchParams.set('param', `${size}y${size}`);
    return u.toString();
  } catch (_) {
    return url;
  }
}

function pickCoverUrlForSong(song, playlistCoverUrl) {
  const songCover = song && song.cover ? String(song.cover) : '';
  const base = songCover || playlistCoverUrl || DEFAULT_COVER_URL;
  return optimizeNeteaseCoverUrl(base, 1080) || DEFAULT_COVER_URL;
}

// ─── 目录与缓存 ────────────────────────────────────────────

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const TEMP_DIR = path.join(__dirname, '..', 'data', 'temp');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const MP4_CACHE_VERSION = 1;

function getMp4CacheKey(songId, source) {
  const src = source === 'qq' ? 'qq' : 'netease';
  return `${src}:mp4:${String(songId || '').trim()}`;
}

function toFsCacheKey(songCacheKey) {
  return encodeURIComponent(String(songCacheKey || ''));
}

function getMp4CacheDir(mp4CacheKey) {
  return path.join(CACHE_DIR, toFsCacheKey(mp4CacheKey));
}

function getMp4FilePath(mp4CacheKey) {
  return path.join(getMp4CacheDir(mp4CacheKey), 'song.mp4');
}

function getMp4InfoPath(mp4CacheKey) {
  return path.join(getMp4CacheDir(mp4CacheKey), 'info.json');
}

// ─── 并发控制 ──────────────────────────────────────────────

const JOB_LIMITS = {
  maxConcurrentJobs: parseInt(process.env.MP4_MAX_CONCURRENT_JOBS) || 4,
  maxQueueSize: parseInt(process.env.MP4_MAX_QUEUE) || 20,
  downloadTimeout: parseInt(process.env.MP4_DOWNLOAD_TIMEOUT) || 60000,
  downloadMaxSize: parseInt(process.env.MP4_DOWNLOAD_MAX_SIZE) || 100 * 1024 * 1024,
  downloadMaxRedirects: 5,
  ffmpegTimeout: parseInt(process.env.MP4_FFMPEG_TIMEOUT) || 180000,
};

class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return true;
    }
    if (this.queue.length >= JOB_LIMITS.maxQueueSize) {
      return false;
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release() {
    this.current--;
    if (this.queue.length > 0 && this.current < this.max) {
      this.current++;
      const next = this.queue.shift();
      next(true);
    }
  }

  get waiting() { return this.queue.length; }
  get running() { return this.current; }
}

const jobSemaphore = new Semaphore(JOB_LIMITS.maxConcurrentJobs);
const generatingLocks = new Map();

// ─── 下载安全 ──────────────────────────────────────────────

const DEFAULT_DOWNLOAD_ALLOW_PATTERNS = [
  /^m\d+[a-z]*\.music\.126\.net$/i,
  /^p\d+\.music\.126\.net$/i,
  /^music\.126\.net$/i,
  /^[a-z0-9]+\.y\.qq\.com$/i,
  /^y\.gtimg\.cn$/i,
  /^[a-z0-9]+\.stream\.qqmusic\.qq\.com$/i,
  /^dl\.stream\.qqmusic\.qq\.com$/i,
  /^isure\.stream\.qqmusic\.qq\.com$/i,
  /^ws\.stream\.qqmusic\.qq\.com$/i,
  /^[a-z0-9-]+\.mcobj\.com$/i,
];

function parseExtraAllowPatterns() {
  const extra = process.env.MP4_DOWNLOAD_ALLOW_HOSTS || process.env.HLS_DOWNLOAD_ALLOW_HOSTS;
  if (!extra) return [];
  return extra.split(',').map(s => s.trim()).filter(Boolean).map(pattern => {
    try {
      return new RegExp(pattern, 'i');
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
}

const DOWNLOAD_ALLOW_PATTERNS = [...DEFAULT_DOWNLOAD_ALLOW_PATTERNS, ...parseExtraAllowPatterns()];

const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 50 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 50 });

function isDownloadUrlAllowed(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch (e) {
    return { allowed: false, reason: 'Invalid URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { allowed: false, reason: `Protocol not allowed: ${u.protocol}` };
  }
  const hostname = u.hostname.toLowerCase();
  const matched = DOWNLOAD_ALLOW_PATTERNS.some(pattern => pattern.test(hostname));
  if (!matched) {
    return { allowed: false, reason: `Host not allowed: ${hostname}` };
  }
  return { allowed: true };
}

// ─── 文件下载 ──────────────────────────────────────────────

function downloadFile(url, filePath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount >= JOB_LIMITS.downloadMaxRedirects) {
      return reject(new Error('Too many redirects'));
    }

    const urlCheck = isDownloadUrlAllowed(url);
    if (!urlCheck.allowed) {
      return reject(new Error(`Download blocked: ${urlCheck.reason}`));
    }

    const isHttps = /^https:/i.test(url);
    const protocol = isHttps ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://music.163.com/'
      },
      agent: isHttps ? HTTPS_AGENT : HTTP_AGENT,
      timeout: JOB_LIMITS.downloadTimeout
    };

    const file = fs.createWriteStream(filePath);
    let downloadedSize = 0;
    let aborted = false;

    const req = protocol.get(url, options, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        file.close();
        fs.unlink(filePath, () => {});

        const redirectLocation = response.headers.location;
        if (!redirectLocation) {
          return reject(new Error('Redirect without location'));
        }

        let redirectUrl = '';
        try {
          redirectUrl = new URL(redirectLocation, url).toString();
        } catch (_) {
          return reject(new Error('Redirect with invalid location'));
        }

        const redirectCheck = isDownloadUrlAllowed(redirectUrl);
        if (!redirectCheck.allowed) {
          return reject(new Error(`Redirect blocked: ${redirectCheck.reason}`));
        }

        return downloadFile(redirectUrl, filePath, redirectCount + 1).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(filePath, () => {});
        return reject(new Error(`HTTP ${response.statusCode}`));
      }

      const contentLength = parseInt(response.headers['content-length']);
      if (contentLength && contentLength > JOB_LIMITS.downloadMaxSize) {
        req.destroy();
        file.close();
        fs.unlink(filePath, () => {});
        return reject(new Error(`File too large: ${contentLength} bytes`));
      }

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (downloadedSize > JOB_LIMITS.downloadMaxSize) {
          aborted = true;
          req.destroy();
          file.close();
          fs.unlink(filePath, () => {});
          reject(new Error(`Download exceeded max size: ${downloadedSize} bytes`));
        }
      });

      response.pipe(file);
      file.on('finish', () => {
        if (!aborted) {
          file.close();
          resolve(filePath);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      file.close();
      fs.unlink(filePath, () => {});
      reject(new Error('Download timeout'));
    });

    req.on('error', (err) => {
      file.close();
      fs.unlink(filePath, () => {});
      reject(err);
    });
  });
}

// ─── FFmpeg ────────────────────────────────────────────────

function findFFmpeg() {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return 'ffmpeg';
  } catch (e) {}

  if (os.platform() === 'win32') {
    const wingetPath = path.join(
      process.env.LOCALAPPDATA || '',
      'Microsoft', 'WinGet', 'Packages'
    );
    if (fs.existsSync(wingetPath)) {
      const searchFFmpeg = (dir) => {
        try {
          const items = fs.readdirSync(dir);
          for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              const result = searchFFmpeg(fullPath);
              if (result) return result;
            } else if (item === 'ffmpeg.exe') {
              return fullPath;
            }
          }
        } catch (e) {}
        return null;
      };
      const found = searchFFmpeg(wingetPath);
      if (found) return found;
    }

    const commonPaths = [
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
      path.join(process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey', 'bin', 'ffmpeg.exe')
    ];
    for (const p of commonPaths) {
      if (fs.existsSync(p)) return p;
    }
  }

  return 'ffmpeg';
}

const FFMPEG_PATH = findFFmpeg();

// ─── MP4 生成（封面 + 音频 copy）──────────────────────────

async function generateMp4(mp4CacheKey, audioUrl, coverUrl, songDuration) {
  // 检查是否已在生成中
  if (generatingLocks.has(mp4CacheKey)) {
    return generatingLocks.get(mp4CacheKey);
  }

  const promise = _doGenerateMp4(mp4CacheKey, audioUrl, coverUrl, songDuration);
  generatingLocks.set(mp4CacheKey, promise);

  try {
    const result = await promise;
    return result;
  } finally {
    generatingLocks.delete(mp4CacheKey);
  }
}

async function _doGenerateMp4(mp4CacheKey, audioUrl, coverUrl, songDuration) {
  const acquired = await jobSemaphore.acquire();
  if (!acquired) {
    throw new Error('服务繁忙，请稍后重试');
  }

  const timestamp = Date.now();
  const safeTempKey = toFsCacheKey(mp4CacheKey);
  const tempAudio = path.join(TEMP_DIR, `${safeTempKey}_${timestamp}.audio`);
  const tempCover = path.join(TEMP_DIR, `${safeTempKey}_${timestamp}.jpg`);
  const tempMp4 = path.join(TEMP_DIR, `${safeTempKey}_${timestamp}.mp4`);
  const cacheDir = getMp4CacheDir(mp4CacheKey);
  const destMp4 = getMp4FilePath(mp4CacheKey);
  const destInfo = getMp4InfoPath(mp4CacheKey);

  const cleanup = () => {
    fs.unlink(tempAudio, () => {});
    fs.unlink(tempCover, () => {});
    fs.unlink(tempMp4, () => {});
  };

  const releaseAndCleanup = () => {
    cleanup();
    jobSemaphore.release();
  };

  try {
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    console.log(`[MP4] 正在下载: ${mp4CacheKey} (并发: ${jobSemaphore.running}/${JOB_LIMITS.maxConcurrentJobs}, 等待: ${jobSemaphore.waiting})`);

    await Promise.all([
      downloadFile(audioUrl, tempAudio),
      downloadFile(coverUrl, tempCover)
    ]);

    console.log(`[MP4] 正在封装: ${mp4CacheKey}`);

    const vf = [
      `scale=${COVER_OUTPUT.width}:${COVER_OUTPUT.height}:force_original_aspect_ratio=decrease`,
      `pad=${COVER_OUTPUT.width}:${COVER_OUTPUT.height}:(ow-iw)/2:(oh-ih)/2`,
      'setsar=1'
    ].join(',');

    // MP4 copy：只编码封面静态图片，音频直接复制不重编码
    const ffmpegArgs = [
      '-loop', '1',
      '-framerate', '1',
      '-i', tempCover,
      '-i', tempAudio,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'stillimage',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      '-vf', vf,
      '-r', '1',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-shortest',
      '-y',
      tempMp4
    ];

    await runFFmpeg(ffmpegArgs, mp4CacheKey);

    // 移动到缓存
    fs.renameSync(tempMp4, destMp4);

    const stat = fs.statSync(destMp4);
    const info = {
      version: MP4_CACHE_VERSION,
      cacheKey: mp4CacheKey,
      size: stat.size,
      duration: songDuration || 0,
      createdAt: Date.now(),
      video: { width: COVER_OUTPUT.width, height: COVER_OUTPUT.height }
    };
    fs.writeFileSync(destInfo, JSON.stringify(info, null, 2), 'utf8');

    console.log(`[MP4] 封装完成: ${mp4CacheKey} 大小=${(stat.size / 1024 / 1024).toFixed(1)}MB`);

    releaseAndCleanup();
    return info;

  } catch (e) {
    releaseAndCleanup();
    throw e;
  }
}

function runFFmpeg(ffmpegArgs, mp4CacheKey) {
  return new Promise((resolve, reject) => {
    let stallTimer = null;
    let ffmpegKilled = false;
    let ffmpegError = '';
    let lastActivityAt = Date.now();

    function markActivity() {
      lastActivityAt = Date.now();
    }

    const ffmpegProcess = spawn(FFMPEG_PATH, ffmpegArgs);

    ffmpegProcess.stderr.on('data', (data) => {
      ffmpegError += data.toString();
      markActivity();
    });

    stallTimer = setInterval(() => {
      if (ffmpegKilled) return;
      if (Date.now() - lastActivityAt <= JOB_LIMITS.ffmpegTimeout) return;
      ffmpegKilled = true;
      try { ffmpegProcess.kill('SIGKILL'); } catch (_) {}
      console.error(`[MP4] FFmpeg无输出超时被终止: ${mp4CacheKey}`);
    }, 1000);

    ffmpegProcess.on('error', (err) => {
      clearInterval(stallTimer);
      reject(err);
    });

    ffmpegProcess.on('close', (code) => {
      clearInterval(stallTimer);

      if (ffmpegKilled) {
        reject(new Error('FFmpeg无输出超时'));
        return;
      }

      if (code !== 0) {
        reject(new Error(`FFmpeg退出码: ${code}, 错误: ${ffmpegError.substring(0, 300)}`));
        return;
      }

      resolve();
    });
  });
}

// ─── 播放记录 ──────────────────────────────────────────────

function logPlay(userId, songId, playlistId, adapter) {
  try {
    let songName = '未知';
    let artist = '未知';

    if (playlistId) {
      const cacheKey = getPlaylistCacheKey(playlistId, adapter.source);
      const cached = playlistOps.get.get(cacheKey);
      if (cached) {
        try {
          const songs = JSON.parse(cached.songs);
          const idField = adapter.source === 'qq' ? 'mid' : 'id';
          const song = Array.isArray(songs) ? songs.find(s =>
            String(s[idField] || s.id) === String(songId)
          ) : null;
          if (song) {
            songName = song.name || songName;
            artist = song.artist || artist;
          }
        } catch (_) {}
      }
    }

    playLogOps.log.run({
      user_id: userId,
      playlist_id: adapter.toPlayLogPlaylistId(playlistId),
      song_id: adapter.toPlayLogSongId(songId),
      song_name: songName,
      artist: artist
    });
  } catch (e) {
    console.error('[MP4] 记录播放失败:', e);
  }
}

// ─── MP4 路由 ──────────────────────────────────────────────

router.get('/:token/:playlistId/:songId.mp4', async (req, res) => {
  const { token, playlistId, songId } = req.params;
  const source = getSourceFromReq(req);
  const adapter = getSourceAdapter(source);

  if (!isLikelyToken(token)) {
    return res.status(400).type('text/plain').send('Invalid token');
  }
  if (!isValidNumericId(playlistId)) {
    return res.status(400).type('text/plain').send('Invalid playlist id');
  }
  if (!isValidSongIdForSource(songId, source)) {
    return res.status(400).type('text/plain').send('Invalid song id');
  }

  const user = resolveUserFromAccessToken(token, playlistId, source);
  if (!user) {
    return res.status(401).type('text/plain').send('Token expired');
  }

  const mp4CacheKey = getMp4CacheKey(songId, source);
  const cachedMp4 = getMp4FilePath(mp4CacheKey);

  // 缓存命中：直接流式返回
  if (fs.existsSync(cachedMp4)) {
    const stat = fs.statSync(cachedMp4);
    logPlay(user.id, songId, playlistId, adapter);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Accept-Ranges', 'bytes');

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', chunkSize);

      const stream = fs.createReadStream(cachedMp4, { start, end });
      stream.pipe(res);
    } else {
      const stream = fs.createReadStream(cachedMp4);
      stream.pipe(res);
    }
    return;
  }

  // 缓存未命中：生成 MP4
  try {
    const cookie = decrypt(user.cookie);

    // 获取歌曲音频 URL
    const audioUrl = await adapter.getSongUrl(songId, cookie);
    if (!audioUrl) {
      return res.status(404).type('text/plain').send('Song not available');
    }

    // 从歌单缓存获取封面
    let coverUrl = DEFAULT_COVER_URL;
    const playlistCacheKey = getPlaylistCacheKey(playlistId, source);
    const cached = playlistOps.get.get(playlistCacheKey);
    if (cached) {
      try {
        const songs = JSON.parse(cached.songs || '[]');
        const idField = source === 'qq' ? 'mid' : 'id';
        const song = Array.isArray(songs) ? songs.find(s =>
          String(s[idField] || s.id) === String(songId)
        ) : null;
        if (song) {
          coverUrl = pickCoverUrlForSong(song, cached.cover);
        } else if (cached.cover) {
          coverUrl = optimizeNeteaseCoverUrl(String(cached.cover), 1080) || DEFAULT_COVER_URL;
        }
      } catch (_) {}
    }

    const info = await generateMp4(mp4CacheKey, audioUrl, coverUrl, 0);
    logPlay(user.id, songId, playlistId, adapter);

    const stat = fs.statSync(cachedMp4);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Accept-Ranges', 'bytes');

    const stream = fs.createReadStream(cachedMp4);
    stream.pipe(res);

  } catch (e) {
    console.error('[MP4] 生成失败:', e);
    res.status(500).type('text/plain').send('Failed to generate MP4');
  }
});

module.exports = router;
