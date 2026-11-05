const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/player-policy');
const { boundedBytes, trackTransfer, fetchSource } = require('../lib/player-cache');

test('quality resolution prefers a full lower source to a VIP trial, reports actual format, and never asks Cloudflare for FLAC', async () => {
  const calls = [];
  const result = await policy.resolveQuality(async level => {
    calls.push(level);
    return { url: 'https://m1.music.126.net/' + level + '.mp3', format: 'mp3',
      bitrate: level === 'high' ? 320000 : 192000, trial: level === 'high' };
  }, 'lossless', true);
  assert.deepEqual(calls, ['high', 'medium']);
  assert.equal(result.quality, 'medium');
  assert.equal(result.trial, false);
  assert.match(result.warnings.join(' '), /完整播放/);
  assert.equal(policy.capabilities('cloudflare', 'lossless').defaultQuality, 'high');
  assert.equal(policy.capabilities('cloudflare').qualities[3].enabled, false);
  const server = await policy.resolveQuality(async () => ({ url: 'https://m1.music.126.net/song.flac', format: 'flac' }), 'lossless');
  assert.equal(server.format, 'flac');
});

test('trial-only, unavailable, and expired platform login remain distinct', async () => {
  const trial = await policy.resolveQuality(async () => ({ url: 'https://m1.music.126.net/trial.mp3', trial: true }), 'high', true);
  assert.equal(trial.trial, true);
  assert.match(trial.warnings.join(' '), /试听片段/);
  await assert.rejects(policy.resolveQuality(async () => null, 'low'), error => error.status === 404);
  await assert.rejects(policy.resolveQuality(async () => ({ code: 301 }), 'high'), error => error.status === 401);
});

test('source redirect allowlist blocks private addresses and forwarded cookies', async t => {
  assert.equal(policy.allowedSource('http://127.0.0.1/song.mp3', 'netease'), null);
  assert.equal(policy.allowedSource('https://music.126.net.evil.test/song.mp3', 'netease'), null);
  const original = global.fetch; t.after(() => { global.fetch = original; });
  let requests = 0;
  global.fetch = async (_, options) => {
    requests++; assert.equal(options.headers.cookie, undefined);
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  };
  await assert.rejects(fetchSource('https://m1.music.126.net/song.mp3', 'netease'));
  assert.equal(requests, 1);
});

test('bounded caching rejects undersized, oversized and unknown-length bodies', async () => {
  assert.equal(await boundedBytes(new Response('abc', { headers: { 'content-length': '2' } })), null);
  assert.equal(await boundedBytes(new Response('abc', { headers: { 'content-length': '4' } })), null);
  assert.equal(await boundedBytes(new Response('abc')), null);
  assert.deepEqual(await boundedBytes(new Response('abc', { headers: { 'content-length': '3' } })), new TextEncoder().encode('abc'));
});

test('completed media responses record once; canceled transfers do not record', async () => {
  let recorded = 0;
  const complete = trackTransfer(new Response('complete'), () => recorded++);
  assert.equal(await complete.text(), 'complete'); assert.equal(recorded, 1);
  const pending = trackTransfer(new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array([1])); } })), () => recorded++);
  const reader = pending.body.getReader(); await reader.read(); await reader.cancel();
  assert.equal(recorded, 1);
});
