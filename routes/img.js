const express = require('express');
const router = express.Router();
const http = require('http');
const https = require('https');

const MAX_BYTES = 6 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;

function isAllowedHost(hostname) {
  return /^p\d+\.music\.126\.net$/i.test(hostname);
}

function proxyImage(url, res, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) return reject(new Error('Too many redirects'));

    const u = new URL(url);
    const protocol = u.protocol === 'https:' ? https : http;

    const req = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://music.163.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
      },
      timeout: TIMEOUT_MS
    }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode)) {
        r.resume();
        const loc = r.headers.location;
        if (!loc) return reject(new Error('Redirect without location'));
        const next = new URL(loc, url);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') return reject(new Error('Bad protocol'));
        if (!isAllowedHost(next.hostname)) return reject(new Error('Host not allowed'));
        return resolve(proxyImage(next.toString(), res, redirectCount + 1));
      }

      if (r.statusCode !== 200) {
        r.resume();
        if (!res.headersSent) res.setHeader('X-Upstream-Status', String(r.statusCode || ''));
        return reject(new Error(`Upstream HTTP ${r.statusCode}`));
      }

      const ct = String(r.headers['content-type'] || '');
      const len = parseInt(r.headers['content-length'] || '0', 10) || 0;

      if (len && len > MAX_BYTES) {
        r.resume();
        return reject(new Error('Too large'));
      }

      if (ct && !ct.toLowerCase().startsWith('image/')) {
        r.resume();
        return reject(new Error('Not an image'));
      }

      res.setHeader('Content-Type', ct || 'image/*');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      if (len) res.setHeader('Content-Length', String(len));

      let streamed = 0;
      r.on('data', (chunk) => {
        streamed += chunk.length;
        if (streamed > MAX_BYTES) {
          try { req.destroy(); } catch (_) {}
          try { r.destroy(); } catch (_) {}
        }
      });
      r.on('error', reject);
      r.on('end', resolve);
      r.pipe(res);
    });

    req.on('timeout', () => {
      try { req.destroy(new Error('timeout')); } catch (_) {}
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

router.get('/', async (req, res) => {
  const raw = String(req.query.url || '').trim();

  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    return res.status(400).send('Bad url');
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return res.status(400).send('Bad protocol');
  }

  if (!isAllowedHost(u.hostname)) {
    return res.status(400).send('Host not allowed');
  }

  try {
    await proxyImage(u.toString(), res, 0);
  } catch (e) {
    const msg = e?.message || '';
    if (msg === 'Host not allowed' || msg === 'Bad protocol' || msg === 'Too many redirects') {
      return res.status(400).send(String(e.message));
    }
    if (msg === 'Not an image') {
      return res.status(415).send('Not an image');
    }
    if (msg === 'Too large') {
      return res.status(413).send('Too large');
    }
    if (msg.startsWith('Upstream HTTP')) {
      return res.status(502).send('Upstream error');
    }
    return res.status(504).send('Proxy failed');
  }
});

module.exports = router;
