const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

function fileStorage(directory, maxBytes = 256 * 1024 * 1024) {
  const root = path.resolve(directory);
  function files(key) {
    if (!/^(audio|cover)\/v2\/[a-f0-9]{64}$/.test(key)) throw new Error('Invalid cache key');
    const stem = path.join(root, key.replaceAll('/', '-'));
    return { body: stem + '.bin', meta: stem + '.json' };
  }
  async function remove(key) {
    const file = files(key);
    await Promise.all([fs.rm(file.body, { force: true }), fs.rm(file.meta, { force: true })]);
  }
  async function prune() {
    const entries = [];
    for (const name of await fs.readdir(root)) {
      if (!/^(audio|cover)-v2-[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const meta = JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
        if (meta.expiresAt <= Date.now()) await remove(meta.key);
        else entries.push(meta);
      } catch (_) {}
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0))) {
      if (total <= maxBytes) break;
      await remove(entry.key); total -= entry.size;
    }
  }
  return {
    async get(key, range) {
      const file = files(key);
      let meta;
      try { meta = JSON.parse(await fs.readFile(file.meta, 'utf8')); } catch (_) { return null; }
      let start = 0, end = meta.size - 1, status = 200;
      const match = range?.match(/^bytes=(\d*)-(\d*)$/);
      if (range && !match) return null;
      if (match) {
        start = match[1] ? Number(match[1]) : Math.max(0, meta.size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), meta.size - 1) : meta.size - 1;
        if (start > end || start >= meta.size) return { expiresAt: meta.expiresAt,
          response: new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + meta.size } }) };
        status = 206;
      }
      const headers = { 'content-type': meta.contentType, 'content-length': String(end - start + 1), 'accept-ranges': 'bytes' };
      if (status === 206) headers['content-range'] = 'bytes ' + start + '-' + end + '/' + meta.size;
      return { expiresAt: meta.expiresAt, response: new Response(Readable.toWeb(createReadStream(file.body, { start, end })), { status, headers }) };
    },
    async put(key, bytes, meta) {
      const file = files(key); await fs.mkdir(root, { recursive: true });
      await fs.writeFile(file.body, bytes);
      await fs.writeFile(file.meta, JSON.stringify({ ...meta, key, size: bytes.byteLength, savedAt: Date.now() }));
      await prune();
    },
    delete: remove,
  };
}
module.exports = { fileStorage };
