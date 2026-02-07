const express = require('express');
const router = express.Router();
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const netease = require('../lib/netease');
const { decrypt } = require('../lib/crypto');
const { userOps, playlistOps, playLogOps } = require('../lib/db');
const { verifyPlaybackToken, isLegacyToken } = require('../lib/playback-token');

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

function isValidSegmentIndex(index) {
  const num = parseInt(index);
  return !isNaN(num) && num >= 0 && num < 10000;
}

function adminAuth(req, res, next) {
  const adminEnabled =
    process.env.HLS_ADMIN_ENABLED === '1' ||
    process.env.HLS_ADMIN_ENABLED === 'true';

  if (!adminEnabled) {
    return res.status(503).json({
      error: '管理接口已禁用',
      message: '需要显式设置 HLS_ADMIN_ENABLED=1 并配置 ADMIN_PASSWORD 才能启用管理接口'
    });
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return res.status(503).json({
      error: '管理接口已禁用',
      message: '请配置 ADMIN_PASSWORD 后再启用管理接口'
    });
  }

  const providedPassword = req.headers['x-admin-password'];
  if (providedPassword !== adminPassword) {
    return res.status(401).json({ error: '管理员密码错误或未提供' });
  }

  next();
}

const HLS_DIR = path.join(__dirname, '..', 'data', 'hls');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');

if (!fs.existsSync(HLS_DIR)) {
  fs.mkdirSync(HLS_DIR, { recursive: true });
}
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function envNumber(key) {
  const raw = process.env[key];
  if (raw == null || raw === '') return NaN;
  const num = Number(raw);
  return Number.isFinite(num) ? num : NaN;
}

const maxSizeBytesFromEnv = envNumber('HLS_CACHE_MAX_SIZE');
const maxSizeGBFromEnv = envNumber('HLS_CACHE_MAX_SIZE_GB');
const maxAgeHoursFromEnv = envNumber('HLS_CACHE_MAX_AGE_HOURS');
const cleanupIntervalMinutesFromEnv = envNumber('HLS_CACHE_CLEANUP_INTERVAL_MINUTES');
const cleanupTargetRatioFromEnv = envNumber('HLS_CACHE_CLEANUP_TARGET_RATIO');

function parseSegmentDuration() {
  const raw = process.env.HLS_SEGMENT_DURATION;
  if (raw == null || raw === '') return 10;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 10;
  if (n < 4) return 4;
  if (n > 60) return 60;
  return n;
}

const CACHE_CONFIG = {
  maxAge: (Number.isFinite(maxAgeHoursFromEnv) && maxAgeHoursFromEnv > 0)
    ? Math.floor(maxAgeHoursFromEnv * 60 * 60 * 1000)
    : 24 * 60 * 60 * 1000,
  maxSize: (Number.isFinite(maxSizeBytesFromEnv) && maxSizeBytesFromEnv > 0)
    ? Math.floor(maxSizeBytesFromEnv)
    : ((Number.isFinite(maxSizeGBFromEnv) && maxSizeGBFromEnv > 0)
      ? Math.floor(maxSizeGBFromEnv * 1024 * 1024 * 1024)
      : 5 * 1024 * 1024 * 1024),
  cleanupInterval: (Number.isFinite(cleanupIntervalMinutesFromEnv) && cleanupIntervalMinutesFromEnv > 0)
    ? Math.floor(cleanupIntervalMinutesFromEnv * 60 * 1000)
    : 60 * 60 * 1000,
  cleanupToRatio: (Number.isFinite(cleanupTargetRatioFromEnv) && cleanupTargetRatioFromEnv > 0 && cleanupTargetRatioFromEnv < 1)
    ? cleanupTargetRatioFromEnv
    : 0.8,
  autoPreloadCount: parseInt(process.env.HLS_AUTO_PRELOAD_COUNT, 10) || 1,
  segmentDuration: parseSegmentDuration(),
};

const LOG_VERBOSE = process.env.LOG_HLS_VERBOSE === '1' || process.env.LOG_HLS_VERBOSE === 'true';

const CACHE_VERSION = 2;

const DEFAULT_COVER_URL =
  process.env.DEFAULT_COVER_URL ||
  'https://p1.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg';

const COVER_OUTPUT = {
  width: parseInt(process.env.COVER_WIDTH) || 1920,
  height: parseInt(process.env.COVER_HEIGHT) || 1080
};

const COVER_FPS = (() => {
  const raw = process.env.COVER_FPS;
  if (raw == null || raw === '') return 5;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 30) return n;
  return 5;
})();

const HLS_FFMPEG_THREADS = (() => {
  const raw = process.env.HLS_FFMPEG_THREADS;
  if (raw == null || raw === '') return 0;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 64) return n;
  return 0;
})();

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

const JOB_LIMITS = {
  maxConcurrentJobs: parseInt(process.env.HLS_MAX_CONCURRENT_JOBS) || 2,
  maxQueueSize: parseInt(process.env.HLS_MAX_QUEUE) || 10,
  downloadTimeout: parseInt(process.env.HLS_DOWNLOAD_TIMEOUT) || 60000,
  downloadMaxSize: parseInt(process.env.HLS_DOWNLOAD_MAX_SIZE) || 100 * 1024 * 1024,
  downloadMaxRedirects: 5,
  ffmpegTimeout: parseInt(process.env.HLS_FFMPEG_TIMEOUT) || 180000,
};

