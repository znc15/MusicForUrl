const { ensureEnvFile } = require('./lib/env-check');
ensureEnvFile();
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const crypto = require('crypto');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3000;

const trustProxy = process.env.TRUST_PROXY;
let proxyValue = 'loopback';

if (trustProxy !== undefined && trustProxy !== null && String(trustProxy).trim() !== '') {
  const normalized = String(trustProxy).trim();

  if (normalized === 'false' || normalized === '0') {
    console.warn(`[WARN] TRUST_PROXY=${normalized} 会触发 express-rate-limit 的 X-Forwarded-For 校验错误，已按安全默认值 trust proxy=loopback 处理；如需正确识别真实 IP，请设置 TRUST_PROXY=1/2/3... 或指定代理 IP/子网。`);
  } else if (normalized === 'true') {
    proxyValue = 1;
    console.warn('[WARN] TRUST_PROXY=true 不安全且会导致限流报错，已自动改用 TRUST_PROXY=1；请按实际代理层数设置 TRUST_PROXY=1/2/3... 或指定代理 IP/子网。');
  } else if (/^\d+$/.test(normalized)) {
    proxyValue = parseInt(normalized, 10);
  } else {
    proxyValue = normalized;
  }
}

app.set('trust proxy', proxyValue);

app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_GLOBAL) || 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: '请求过于频繁，请稍后再试' }
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_AUTH) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: '登录尝试过于频繁，请稍后再试' }
});

const parseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_PARSE) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: '解析请求过于频繁，请稍后再试' }
});

function getHlsTokenFromPath(req) {
  const p = String(req.path || '');
  const m = p.match(/^\/([^/]+)\//);
  return m ? m[1] : '';
}

function hlsKey(req) {
  const token = getHlsTokenFromPath(req);
  return `${ipKeyGenerator(req)}:${token}`;
}

const hlsStreamLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_HLS_STREAM) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !String(req.path || '').endsWith('stream.m3u8'),
  keyGenerator: hlsKey,
  handler: (req, res) => {
    res.status(429);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send('#EXTM3U\n#EXT-X-ERROR:Rate limit exceeded');
  }
});

const hlsSegmentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_HLS_SEGMENT) || 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !String(req.path || '').endsWith('.ts'),
  keyGenerator: hlsKey,
  handler: (req, res) => {
    res.status(429).type('text/plain').send('Rate limit exceeded');
  }
});

app.use('/api/', globalLimiter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

if (process.env.SITE_PASSWORD) {
  const SITE_COOKIE_NAME = 'site_auth';
  const SITE_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

  function parseCookies(cookieHeader) {
    const out = {};
    if (!cookieHeader) return out;
    const parts = String(cookieHeader).split(';');
    for (const part of parts) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (!k) continue;
      out[k] = decodeURIComponent(v);
    }
    return out;
  }

  function signSiteCookieValue(password) {
    return crypto.createHmac('sha256', password).update('site-auth-v1').digest('hex');
  }

  const expectedCookieValue = signSiteCookieValue(process.env.SITE_PASSWORD);

  function isPublicAssetPath(p) {
    if (p === '/password.html') return true;
    if (p === '/placeholder.svg' || p === '/favicon.ico') return true;
    if (p.startsWith('/css/') || p.startsWith('/js/') || p.startsWith('/includes/')) return true;
    return false;
  }

  app.use((req, res, next) => {
    if (req.path.startsWith('/api/playlist/') && req.path.endsWith('.m3u8')) {
      return next();
    }
    if (req.path.startsWith('/api/song/')) {
      return next();
    }
    if (req.path.startsWith('/api/hls/') && !req.path.startsWith('/api/hls/cache')) {
      return next();
    }

    if (req.path.startsWith('/api/qq/song/')) {
      return next();
    }
    if (req.path.startsWith('/api/qq/playlist/m3u8/') && req.path.endsWith('.m3u8')) {
      return next();
    }

    if (isPublicAssetPath(req.path)) {
      return next();
    }

    const cookies = parseCookies(req.headers.cookie);
    if (cookies[SITE_COOKIE_NAME] && cookies[SITE_COOKIE_NAME] === expectedCookieValue) {
      return next();
    }
    
    const provided = req.headers['x-site-password'] || req.query.sitePassword;
    if (provided !== process.env.SITE_PASSWORD) {
      if (req.accepts('html') && !req.path.startsWith('/api/')) {
        return res.sendFile(path.join(__dirname, 'public', 'password.html'));
      }
      return res.status(401).json({ success: false, message: '需要站点密码' });
    }

    res.cookie(SITE_COOKIE_NAME, expectedCookieValue, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: SITE_COOKIE_MAX_AGE_MS
    });

    next();
  });
}

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/captcha', authLimiter);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/playlist/parse', parseLimiter);
app.use('/api/playlist', require('./routes/playlist'));

app.use('/api/song', require('./routes/song'));
app.use('/api/img', require('./routes/img'));
app.use('/api/hls', hlsStreamLimiter, hlsSegmentLimiter, require('./routes/hls'));
app.use('/api/favorites', require('./routes/favorite'));
app.use('/api/history', require('./routes/history'));

app.use('/api/qq/auth/login', authLimiter);
app.use('/api/qq/auth', require('./routes/qq-auth'));
app.use('/api/qq/playlist/parse', parseLimiter);
app.use('/api/qq/playlist', require('./routes/qq-playlist'));
app.use('/api/qq/song', require('./routes/qq-song'));

app.use('/api', (req, res) => {
  res.status(404).json({ 
    success: false, 
    message: '接口不存在',
    path: req.path,
    method: req.method
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({ success: false, message: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`
服务器已经启动，端口号为${PORT}      
  `);
});

module.exports = app;
