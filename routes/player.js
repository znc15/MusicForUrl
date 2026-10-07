const express = require('express');
const { Readable } = require('node:stream');
const { createNodePlayer } = require('../lib/player-node');
const router = express.Router();
router.use(async (req, res) => {
  const abort = new AbortController();
  res.once('close', () => { if (!res.writableFinished) abort.abort(); });
  const ctx = { waitUntil(promise) { Promise.resolve(promise).catch(error => console.error('[Player background]', error.message)); } };
  try {
    const response = await createNodePlayer(ctx)(new Request(req.protocol + '://' + req.get('host') + req.originalUrl, {
      method: req.method, headers: req.headers, signal: abort.signal,
    }));
    res.status(response.status);
    response.headers.forEach((value, name) => res.setHeader(name, value));
    if (!response.body || req.method === 'HEAD') return res.end();
    const stream = Readable.fromWeb(response.body);
    stream.on('error', () => { if (!res.destroyed) res.destroy(); });
    res.once('close', () => stream.destroy());
    stream.pipe(res);
  } catch (error) {
    if (!res.headersSent) res.status(502).json({ success: false, message: '媒体服务暂时不可用' });
    else res.destroy();
  }
});
module.exports = router;
