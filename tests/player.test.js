const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const policy = require('../lib/player-policy');
const { proxySource, boundedBytes, trackTransfer, fetchSource } = require('../lib/player-cache');
const { fileStorage } = require('../lib/player-file-cache');

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

test('private cache warms, serves exact byte ranges, expires, and tolerates storage failure', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mfu-player-cache-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('mfu-player-cache-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const original = global.fetch; t.after(() => { global.fetch = original; });
  let reads = 0;
  global.fetch = async () => { reads++; return new Response('0123456789', { headers: { 'content-length': '10', 'content-type': 'audio/mpeg' } }); };
  const storage = fileStorage(directory), pending = [];
  const options = { source: 'https://m1.music.126.net/song.mp3', platform: 'netease', storage,
    key: 'audio/v2/' + '1'.repeat(64), ctx: { waitUntil(p) { pending.push(p); } } };
  const miss = await proxySource(new Request('https://app.test/media'), options);
  assert.equal(miss.headers.get('x-mfu-cache'), 'MISS');
  assert.equal(await miss.text(), '0123456789');
  await Promise.all(pending);
  const hit = await proxySource(new Request('https://app.test/media', { headers: { range: 'bytes=2-5' } }), options);
  assert.equal(hit.status, 206); assert.equal(await hit.text(), '2345');
  assert.equal(hit.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(hit.headers.get('cache-control'), 'private, no-store');
  assert.equal(hit.headers.get('x-mfu-cache'), 'HIT'); assert.equal(reads, 1);
  const invalid = await storage.get(options.key, 'bytes=30-'); assert.equal(invalid.response.status, 416);
  await storage.put(options.key, new TextEncoder().encode('expired'), { expiresAt: Date.now() - 1, contentType: 'audio/mpeg' });
  const refreshed = await proxySource(new Request('https://app.test/media'), { ...options, fill: false });
  assert.equal(await refreshed.text(), '0123456789'); assert.equal(reads, 2);
  await Promise.all(pending);
  const broken = await proxySource(new Request('https://app.test/media'), { ...options,
    storage: { get() { throw new Error('storage offline'); } }, fill: false });
  assert.equal(await broken.text(), '0123456789');
});

test('completed media responses record once; canceled transfers do not record', async () => {
  let recorded = 0;
  const complete = trackTransfer(new Response('complete'), () => recorded++);
  assert.equal(await complete.text(), 'complete'); assert.equal(recorded, 1);
  const pending = trackTransfer(new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array([1])); } })), () => recorded++);
  const reader = pending.body.getReader(); await reader.read(); await reader.cancel();
  assert.equal(recorded, 1);
});

test('Node playback API shares quality policy, isolates colliding platform IDs and revokes cached media on logout', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mfu-player-node-'));
  process.env.DATA_DIR = directory; process.env.PLAYER_CACHE_DIR = path.join(directory, 'cache');
  process.env.ENCRYPTION_KEY = 'test-key-8cbfe0da29384dab9b486bd80dd83dea';
  process.env.AUDIO_CACHE_ENABLED = 'true';
  const { db, userOps, qqUserOps } = require('../lib/db');
  const { encrypt } = require('../lib/crypto');
  const netease = require('../lib/netease'), qq = require('../lib/qqmusic');
  const original = global.fetch; t.after(async () => {
    global.fetch = original; db.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('mfu-player-node-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const expiry = new Date(Date.now() + 86400000).toISOString().slice(0, 19).replace('T', ' ');
  userOps.upsert.run({ netease_id: '1001', nickname: 'Test', avatar: '', vip_type: 1, cookie: encrypt('MUSIC_U=fixture'), token: 'netease-session', token_expires_at: expiry });
  qqUserOps.upsert.run({ qq_uin: '1001', nickname: 'Test', avatar: '', vip_type: 1, cookie: encrypt('uin=fixture'), token: 'qq-session', token_expires_at: expiry });
  for (const provider of [netease, qq]) provider.getPlaylistDetail = async id => ({ id, name: 'Test', cover: '', tracks: [{ id: '555', mid: '555', name: 'Track', artist: 'Test', duration: 180 }] });
  netease.getSongResource = async (_, cookie, quality) => {
    assert.equal(cookie, 'MUSIC_U=fixture');
    return { url: 'https://m1.music.126.net/song.' + (quality === 'lossless' ? 'flac' : 'mp3'), format: quality === 'lossless' ? 'flac' : 'mp3', bitrate: quality === 'low' ? 128000 : 320000 };
  };
  global.fetch = async () => new Response('audio-bytes', { headers: { 'content-length': '11', 'content-type': 'audio/mpeg' } });
  const pending = [], { createNodePlayer } = require('../lib/player-node');
  const api = createNodePlayer({ waitUntil(p) { pending.push(p); } });
  const root = 'https://app.test/api/player';
  const list = await (await api(new Request(root + '/playlist?platform=netease&id=123', { headers: { 'x-token': 'netease-session' } }))).json();
  assert.equal(list.success, true);
  const query = new URLSearchParams({ platform: 'netease', id: '123', grant: list.data.grant, quality: 'lossless' });
  const source = await (await api(new Request(root + '/resolve/555?' + query))).json();
  assert.equal(source.data.format, 'flac');
  assert.equal(new URL(source.data.mediaUrl).hostname, 'app.test');
  assert.equal(JSON.stringify(source).includes('MUSIC_U'), false);
  assert.equal((await api(new Request(root + '/resolve/999?' + query))).status, 403);
  query.set('platform', 'qq'); assert.equal((await api(new Request(root + '/resolve/555?' + query))).status, 401);
  const media = await api(new Request(source.data.mediaUrl)); assert.equal(await media.text(), 'audio-bytes');
  await Promise.all(pending); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM player_events').get().n, 1);
  db.prepare('UPDATE users SET token = ? WHERE id = 1').run('new-session');
  assert.equal((await api(new Request(source.data.mediaUrl))).status, 401);
});