const DEFAULT_DOWNLOAD_ALLOW_PATTERNS = [
  /^m\d+[a-z]*\.music\.126\.net$/i,
  /^p\d+\.music\.126\.net$/i,
  /^music\.126\.net$/i,
  // QQ 音乐域名
  /^[a-z0-9]+\.y\.qq\.com$/i,
  /^y\.gtimg\.cn$/i,
  /^[a-z0-9]+\.stream\.qqmusic\.qq\.com$/i,
  /^dl\.stream\.qqmusic\.qq\.com$/i,
  /^isure\.stream\.qqmusic\.qq\.com$/i,
  /^ws\.stream\.qqmusic\.qq\.com$/i,
];

function parseExtraAllowPatterns() {
  const extra = process.env.HLS_DOWNLOAD_ALLOW_HOSTS;
  if (!extra) return [];
  return extra.split(',').map(s => s.trim()).filter(Boolean).map(pattern => {
    try {
      return new RegExp(pattern, 'i');
    } catch (e) {
      console.warn(`[HLS] 无效的 HLS_DOWNLOAD_ALLOW_HOSTS 模式: ${pattern}`);
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
  
  get waiting() {
    return this.queue.length;
  }
  
  get running() {
    return this.current;
  }
}

const jobSemaphore = new Semaphore(JOB_LIMITS.maxConcurrentJobs);

const generatingLocks = new Map();

const preloadingPlaylists = new Set();

const songSegmentInfo = new Map();
const SEGMENT_INFO_MAX = 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, promise] of generatingLocks.entries()) {
    if (promise._createdAt && now - promise._createdAt > 60 * 60 * 1000) {
      generatingLocks.delete(key);
    }
  }
  
  if (preloadingPlaylists.size > 100) {
    preloadingPlaylists.clear();
  }
  
  if (songSegmentInfo.size > SEGMENT_INFO_MAX) {
    const toDelete = Math.ceil(songSegmentInfo.size * 0.2);
    let deleted = 0;
    for (const key of songSegmentInfo.keys()) {
      if (deleted >= toDelete) break;
      songSegmentInfo.delete(key);
      deleted++;
    }
    console.log(`[HLS] songSegmentInfo 超限，已清理 ${deleted} 条`);
  }
}, 10 * 60 * 1000);

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
console.log('FFmpeg路径:', FFMPEG_PATH);

const TEMP_DIR = path.join(__dirname, '..', 'data', 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function getSongCacheDir(songId) {
  return path.join(CACHE_DIR, String(songId));
}

function getSegmentPath(songId, segmentIndex) {
  return path.join(getSongCacheDir(songId), `seg_${String(segmentIndex).padStart(4, '0')}.ts`);
}

function getSegmentInfoPath(songId) {
  return path.join(getSongCacheDir(songId), 'info.json');
}

function isSongCached(songId) { 
  try { 
    const infoPath = getSegmentInfoPath(songId); 
    if (!fs.existsSync(infoPath)) return false; 
     
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8')); 
    if (info.version !== CACHE_VERSION) return false; 
    if (!info.video || info.video.width !== COVER_OUTPUT.width || info.video.height !== COVER_OUTPUT.height) return false; 
    const age = Date.now() - info.timestamp; 
    if (age > CACHE_CONFIG.maxAge) return false; 

    const count = parseInt(info.segmentCount, 10) || 0;
    return count > 0;
  } catch (e) { 
    return false; 
  } 
} 

function getSongSegmentInfo(songId) {
  const key = String(songId);
  const cached = songSegmentInfo.get(key);
  if (cached) return cached;

  try {
    const infoPath = getSegmentInfoPath(key);
    if (!fs.existsSync(infoPath)) return null;
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    songSegmentInfo.set(key, info);
    return info;
  } catch (e) {
    return null;
  }
}

async function statIfValidSegment(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return null;
    if (stat.size <= 1024) return null;
    return stat;
  } catch (e) {
    return null;
  }
}

function formatHttpDate(ms) {
  try {
    return new Date(ms).toUTCString();
  } catch (_) {
    return new Date().toUTCString();
  }
}

function makeWeakEtag(stat) {
  const size = stat?.size || 0;
  const mtimeMs = Math.floor(stat?.mtimeMs || Date.now());
  return `W/\"${size}-${mtimeMs}\"`;
}

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

async function safeReadJson(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function getSongDirSizeBytes(songDir) {
  try {
    const files = await fs.promises.readdir(songDir, { withFileTypes: true });
    let totalSize = 0;
    for (const entry of files) {
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.promises.stat(path.join(songDir, entry.name));
        totalSize += stat.size;
      } catch (_) {}
    }
    return totalSize;
  } catch (e) {
    return 0;
  }
}
 
let cacheCleanupRunning = false; 
let cacheCleanupScheduled = false; 
 
