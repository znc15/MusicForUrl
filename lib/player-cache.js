'use strict';
const { allowedSource, PlayerError } = require('./player-policy');
let pendingWrites = 0;
const MAX_BYTES = 16 * 1024 * 1024;
const pendingKeys = new Set();

async function fetchSource(value, platform, options = {}, image = false) {
  let url = allowedSource(value, platform, image);
  for (let attempt = 0; url && attempt < 4; attempt++) {
    const response = await fetch(url, { ...options, redirect: 'manual',
      headers: { 'accept-encoding': 'identity', ...(options.headers || {}) } });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const next = response.headers.get('location');
    await response.body?.cancel();
    try { url = allowedSource(new URL(next, url).href, platform, image); } catch (_) { url = null; }
  }
  throw new PlayerError('音源重定向不可用', 502, 'upstream_error');
}

async function boundedBytes(response, max = MAX_BYTES) {
  const reader = response.body.getReader();
  const declared = Number(response.headers.get('content-length'));
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > max) { await reader.cancel(); return null; }
  const bytes = new Uint8Array(declared);
  let offset = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (offset + chunk.value.byteLength > declared) { await reader.cancel(); return null; }
      bytes.set(chunk.value, offset); offset += chunk.value.byteLength;
    }
    return offset === declared ? bytes : null;
  } finally { reader.releaseLock(); }
}

function cleanResponse(response, cacheState, head = false) {
  const headers = new Headers();
  for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag']) {
    if (response.headers.has(key)) headers.set(key, response.headers.get(key));
  }
  if (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity') {
    headers.delete('content-length');
  }
  headers.set('cache-control', 'private, no-store');
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-expose-headers', 'Content-Length, Content-Range, X-MFU-Cache');
  headers.set('x-mfu-cache', cacheState);
  return new Response(head ? null : response.body, { status: response.status, headers });
}

async function proxySource(request, { source, platform, storage, key, ttl = 3600, ctx, image = false, fill = true }) {
  const head = request.method === 'HEAD';
  const range = request.headers.get('range');
  if (storage) {
    try {
      const hit = await storage.get(key, range);
      if (hit && hit.expiresAt > Date.now()) {
        if (head) await hit.response.body?.cancel();
        return cleanResponse(hit.response, 'HIT', head);
      }
      if (hit) { await hit.response.body?.cancel(); ctx.waitUntil(storage.delete(key).catch(() => {})); }
    } catch (error) { console.warn('[Cache read]', error.message); }
  }
  const response = await fetchSource(source, platform, {
    method: head ? 'HEAD' : 'GET', headers: range ? { range } : {}, signal: request.signal,
  }, image);
  if (storage && fill && !head && response.ok && pendingWrites < 1 && !pendingKeys.has(key)) {
    const length = Number(response.headers.get('content-length'));
    if (length > 0 && length <= MAX_BYTES && !response.headers.has('content-encoding')) {
      const complete = response.status === 200 ? response.clone() : null;
      pendingWrites++; pendingKeys.add(key);
      const write = async () => {
        try {
          const input = complete || await fetchSource(source, platform, { method: 'GET' }, image);
          if (!input.ok || input.status !== 200) { await input.body?.cancel(); return; }
          const bytes = await boundedBytes(input, image ? 2 * 1024 * 1024 : MAX_BYTES);
          if (bytes) await storage.put(key, bytes, { expiresAt: Date.now() + ttl * 1000,
            contentType: input.headers.get('content-type') || (image ? 'image/jpeg' : 'audio/mpeg') });
        } catch (error) { console.warn('[Cache write]', error.message); }
        finally { pendingWrites--; pendingKeys.delete(key); }
      };
      ctx.waitUntil(write());
    }
  }
  return cleanResponse(response, storage ? 'MISS' : 'BYPASS', head);
}

function trackTransfer(response, callback) {
  if (!response.ok || !response.body) return response;
  const reader = response.body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) { reader.releaseLock(); controller.close(); callback(); }
        else controller.enqueue(chunk.value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  const length = Number(response.headers.get('content-length'));
  const fixed = Number.isSafeInteger(length) && length >= 0 && response.headers.has('content-length')
    && typeof globalThis.FixedLengthStream === 'function' ? new FixedLengthStream(length) : null;
  if (fixed) stream.pipeTo(fixed.writable).catch(() => {});
  return new Response(fixed?.readable || stream, { status: response.status, headers: response.headers });
}

module.exports = { proxySource, fetchSource, boundedBytes, trackTransfer };