async function cleanupCache(reason = 'interval') { 
  if (cacheCleanupRunning) return; 
  cacheCleanupRunning = true; 
  try { 
    const dirents = await fs.promises.readdir(CACHE_DIR, { withFileTypes: true }); 
    const songInfos = []; 

    for (let i = 0; i < dirents.length; i++) { 
      const entry = dirents[i]; 
      if (!entry.isDirectory()) continue; 
      const songId = String(entry.name); 
      if (generatingLocks.has(songId)) continue; 

      const songDir = path.join(CACHE_DIR, songId); 
      const infoPath = path.join(songDir, 'info.json'); 

      let timestamp = 0; 
      let sizeBytes = 0; 

      const info = await safeReadJson(infoPath); 
      if (info) { 
        timestamp = Number(info.timestamp) || 0; 
        sizeBytes = Number(info.cacheBytes) || 0; 
      } 

      if (!timestamp) { 
        try { 
          const stat = await fs.promises.stat(songDir); 
          timestamp = stat.mtimeMs || 0; 
        } catch (_) { 
          continue; 
        } 
      } 

      songInfos.push({ songId, path: songDir, timestamp, sizeBytes }); 

      if (i > 0 && i % 25 === 0) { 
        await yieldToEventLoop(); 
      } 
    } 

    const now = Date.now(); 
    let deleted = 0; 
    let freedSize = 0; 

    async function deleteSongDir(info) { 
      try { 
        if (!info.sizeBytes) {
          info.sizeBytes = await getSongDirSizeBytes(info.path);
        }
        await fs.promises.rm(info.path, { recursive: true, force: true }); 
        songSegmentInfo.delete(info.songId); 
        deleted++; 
        const freed = Number(info.sizeBytes) || 0; 
        freedSize += freed; 
        return freed; 
      } catch (e) { 
        console.error(`删除过期缓存失败 ${info.songId}:`, e?.message || e); 
        return 0; 
      } 
    } 

    const remaining = []; 
    for (let i = 0; i < songInfos.length; i++) { 
      const info = songInfos[i]; 
      if (now - info.timestamp > CACHE_CONFIG.maxAge) { 
        await deleteSongDir(info); 
      } else { 
        remaining.push(info); 
      } 
      if (i > 0 && i % 20 === 0) await yieldToEventLoop(); 
    } 

    // 计算总大小：优先使用 info.json 里的 cacheBytes，否则才扫描目录
    let totalSize = 0; 
    for (let i = 0; i < remaining.length; i++) { 
      const info = remaining[i]; 
      if (!info.sizeBytes) { 
        info.sizeBytes = await getSongDirSizeBytes(info.path); 
      } 
      totalSize += info.sizeBytes; 
      if (i > 0 && i % 10 === 0) await yieldToEventLoop(); 
    } 

    if (totalSize > CACHE_CONFIG.maxSize) { 
      const targetSize = CACHE_CONFIG.maxSize * CACHE_CONFIG.cleanupToRatio; 
      remaining.sort((a, b) => a.timestamp - b.timestamp); 

      for (let i = 0; i < remaining.length; i++) { 
        if (totalSize <= targetSize) break; 
        const info = remaining[i]; 
        if (generatingLocks.has(info.songId)) continue; 
        const freed = await deleteSongDir(info); 
        totalSize -= freed || 0; 
        if (i > 0 && i % 10 === 0) await yieldToEventLoop(); 
      } 
    } 

    if (deleted > 0) { 
      console.log(`缓存清理完成(${reason})，删除了 ${deleted} 首歌曲缓存，释放 ${(freedSize / 1024 / 1024).toFixed(2)} MB`); 
    } 
  } catch (e) { 
    console.error('缓存清理失败:', e?.message || e); 
  } finally { 
    cacheCleanupRunning = false; 
  } 
} 

function scheduleCacheCleanup(reason = 'scheduled') { 
  if (cacheCleanupScheduled) return; 
  cacheCleanupScheduled = true; 
  setTimeout(() => { 
    cacheCleanupScheduled = false; 
    cleanupCache(reason).catch((e) => {
      console.error('缓存清理失败:', e?.message || e);
    }); 
  }, 1000); 
} 
 
setInterval(() => {
  cleanupCache('interval').catch(() => {});
}, CACHE_CONFIG.cleanupInterval); 
setTimeout(() => scheduleCacheCleanup('startup'), 5000); 

async function generateSongSegments(songId, audioUrl, coverUrl, songDuration) {
  const acquired = await jobSemaphore.acquire();
  if (!acquired) {
    throw new Error('服务繁忙，请稍后重试');
  }
  
  const timestamp = Date.now();
  const tempAudio = path.join(TEMP_DIR, `${songId}_${timestamp}.mp3`);
  const tempCover = path.join(TEMP_DIR, `${songId}_${timestamp}.jpg`);
  const songCacheDir = getSongCacheDir(songId);
  const tempM3u8 = path.join(TEMP_DIR, `${songId}_${timestamp}.m3u8`);
  const tempSegmentPattern = path.join(TEMP_DIR, `${songId}_${timestamp}_seg_%04d.ts`);
  
  const cleanup = () => {
    fs.unlink(tempAudio, () => {});
    fs.unlink(tempCover, () => {});
    fs.unlink(tempM3u8, () => {});
    try {
      const tempFiles = fs.readdirSync(TEMP_DIR);
      for (const f of tempFiles) {
        if (f.startsWith(`${songId}_${timestamp}_seg_`)) {
          fs.unlinkSync(path.join(TEMP_DIR, f));
        }
      }
    } catch (e) {}
  };
  
  const releaseAndCleanup = () => {
    cleanup();
    jobSemaphore.release();
  };
  
  try {
    if (!fs.existsSync(songCacheDir)) {
      fs.mkdirSync(songCacheDir, { recursive: true });
    }
    
    if (LOG_VERBOSE) console.log(`[分片缓存] 正在下载: ${songId} (并发: ${jobSemaphore.running}/${JOB_LIMITS.maxConcurrentJobs}, 等待: ${jobSemaphore.waiting})`);
    await Promise.all([
      downloadFile(audioUrl, tempAudio),
      downloadFile(coverUrl, tempCover)
    ]);
    
    if (LOG_VERBOSE) console.log(`[分片缓存] 正在转码并分片: ${songId}`);
    
    const info = await runFFmpegTranscode({
      songId,
      timestamp,
      tempAudio,
      tempCover,
      tempM3u8,
      tempSegmentPattern,
      songCacheDir
    });
    
    scheduleCacheCleanup('after-generate');
    
    releaseAndCleanup();
    return info;
    
  } catch (e) {
    releaseAndCleanup();
    throw e;
  }
}

function runFFmpegTranscode({ songId, timestamp, tempAudio, tempCover, tempM3u8, tempSegmentPattern, songCacheDir }) {
  return new Promise((resolve, reject) => {
    const segmentDuration = CACHE_CONFIG.segmentDuration;
    const gop = Math.max(1, Math.round(COVER_FPS * segmentDuration));
    let stallTimer = null;
    let ffmpegKilled = false;
    let ffmpegError = '';
    let lastActivityAt = Date.now();

    function markActivity() {
      lastActivityAt = Date.now();
    }
    
    const vf = [
      `scale=${COVER_OUTPUT.width}:${COVER_OUTPUT.height}:force_original_aspect_ratio=decrease`,
      `pad=${COVER_OUTPUT.width}:${COVER_OUTPUT.height}:(ow-iw)/2:(oh-ih)/2`,
      'setsar=1'
    ].join(',');

    const ffmpegArgs = [
      '-loop', '1',
      '-framerate', String(COVER_FPS),
      '-i', tempCover,
      '-i', tempAudio,
    ];

    if (HLS_FFMPEG_THREADS > 0) {
      ffmpegArgs.push('-threads', String(HLS_FFMPEG_THREADS));
    }

    ffmpegArgs.push(
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'stillimage',
      '-crf', '28',
      '-r', String(COVER_FPS),
      '-g', String(gop),
      '-keyint_min', String(gop),
      '-sc_threshold', '0',
      '-force_key_frames', `expr:gte(t,n_forced*${segmentDuration})`,
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-pix_fmt', 'yuv420p',
      '-vf', vf,
      '-shortest',
      '-f', 'hls',
      '-hls_time', String(segmentDuration),
      '-hls_list_size', '0',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', tempSegmentPattern,
      '-y',
      tempM3u8
    );

    const ffmpegProcess = spawn(FFMPEG_PATH, ffmpegArgs);
    
    ffmpegProcess.stderr.on('data', (data) => {
      ffmpegError += data.toString();
      markActivity();
    });
    
    // 用“无输出/无进展超时”替代固定总时长超时：弱机器或长歌转码可能超过固定阈值，但只要持续输出进度就不应被杀。
    // JOB_LIMITS.ffmpegTimeout 继续由 HLS_FFMPEG_TIMEOUT 控制（默认 180000ms）。
    stallTimer = setInterval(() => {
      if (ffmpegKilled) return;
      if (Date.now() - lastActivityAt <= JOB_LIMITS.ffmpegTimeout) return;
      ffmpegKilled = true;
      try { ffmpegProcess.kill('SIGKILL'); } catch (_) {}
      console.error(`[分片缓存] FFmpeg无输出超时被终止: ${songId}`);
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
      
      try {
        const m3u8Content = fs.readFileSync(tempM3u8, 'utf8');
        const segmentDurations = [];
        const lines = m3u8Content.split('\n');
        
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('#EXTINF:')) {
            const duration = parseFloat(lines[i].replace('#EXTINF:', '').split(',')[0]);
            segmentDurations.push(duration);
          }
        }
        
        const tempFiles = fs.readdirSync(TEMP_DIR); 
        const segmentFiles = tempFiles 
          .filter(f => f.startsWith(`${songId}_${timestamp}_seg_`) && f.endsWith('.ts')) 
          .sort(); 

        let cacheBytes = 0;
        for (let i = 0; i < segmentFiles.length; i++) { 
          const srcPath = path.join(TEMP_DIR, segmentFiles[i]); 
          const destPath = getSegmentPath(songId, i); 
          try { 
            const stat = fs.statSync(srcPath); 
            cacheBytes += stat.size || 0; 
          } catch (_) {} 
          fs.renameSync(srcPath, destPath); 
        } 
         
        const info = { 
          version: CACHE_VERSION, 
          songId: songId, 
          segmentCount: segmentFiles.length, 
          segmentDurations: segmentDurations, 
          totalDuration: segmentDurations.reduce((a, b) => a + b, 0), 
          cacheBytes,
          video: { width: COVER_OUTPUT.width, height: COVER_OUTPUT.height }, 
          timestamp: Date.now() 
        }; 
        fs.writeFileSync(getSegmentInfoPath(songId), JSON.stringify(info));
        
        songSegmentInfo.set(String(songId), info);
        
        if (LOG_VERBOSE) console.log(`[分片缓存] 完成: ${songId}, ${segmentFiles.length}个分片`);
        resolve(info);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function autoPreloadInBackground(songs, cookie, coverUrl, playlistId) {
  const preloadKey = `${playlistId}_${songs[0]?.id}`;
  if (preloadingPlaylists.has(preloadKey)) {
    return;
  }
  preloadingPlaylists.add(preloadKey);
  
  const toPreload = songs.slice(0, CACHE_CONFIG.autoPreloadCount);
  console.log(`[自动预加载] 开始预加载 ${toPreload.length} 首歌`);
  
  for (const song of toPreload) {
    if (isSongCached(song.id)) {
      continue;
    }
    
    if (generatingLocks.has(String(song.id))) {
      continue;
    }
    
    try {
      const audioUrl = await netease.getSongUrl(song.id, cookie);
      if (!audioUrl) {
        console.log(`[自动预加载] 跳过 ${song.id}：无法获取URL`);
        continue;
      }
      
      const perSongCover = pickCoverUrlForSong(song, coverUrl);
      const generatePromise = generateSongSegments(song.id, audioUrl, perSongCover, song.duration);
      generatePromise._createdAt = Date.now();
      generatingLocks.set(String(song.id), generatePromise);
      
      await generatePromise;
      generatingLocks.delete(String(song.id));
      
      console.log(`[自动预加载] 完成: ${song.name}`);
    } catch (e) {
      generatingLocks.delete(String(song.id));
      console.error(`[自动预加载] 失败 ${song.id}:`, e.message);
    }
  }
  
  preloadingPlaylists.delete(preloadKey);
  console.log(`[自动预加载] 全部完成`);
}

async function preloadNextSongs(playlistId, currentSongId, cookie) {
  try {
    const cached = playlistOps.get.get(playlistId);
    if (!cached) return;
    
    let songs;
    try {
      songs = JSON.parse(cached.songs);
    } catch (parseErr) {
      console.error(`[边播边缓存] 歌单缓存损坏 ${playlistId}:`, parseErr.message);
      try { playlistOps.clearExpired.run(); } catch (_) {}
      return;
    }
    if (!Array.isArray(songs)) return;
    
    const coverUrl = cached.cover || DEFAULT_COVER_URL;
    
    const currentIndex = songs.findIndex(s => String(s.id) === String(currentSongId));
    if (currentIndex === -1) return;
    
    const nextSongs = songs.slice(currentIndex + 1, currentIndex + 3);
    if (nextSongs.length === 0) return;
    
    const preloadKey = `next_${currentSongId}`;
    if (preloadingPlaylists.has(preloadKey)) return;
    preloadingPlaylists.add(preloadKey);
    
    if (LOG_VERBOSE) console.log(`[边播边缓存] 预加载接下来 ${nextSongs.length} 首`);
    
    for (const song of nextSongs) {
      if (isSongCached(song.id) || generatingLocks.has(String(song.id))) {
        continue;
      }
      
      try {
        const audioUrl = await netease.getSongUrl(song.id, cookie);
        if (!audioUrl) continue;
        
        const perSongCover = pickCoverUrlForSong(song, coverUrl);
        const generatePromise = generateSongSegments(song.id, audioUrl, perSongCover, song.duration);
        generatePromise._createdAt = Date.now();
        generatingLocks.set(String(song.id), generatePromise);
        
        await generatePromise;
        generatingLocks.delete(String(song.id));
        
        if (LOG_VERBOSE) console.log(`[边播边缓存] 完成: ${song.name}`);
      } catch (e) {
        generatingLocks.delete(String(song.id));
      }
    }
    
    preloadingPlaylists.delete(preloadKey);
  } catch (e) {
    console.error('[边播边缓存] 错误:', e.message);
  }
}

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

function getBaseUrl(req) {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, '');
  }
  
  return `${req.protocol}://${req.get('host')}`;
}

router.get('/:token/:playlistId/stream.m3u8', async (req, res) => {
  const { token, playlistId } = req.params;
  const startIndex = parseInt(req.query.start) || 0;
  
  if (!isLikelyToken(token)) {
    return res.status(400).send('#EXTM3U\n#EXT-X-ERROR:Invalid token format');
  }
  if (!isValidNumericId(playlistId)) {
    return res.status(400).send('#EXTM3U\n#EXT-X-ERROR:Invalid playlist ID');
  }
  
  const user = resolveUserFromAccessToken(token, playlistId);
  if (!user) {
    return res.status(401).send('#EXTM3U\n#EXT-X-ERROR:Invalid token');
  }
  
  const cookie = decrypt(user.cookie);
  
  let songs, playlistCover;
  const cached = playlistOps.get.get(playlistId);
  
  if (cached) {
    let cacheParseOk = true;
    try {
      songs = JSON.parse(cached.songs);
      if (!Array.isArray(songs)) {
        throw new Error('songs is not an array');
      }
    } catch (parseErr) {
      console.error(`[HLS] 歌单缓存损坏 ${playlistId}:`, parseErr.message);
      cacheParseOk = false;
    }
    
    if (!cacheParseOk) {
      try {
        const playlist = await netease.getPlaylistDetail(playlistId, cookie);
        songs = playlist.tracks;
        playlistCover = playlist.cover;
      } catch (refreshErr) {
        return res.status(500).send('#EXTM3U\n#EXT-X-ERROR:Cache corrupted and refresh failed');
      }
    } else {
      playlistCover = cached.cover;
    }
    const hasCover = Array.isArray(songs) && songs.some(s => s && s.cover);
    if (!hasCover) {
      try {
        const playlist = await netease.getPlaylistDetail(playlistId, cookie);
        songs = playlist.tracks;
        playlistCover = playlist.cover;
      } catch (_) {
      }
    }
  } else {
    try {
      const playlist = await netease.getPlaylistDetail(playlistId, cookie);
      songs = playlist.tracks;
      playlistCover = playlist.cover;
    } catch (e) {
      return res.status(500).send('#EXTM3U\n#EXT-X-ERROR:Failed to get playlist');
    }
  }
  
  songs = songs.slice(startIndex);
  
  if (songs.length === 0) {
    return res.status(404).send('#EXTM3U\n#EXT-X-ERROR:Empty playlist');
  }
  
  const baseUrl = getBaseUrl(req);
  const segmentDuration = CACHE_CONFIG.segmentDuration;
  
  let m3u8 = '#EXTM3U\n';
  m3u8 += '#EXT-X-VERSION:3\n';
  m3u8 += `#EXT-X-TARGETDURATION:${segmentDuration + 1}\n`;
  m3u8 += '#EXT-X-PLAYLIST-TYPE:VOD\n';
  m3u8 += '#EXT-X-MEDIA-SEQUENCE:0\n';
  m3u8 += '#EXT-X-ALLOW-CACHE:YES\n';
  
  for (let songIndex = 0; songIndex < songs.length; songIndex++) {
    const song = songs[songIndex];
    const songId = song.id;
    const songDuration = song.duration || 240;
    
    let segmentInfo = getSongSegmentInfo(songId);
    
    if (segmentInfo && segmentInfo.segmentDurations) {
      if (songIndex > 0) {
        m3u8 += '#EXT-X-DISCONTINUITY\n';
      }
      m3u8 += `#EXT-X-PROGRAM-DATE-TIME:${new Date().toISOString()}\n`;
      
      for (let segIndex = 0; segIndex < segmentInfo.segmentCount; segIndex++) {
        const segDuration = segmentInfo.segmentDurations[segIndex] || segmentDuration;
        m3u8 += `#EXTINF:${segDuration.toFixed(6)},\n`;
        m3u8 += `${baseUrl}/api/hls/${encodeURIComponent(token)}/${playlistId}/seg/${songId}/${segIndex}.ts\n`;
      }
    } else {
      if (songIndex > 0) {
        m3u8 += '#EXT-X-DISCONTINUITY\n';
      }
      
      const estimatedSegments = Math.ceil(songDuration / segmentDuration);
      for (let segIndex = 0; segIndex < estimatedSegments; segIndex++) {
        const isLastSeg = segIndex === estimatedSegments - 1;
        const segDur = isLastSeg 
          ? (songDuration % segmentDuration) || segmentDuration 
          : segmentDuration;
        m3u8 += `#EXTINF:${segDur.toFixed(6)},\n`;
        m3u8 += `${baseUrl}/api/hls/${encodeURIComponent(token)}/${playlistId}/seg/${songId}/${segIndex}.ts\n`;
      }
    }
  }
  
  m3u8 += '#EXT-X-ENDLIST\n';
  
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(m3u8);
  
  const coverUrl = playlistCover || DEFAULT_COVER_URL;
  setImmediate(() => {
    autoPreloadInBackground(songs, cookie, coverUrl, playlistId).catch(e => {
      console.error('[自动预加载] 错误:', e.message);
    });
  });
});

router.get('/:token/:playlistId/seg/:songId/:segmentIndex.ts', async (req, res) => {
  const { token, playlistId, songId, segmentIndex } = req.params;
  const segIndex = parseInt(segmentIndex);
  
  if (!isLikelyToken(token)) {
    return res.status(400).json({ error: 'Invalid token format' });
  }
  if (!isValidNumericId(playlistId)) {
    return res.status(400).json({ error: 'Invalid playlist ID' });
  }
  if (!isValidNumericId(songId)) {
    return res.status(400).json({ error: 'Invalid song ID' });
  }
  if (!isValidSegmentIndex(segmentIndex)) {
    return res.status(400).json({ error: 'Invalid segment index' });
  }
  
  const user = resolveUserFromAccessToken(token, playlistId);
  if (!user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  const cookie = decrypt(user.cookie);

  if (segIndex === 0) {
    try {
      let songName = '未知';
      let artist = '未知';

      const cached = playlistOps.get.get(playlistId);
      if (cached && cached.songs) {
        try {
          const songs = JSON.parse(cached.songs);
          const song = Array.isArray(songs) ? songs.find(s => String(s?.id) === String(songId)) : null;
          if (song) {
            if (song.name) songName = String(song.name);
            if (song.artist) artist = String(song.artist);
          }
        } catch (_) {}
      }

      playLogOps.log.run({
        user_id: user.id,
        playlist_id: String(playlistId),
        song_id: String(songId),
        song_name: songName,
        artist
      });
    } catch (e) {
      console.error('记录播放失败:', e?.message || e);
    }
  }
  
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  
  const segmentPath = getSegmentPath(songId, segIndex); 

  const hitStat = await statIfValidSegment(segmentPath);
  if (hitStat) { 
    if (LOG_VERBOSE) console.log(`[分片命中] ${songId}/${segIndex}`); 

    const etag = makeWeakEtag(hitStat);
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', formatHttpDate(hitStat.mtimeMs));

    const inm = req.headers['if-none-match'];
    if (inm && String(inm).trim() === etag) {
      return res.status(304).end();
    }

    res.setHeader('Content-Length', hitStat.size); 
    const stream = fs.createReadStream(segmentPath); 
    stream.pipe(res); 
     
    if (segIndex === 0) { 
      setImmediate(() => preloadNextSongs(playlistId, songId, cookie)); 
    } 
    return; 
  } 
  
  const lockKey = String(songId);
  if (generatingLocks.has(lockKey)) {
    console.log(`[等待分片生成] ${songId}`);
    try { 
      await generatingLocks.get(lockKey); 
      const generatedStat = await statIfValidSegment(segmentPath);
      if (generatedStat) { 
        const etag = makeWeakEtag(generatedStat);
        res.setHeader('ETag', etag);
        res.setHeader('Last-Modified', formatHttpDate(generatedStat.mtimeMs));
        res.setHeader('Content-Length', generatedStat.size); 
        const stream = fs.createReadStream(segmentPath); 
        stream.pipe(res); 
 
        if (segIndex === 0) { 
          setImmediate(() => preloadNextSongs(playlistId, songId, cookie));
        }
        return;
      }
    } catch (e) {
    }
  }
  
  try {
    const audioUrl = await netease.getSongUrl(songId, cookie);
    if (!audioUrl) {
      return res.status(404).json({ error: 'Cannot get song URL' });
    }
    
    let coverUrl = DEFAULT_COVER_URL;
    const cached = playlistOps.get.get(playlistId);
    if (cached) {
      if (cached.cover) coverUrl = cached.cover;
      try {
        const songs = JSON.parse(cached.songs || '[]');
        const song = Array.isArray(songs) ? songs.find(s => String(s?.id) === String(songId)) : null;
        if (song && song.cover) coverUrl = song.cover;
      } catch (_) {}
    }
    
    if (LOG_VERBOSE) console.log(`[分片未命中] 生成歌曲所有分片: ${songId}`);
    
    const perSongCover = pickCoverUrlForSong({ id: songId, cover: coverUrl }, coverUrl);
    const generatePromise = generateSongSegments(songId, audioUrl, perSongCover);
    generatePromise._createdAt = Date.now();
    generatingLocks.set(lockKey, generatePromise);
    
    try {
      await generatePromise; 
      generatingLocks.delete(lockKey); 
       
      const generatedStat = await statIfValidSegment(segmentPath);
      if (generatedStat) { 
        const etag = makeWeakEtag(generatedStat);
        res.setHeader('ETag', etag);
        res.setHeader('Last-Modified', formatHttpDate(generatedStat.mtimeMs));
        res.setHeader('Content-Length', generatedStat.size); 
        const stream = fs.createReadStream(segmentPath); 
        stream.pipe(res); 
         
        if (segIndex === 0) { 
          setImmediate(() => preloadNextSongs(playlistId, songId, cookie));
        }
      } else {
        throw new Error(`Segment ${segIndex} not found after generation`);
      }
    } catch (e) {
      generatingLocks.delete(lockKey);
      throw e;
    }
    
  } catch (e) {
    console.error('Segment error:', e);
    if (!res.headersSent) {
      if (e.message === '服务繁忙，请稍后重试') {
        res.status(503).json({ 
          error: e.message, 
          retryAfter: 10,
          queueInfo: {
            running: jobSemaphore.running,
            waiting: jobSemaphore.waiting,
            maxConcurrent: JOB_LIMITS.maxConcurrentJobs
          }
        });
      } else {
        res.status(500).json({ error: e.message });
      }
    }
  }
});

router.get('/:token/:playlistId/song/:songId.ts', (req, res) => {
  const { token, playlistId, songId } = req.params;
  
  if (!isLikelyToken(token) || !isValidNumericId(playlistId) || !isValidNumericId(songId)) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }
  
  res.redirect(`/api/hls/${encodeURIComponent(token)}/${playlistId}/seg/${songId}/0.ts`);
});

router.post('/:token/:playlistId/preload', async (req, res) => {
  const { token, playlistId } = req.params;
  const count = Math.min(parseInt(req.body.count) || 5, 20);
  
  if (!isLikelyToken(token)) {
    return res.status(400).json({ error: 'Invalid token format' });
  }
  if (!isValidNumericId(playlistId)) {
    return res.status(400).json({ error: 'Invalid playlist ID' });
  }
  
  const user = resolveUserFromAccessToken(token, playlistId);
  if (!user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  const cookie = decrypt(user.cookie);
  
  try {
    let songs;
    const cached = playlistOps.get.get(playlistId);
    
    if (cached) {
      let cacheParseOk = true;
      try {
        songs = JSON.parse(cached.songs);
        if (!Array.isArray(songs)) {
          throw new Error('songs is not an array');
        }
      } catch (parseErr) {
        console.error(`[预加载] 歌单缓存损坏 ${playlistId}:`, parseErr.message);
        cacheParseOk = false;
      }
      
      if (!cacheParseOk) {
        const playlist = await netease.getPlaylistDetail(playlistId, cookie);
        songs = playlist.tracks;
      } else {
        const hasCover = Array.isArray(songs) && songs.some(s => s && s.cover);
        if (!hasCover) {
          try {
            const playlist = await netease.getPlaylistDetail(playlistId, cookie);
            songs = playlist.tracks;
          } catch (_) {}
        }
      }
    } else {
      const playlist = await netease.getPlaylistDetail(playlistId, cookie);
      songs = playlist.tracks;
    }
    
    const toPreload = songs.slice(0, count);
    const results = [];
    
    let coverUrl = (cached && cached.cover) ? cached.cover : DEFAULT_COVER_URL;
    
    if (LOG_VERBOSE) console.log(`[预加载] 开始预加载 ${toPreload.length} 首歌`);
    
    for (const song of toPreload) {
      if (isSongCached(song.id)) {
        const info = getSongSegmentInfo(song.id);
        results.push({ id: song.id, name: song.name, status: 'cached', segments: info?.segmentCount || 0 });
        continue;
      }
      
      try {
        const audioUrl = await netease.getSongUrl(song.id, cookie);
        if (!audioUrl) {
          results.push({ id: song.id, name: song.name, status: 'no_url' });
          continue;
        }
        
        const perSongCover = pickCoverUrlForSong(song, coverUrl);
        const info = await generateSongSegments(song.id, audioUrl, perSongCover, song.duration);
        results.push({ id: song.id, name: song.name, status: 'generated', segments: info.segmentCount });
      } catch (e) {
        results.push({ id: song.id, name: song.name, status: 'error', error: e.message });
      }
    }
    
    if (LOG_VERBOSE) console.log(`[预加载] 完成`);
    res.json({ success: true, results });
    
  } catch (e) {
    console.error('预加载错误:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/cache/status', adminAuth, async (req, res) => { 
  try { 
    const dirents = await fs.promises.readdir(CACHE_DIR, { withFileTypes: true }); 
    let totalSize = 0; 
    let totalSongs = 0; 
    const cachedSongs = []; 
     
    for (let i = 0; i < dirents.length; i++) { 
      const entry = dirents[i]; 
      if (!entry.isDirectory()) continue; 
      totalSongs++; 

      const songId = String(entry.name); 
      const songDir = path.join(CACHE_DIR, songId); 
      const infoPath = path.join(songDir, 'info.json'); 

      let segmentCount = 0; 
      let songSize = 0; 
      let timestamp = 0; 

      const info = await safeReadJson(infoPath); 
      if (info) { 
        segmentCount = info.segmentCount || 0; 
        songSize = Number(info.cacheBytes) || 0; 
        timestamp = Number(info.timestamp) || 0; 
      } 

      if (!timestamp) { 
        try { 
          const stat = await fs.promises.stat(songDir); 
          timestamp = stat.mtimeMs || 0; 
        } catch (_) {} 
      } 

      if (!songSize) { 
        songSize = await getSongDirSizeBytes(songDir); 
      } 

      totalSize += songSize; 

      if (cachedSongs.length < 50) { 
        const ageMin = timestamp ? Math.round((Date.now() - timestamp) / 1000 / 60) : 0; 
        cachedSongs.push({ 
          songId, 
          segments: segmentCount, 
          size: (songSize / 1024 / 1024).toFixed(2) + ' MB', 
          age: ageMin + ' minutes' 
        }); 
      } 

      if (i > 0 && i % 25 === 0) await yieldToEventLoop(); 
    } 
     
    res.json({ 
      cache: { 
        totalSongs, 
        totalSize: (totalSize / 1024 / 1024).toFixed(2) + ' MB', 
        maxSize: (CACHE_CONFIG.maxSize / 1024 / 1024 / 1024).toFixed(2) + ' GB', 
      }, 
      jobs: { 
        running: jobSemaphore.running, 
        waiting: jobSemaphore.waiting, 
        maxConcurrent: JOB_LIMITS.maxConcurrentJobs, 
        maxQueue: JOB_LIMITS.maxQueueSize 
      }, 
      config: { 
        downloadTimeout: JOB_LIMITS.downloadTimeout + 'ms', 
        downloadMaxSize: (JOB_LIMITS.downloadMaxSize / 1024 / 1024).toFixed(2) + ' MB', 
        ffmpegTimeout: JOB_LIMITS.ffmpegTimeout + 'ms' 
      }, 
      songs: cachedSongs 
    }); 
  } catch (e) { 
    res.status(500).json({ error: e?.message || String(e) }); 
  } 
}); 

router.delete('/cache', adminAuth, async (req, res) => { 
  try { 
    const dirents = await fs.promises.readdir(CACHE_DIR, { withFileTypes: true }); 
    let deleted = 0; 
     
    for (let i = 0; i < dirents.length; i++) { 
      const entry = dirents[i]; 
      if (!entry.isDirectory()) continue; 

      const songId = String(entry.name); 
      const songDir = path.join(CACHE_DIR, songId); 
      try { 
        await fs.promises.rm(songDir, { recursive: true, force: true }); 
        deleted++; 
      } catch (_) {} 

      if (i > 0 && i % 10 === 0) await yieldToEventLoop(); 
    } 
     
    songSegmentInfo.clear(); 
     
    res.json({ success: true, deletedSongs: deleted }); 
  } catch (e) { 
    res.status(500).json({ error: e?.message || String(e) }); 
  } 
}); 

module.exports = router;
