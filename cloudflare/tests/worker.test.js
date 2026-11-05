import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import CryptoJS from 'crypto-js';
import worker from '../src/index.js';
import {
  PLAY_LOG_DEDUP_MS, PLAY_LOG_MAX_PER_MINUTE,
  PLAY_LOG_RETENTION_MS, recordPlayback,
} from '../src/playback-history.js';
import {
  createPlaybackToken, createSession, decryptCookie, getPlaybackUser, getSessionUser,
  logout, requireSecret, sha256Hex,
} from '../src/security.js';
import { resolvePlayerSource } from '../src/player.js';
import { recordPlayEvent, recordRequestEvent, routeKey } from '../src/telemetry.js';
import { rateLimited } from '../src/request-policy.js';
import qqmusic from '../../lib/qqmusic.js';

function testEnv() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const DB = {
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.runSync());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    prepare(sql) {
      let args = [];
      return {
        bind(...values) {
          args = values;
          return this;
        },
        async first() {
          return sqlite.prepare(sql).get(...args) || null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...args) };
        },
        runSync() {
          const result = sqlite.prepare(sql).run(...args);
          return { meta: { changes: result.changes } };
        },
        async run() { return this.runSync(); },
      };
    },
  };
  return { DB, sqlite, ENCRYPTION_KEY: 'test-secret-7e8c8cf1369f49cdb64ba6dc4d8e8170' };
}

async function signedInUser(env, platform, platformUserId) {
  const cookie = `${platform === 'qq' ? 'qm_keyst' : 'MUSIC_U'}=private-cookie`;
  const { token } = await createSession(env, platform, {
    userId: platformUserId, nickname: 'Tester', avatar: '', vipType: 0,
  }, cookie);
  const request = new Request('https://music.example.test/api/auth/status', {
    headers: { [platform === 'qq' ? 'x-qq-token' : 'x-token']: token },
  });
  const user = await getSessionUser(env, request, platform, new URL(request.url));
  return { user, token, cookie };
}

test('new Worker player authorizes before R2, supports ranges, isolates accounts and revokes warmed links', async t => {
  const env = testEnv(); t.after(() => env.sqlite.close());
  const pending = [], objects = new Map(); let storageReads = 0, originReads = 0;
  env.AUDIO_CACHE_ENABLED = 'true';
  env.AUDIO_CACHE = {
    async get(key, options) {
      storageReads++;
      const item = objects.get(key); if (!item) return null;
      const match = options?.range?.get('range')?.match(/^bytes=(\d+)-(\d+)$/);
      const offset = match ? Number(match[1]) : 0;
      const length = match ? Number(match[2]) - offset + 1 : item.bytes.length;
      return { size: item.bytes.length, body: item.bytes.slice(offset, offset + length),
        range: { offset, length }, httpEtag: '"fixture"',
        customMetadata: item.meta.customMetadata,
        writeHttpMetadata(headers) { headers.set('content-type', item.meta.httpMetadata.contentType); } };
    },
    async put(key, bytes, meta) { objects.set(key, { bytes, meta }); },
    async delete(key) { objects.delete(key); },
  };
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async url => {
    assert.match(String(url), /^https:\/\/m1.music\.126\.net\//); originReads++;
    return new Response('0123456789', { headers: { 'content-length': '10', 'content-type': 'audio/mpeg' } });
  };
  const accounts = [await signedInUser(env, 'netease', '1001'), await signedInUser(env, 'netease', '1002')];
  for (const { user } of accounts) {
    await env.DB.prepare('INSERT INTO playlists (user_id, playlist_id, name, cover, song_count, songs_json, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(user.id, '123', 'Private playlist', '', 1, JSON.stringify([{ id: '555', name: 'Track', artist: 'Test', duration: 180 }]), Date.now() + 60000).run();
    const key = await sha256Hex([user.platform, user.id, '555', 'high'].join(':'));
    await env.DB.prepare('INSERT INTO song_sources (cache_key, source_json, expires_at_ms) VALUES (?, ?, ?)')
      .bind(key, JSON.stringify({ url: 'https://m1.music.126.net/song.mp3', format: 'mp3', bitrate: 320000,
        quality: 'high', resolvedRequestQuality: 'high', trial: false, warnings: [], expiresAt: Date.now() + 60000 }), Date.now() + 60000).run();
  }
  const base = 'https://music.example.test/api/player';
  const call = (path, init) => worker.fetch(new Request(base + path, init), env, ctx);
  assert.equal((await (await call('/capabilities')).json()).data.privateCache, true);
  const list = await (await call('/playlist?id=123', { headers: { 'x-token': accounts[0].token } })).json();
  const query = new URLSearchParams({ platform: 'netease', id: '123', grant: list.data.grant, quality: 'high' });
  assert.equal((await call('/media/999?' + query)).status, 403); assert.equal(storageReads, 0);
  const source = await (await call('/resolve/555?' + query)).json();
  assert.equal(source.data.format, 'mp3'); assert.equal(JSON.stringify(source).includes('music.126.net'), false);
  const cold = await worker.fetch(new Request(source.data.mediaUrl), env, ctx);
  assert.equal(cold.headers.get('x-mfu-cache'), 'MISS'); assert.equal(await cold.text(), '0123456789');
  await Promise.all(pending); assert.equal(objects.size, 1);
  const fullHit = await worker.fetch(new Request(source.data.mediaUrl), env, ctx);
  assert.equal(fullHit.status, 200); assert.equal(fullHit.headers.get('content-range'), null);
  assert.equal(await fullHit.text(), '0123456789');
  const warm = await worker.fetch(new Request(source.data.mediaUrl, { headers: { range: 'bytes=2-5' } }), env, ctx);
  assert.equal(warm.status, 206); assert.equal(warm.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(warm.headers.get('x-mfu-cache'), 'HIT'); assert.equal(await warm.text(), '2345'); assert.equal(originReads, 1);
  const second = await call('/media/555?id=123&quality=high', { headers: { 'x-token': accounts[1].token } });
  assert.equal(second.headers.get('x-mfu-cache'), 'MISS'); await second.text(); await Promise.all(pending);
  assert.equal(objects.size, 2);
  await logout(env, new Request('https://music.example.test/api/auth/logout', { headers: { 'x-token': accounts[0].token } }), 'netease', null, {});
  const before = storageReads;
  assert.equal((await worker.fetch(new Request(source.data.mediaUrl), env, ctx)).status, 401);
  assert.equal(storageReads, before);
  await Promise.all(pending);
});

test('resolve cache uses the Cache API with an absolute URL key and writes no D1 rows', async t => {
  const env = testEnv();
  t.after(() => env.sqlite.close());
  const { user } = await signedInUser(env, 'netease', '1001');
  const store = new Map();
  const keys = [];
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
  });
  globalThis.caches = {
    default: {
      async match(key) {
        keys.push(String(key));
        const hit = store.get(String(key));
        return hit ? hit.clone() : undefined;
      },
      async put(key, response) { keys.push(String(key)); store.set(String(key), response.clone()); },
    },
  };
  let upstream = 0;
  globalThis.fetch = async () => {
    upstream++;
    return Response.json({
      code: 200,
      data: [{ url: 'https://m1.music.126.net/track.mp3', br: 128000, type: 'mp3' }],
    });
  };
  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };

  const first = await resolvePlayerSource(env, user, '555', 'low', false, ctx);
  await Promise.all(pending);
  assert.equal(upstream, 1);
  assert.equal(store.size, 1);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS count FROM song_sources').get().count, 0);
  assert.ok(keys.length > 0 && keys.every(key => key.startsWith('https://resolve.mfu.internal/')),
    'Cache API keys must be absolute URLs');

  const second = await resolvePlayerSource(env, user, '555', 'low', false, ctx);
  // 缓存往返会丢掉值为 undefined 的字段（如 size），因此断言语义字段而非整体形状
  assert.equal(second.url, first.url);
  assert.equal(second.quality, first.quality);
  assert.equal(second.bitrate, first.bitrate);
  assert.equal(second.expiresAt, first.expiresAt);
  assert.equal(upstream, 1, 'a warm resolve must not call the upstream again');
});

test('placeholder deployment keys are rejected', () => {  assert.throws(() => requireSecret({ ENCRYPTION_KEY: 'your-32-character-secret-key-here' }));
  assert.throws(() => requireSecret({ ENCRYPTION_KEY: 'replace-with-a-random-secret-of-at-least-32-characters' }));
});

test('account status exposes the signed-in platform identity without credentials or another account', async () => {
  const env = testEnv();
  const ctx = { waitUntil() {} };
  for (const [platform, userId] of [['netease', '1001'], ['qq', '2002']]) {
    const { token } = await signedInUser(env, platform, userId);
    const path = platform === 'qq' ? '/api/qq/auth/status' : '/api/auth/status';
    const header = platform === 'qq' ? 'x-qq-token' : 'x-token';
    const response = await worker.fetch(new Request('https://music.example.test' + path, {
      headers: { [header]: token },
    }), env, ctx);
    const body = await response.json();
    assert.equal(body.data.logged, true);
    assert.equal(body.data.user.userId, userId);
    assert.deepEqual(Object.keys(body.data.user).sort(), ['avatar', 'nickname', 'platform', 'userId', 'vipType']);
    assert.equal(body.data.user.platform, platform);
    const anonymous = await worker.fetch(new Request('https://music.example.test' + path), env, ctx);
    assert.deepEqual((await anonymous.json()).data, { logged: false });
  }
});

test('encrypted cookies round-trip and playback tokens cannot cross platforms', async () => {
  const env = testEnv();
  const { user, cookie } = await signedInUser(env, 'netease', '1001');
  await signedInUser(env, 'qq', '2002');
  assert.equal(await decryptCookie(env, user), cookie);

  const playbackToken = await createPlaybackToken(env, user, '123456');
  assert.equal((await getPlaybackUser(env, playbackToken, 'netease', '123456')).id, user.id);
  assert.equal(await getPlaybackUser(env, playbackToken, 'qq', '123456'), null);
  assert.equal(await getPlaybackUser(env, playbackToken, 'netease', '999999'), null);
});

test('logout revokes both the login token and issued playback links', async () => {
  const env = testEnv();
  const { user, token } = await signedInUser(env, 'qq', '23456');
  const playbackToken = await createPlaybackToken(env, user, '321');
  assert.ok(await getPlaybackUser(env, playbackToken, 'qq', '321'));

  const request = new Request('https://music.example.test/api/qq/auth/logout', {
    method: 'POST', headers: { 'x-qq-token': token },
  });
  await logout(env, request, 'qq', new URL(request.url), {});
  assert.equal(await getSessionUser(env, request, 'qq', new URL(request.url)), null);
  assert.equal(await getPlaybackUser(env, playbackToken, 'qq', '321'), null);
});

test('Worker serves a cached lightweight playlist and rejects unauthenticated API calls', async () => {
  const env = testEnv();
  const { user, token } = await signedInUser(env, 'netease', '1001');
  await env.DB.prepare(`
    INSERT INTO playlists (user_id, playlist_id, name, cover, song_count, songs_json, expires_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(user.id, '123456', 'Test list', '', 1, JSON.stringify([
    { id: '555', name: 'Track', artist: 'Artist', duration: 200, cover: '' },
  ]), Date.now() + 60000).run();
  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };

  const unauthenticated = await worker.fetch(
    new Request('https://music.example.test/api/playlist/url?id=123456'), env, ctx,
  );
  assert.equal(unauthenticated.status, 401);

  const response = await worker.fetch(new Request(
    'https://music.example.test/api/playlist/url?id=123456',
    { headers: { 'x-token': token } },
  ), env, ctx);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.urls.map((item) => item.type), ['lite']);

  const playlistResponse = await worker.fetch(new Request(body.data.url), env, ctx);
  assert.equal(playlistResponse.status, 200);
  const m3u8 = await playlistResponse.text();
  assert.match(m3u8, /#EXTM3U/);
  assert.match(m3u8, /Artist - Track/);
  assert.match(m3u8, /\/api\/song\/.+\/555\.mp3\?playlist=123456/);
  const segmentUrl = new URL(m3u8.split('\n').find((line) => line.startsWith('https://')));
  assert.equal(segmentUrl.searchParams.get('hls'), '1');
  assert.equal(segmentUrl.origin, new URL(body.data.url).origin);

  const headResponse = await worker.fetch(new Request(body.data.url, { method: 'HEAD' }), env, ctx);
  assert.equal(headResponse.status, 200);
  assert.equal(await headResponse.text(), '');

  const playbackToken = new URL(body.data.url).pathname.match(/\/m3u8\/([^/]+)\//)[1];
  const otherSong = await worker.fetch(new Request(
    `https://music.example.test/api/song/${playbackToken}/999.mp3?playlist=123456`,
  ), env, ctx);
  assert.equal(otherSong.status, 403);

  const obsolete = await worker.fetch(new Request(
    `https://music.example.test/api/hls/${encodeURIComponent(body.data.url)}/123456/master.m3u8`,
  ), env, ctx);
  assert.equal(obsolete.status, 410);

  // 旧版前端只走 /url：签发链接要计入，未重新解析歌单则解析数保持 0
  await Promise.all(pending);
  assert.equal(env.sqlite.prepare("SELECT value FROM site_stats WHERE key = 'generatedLinks'").get().value, 1);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS total FROM site_stats WHERE key = 'parsedSongs'").get().total, 0);
});

test('favorites and recent history use the signed-in account in D1', async () => {
  const env = testEnv();
  const { user, token } = await signedInUser(env, 'qq', '998877');
  const ctx = { waitUntil() {} };
  const base = 'https://music.example.test/api/qq';
  const headers = { 'x-qq-token': token };
  const added = await worker.fetch(new Request(`${base}/favorites`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ playlistId: '123', playlistName: 'QQ list' }),
  }), env, ctx);
  assert.equal(added.status, 200);

  const list = await worker.fetch(new Request(`${base}/favorites`, { headers }), env, ctx);
  assert.equal((await list.json()).data[0].playlistId, '123');

  await env.DB.prepare(`
    INSERT INTO playlists (user_id, playlist_id, name, cover, song_count, songs_json, expires_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(user.id, '123', 'QQ list', '', 1, '[]', Date.now() + 60000).run();
  await env.DB.prepare(`
    INSERT INTO play_stats (user_id, playlist_id, song_id, song_name, artist, play_count, last_played_at_ms)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).bind(user.id, '123', 'mid1', 'Song', 'Artist', Date.now()).run();
  const recent = await worker.fetch(new Request(`${base}/history/recent`, { headers }), env, ctx);
  const recentBody = await recent.json();
  assert.equal(recentBody.total, 1);
  assert.equal(recentBody.data[0].name, 'QQ list');

  const removed = await worker.fetch(new Request(`${base}/favorites/123`, {
    method: 'DELETE', headers,
  }), env, ctx);
  assert.equal(removed.status, 200);
  const after = await worker.fetch(new Request(`${base}/favorites`, { headers }), env, ctx);
  assert.equal((await after.json()).total, 0);
});

test('query-string session tokens cannot authenticate or log out either platform', async t => {
  const env = testEnv();
  t.after(() => env.sqlite.close());
  const ctx = { waitUntil() {} };
  for (const platform of ['netease', 'qq']) {
    const { token, user } = await signedInUser(env, platform, '1001');
    const base = 'https://music.example.test/api' + (platform === 'qq' ? '/qq' : '');
    const key = platform === 'qq' ? 'qqtoken' : 'token';
    const header = platform === 'qq' ? 'x-qq-token' : 'x-token';
    const query = '?' + key + '=' + token;
    const status = await worker.fetch(new Request(base + '/auth/status' + query), env, ctx);
    assert.deepEqual((await status.json()).data, { logged: false });
    const favorites = await worker.fetch(new Request(base + '/favorites' + query), env, ctx);
    assert.equal(favorites.status, 401);

    await worker.fetch(new Request(base + '/auth/logout' + query, { method: 'POST' }), env, ctx);
    const authenticated = new Request(base + '/auth/status', { headers: { [header]: token } });
    assert.equal((await getSessionUser(env, authenticated, platform)).id, user.id);

    const playbackToken = await createPlaybackToken(env, user, '123');
    const loggedOut = await worker.fetch(new Request(base + '/auth/logout', {
      method: 'POST', body: JSON.stringify({ [key]: token }),
    }), env, ctx);
    assert.equal(loggedOut.status, 200);
    assert.equal(await getSessionUser(env, authenticated, platform), null);
    assert.equal(await getPlaybackUser(env, playbackToken, platform, '123'), null);
  }
});

function streamedBody(text) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let canceled = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.subarray(offset, offset + 8192));
      offset += 8192;
    },
    cancel() { canceled = true; },
  });
  return { stream, canceled: () => canceled };
}

test('oversized JSON is canceled and rejected with 413 without relying on Content-Length', async t => {
  const env = testEnv();
  t.after(() => env.sqlite.close());
  const { token } = await signedInUser(env, 'netease', '1001');
  const ctx = { waitUntil() {} };
  for (const route of ['/favorites', '/auth/login/cookie']) {
    for (const length of [undefined, '8', '65536', '65537']) {
      const payload = streamedBody(JSON.stringify({ playlistId: '123', cookie: '界'.repeat(50000) }));
      const headers = { 'x-token': token, 'content-type': 'application/json' };
      if (length !== undefined) headers['content-length'] = length;
      const response = await worker.fetch(new Request('https://music.example.test/api' + route, {
        method: 'POST', headers, body: payload.stream, duplex: 'half',
      }), env, ctx);
      assert.equal(response.status, 413, route + ': ' + length);
      assert.equal((await response.json()).success, false);
      assert.equal(payload.canceled(), true);
    }
  }
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS count FROM favorites').get().count, 0);
});

test('valid chunked JSON at the exact 64 KiB byte limit still saves a favorite', async t => {
  const env = testEnv();
  t.after(() => env.sqlite.close());
  const { token } = await signedInUser(env, 'qq', '2002');
  const data = { playlistId: '123', playlistName: '界'.repeat(10000), nickname: '' };
  const size = new TextEncoder().encode(JSON.stringify(data)).length;
  data.nickname = 'x'.repeat(65536 - size);
  const text = JSON.stringify(data);
  assert.equal(new TextEncoder().encode(text).length, 65536);
  const payload = streamedBody(text);
  const response = await worker.fetch(new Request('https://music.example.test/api/qq/favorites', {
    method: 'POST', headers: { 'x-qq-token': token }, body: payload.stream, duplex: 'half',
  }), env, { waitUntil() {} });
  assert.equal(response.status, 200);
  assert.equal(payload.canceled(), false);
  assert.equal(env.sqlite.prepare('SELECT playlist_name FROM favorites').get().playlist_name, data.playlistName);
});

test('playback logging deduplicates concurrent retries while preserving account and playlist isolation', async t => {
  const env = testEnv();
  t.after(() => env.sqlite.close());
  const { user } = await signedInUser(env, 'netease', '1001');
  const other = (await signedInUser(env, 'qq', '2002')).user;
  const song = { id: '555', name: 'Track', artist: 'Artist' };
  const now = Date.now();
  const plays = () => env.sqlite.prepare('SELECT COALESCE(SUM(play_count), 0) AS plays FROM play_stats').get().plays;
  const rows = () => env.sqlite.prepare('SELECT COUNT(*) AS count FROM play_stats').get().count;
  await Promise.all(Array.from({ length: 20 }, () => recordPlayback(env, user.id, '123', song, now)));
  assert.equal(plays(), 1);
  assert.equal(rows(), 1);
  await recordPlayback(env, user.id, '456', song, now);
  await recordPlayback(env, other.id, '123', song, now);
  assert.equal(plays(), 3);
  assert.equal(rows(), 3);
  await recordPlayback(env, user.id, '123', song, now + PLAY_LOG_DEDUP_MS);
  assert.equal(plays(), 3);
  await recordPlayback(env, user.id, '123', song, now + PLAY_LOG_DEDUP_MS + 1);
  assert.equal(plays(), 4);
  assert.equal(rows(), 3);
});

test('logging limits each account to 12 new events in a rolling minute', async t => {
  const env = testEnv();
  t.after(() => env.sqlite.close());
  const { user } = await signedInUser(env, 'netease', '1001');
  const now = Date.now();
  const plays = () => env.sqlite.prepare('SELECT COALESCE(SUM(play_count), 0) AS plays FROM play_stats').get().plays;
  for (let index = 0; index < PLAY_LOG_MAX_PER_MINUTE + 3; index++) {
    await recordPlayback(env, user.id, '123', { id: String(index), name: 'Track', artist: '' }, now);
  }
  assert.equal(plays(), 12);
  await recordPlayback(env, user.id, '123', { id: '999', name: 'Track', artist: '' }, now + 60001);
  assert.equal(plays(), 13);
});

test('cron prunes playback stats older than the retention window without touching recent rows', async t => {
  const env = testEnv();
  t.after(() => env.sqlite.close());
  const { user } = await signedInUser(env, 'netease', '1001');
  const other = (await signedInUser(env, 'qq', '2002')).user;
  const now = Date.now();
  const insert = env.sqlite.prepare(
    'INSERT INTO play_stats (user_id, playlist_id, song_id, play_count, last_played_at_ms) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run(user.id, '123', 'stale', 4, now - PLAY_LOG_RETENTION_MS - 10000);
  insert.run(user.id, '123', 'fresh', 2, now);
  insert.run(other.id, '456', 'stale', 1, now - PLAY_LOG_RETENTION_MS - 10000);
  insert.run(other.id, '456', 'recent', 1, now);
  await recordPlayback(env, user.id, '123', { id: '99999', name: 'New', artist: '' }, now);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS count FROM play_stats WHERE song_id = 'stale'").get().count, 2);
  assert.ok(env.sqlite.prepare("SELECT 1 FROM play_stats WHERE song_id = '99999'").get());
  const tasks = [];
  worker.scheduled({}, env, { waitUntil(task) { tasks.push(task); } });
  await Promise.all(tasks);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS count FROM play_stats WHERE song_id = 'stale'").get().count, 0);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS count FROM play_stats WHERE song_id = 'fresh'").get().count, 1);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS count FROM play_stats WHERE song_id = 'recent'").get().count, 1);
  assert.equal(env.sqlite.prepare("SELECT play_count AS plays FROM play_stats WHERE song_id = '99999'").get().plays, 1);
});

test('cron waits for every purge before publishing refreshed stats', async t => {
  const env = testEnv();
  t.after(() => env.sqlite.close());
  const { user } = await signedInUser(env, 'netease', 'cron-order');
  env.sqlite.prepare('INSERT INTO play_stats (user_id, playlist_id, song_id, play_count, last_played_at_ms) VALUES (?, ?, ?, ?, ?)')
    .run(user.id, '123', 'stale', 7, Date.now() - PLAY_LOG_RETENTION_MS - 10000);
  const prepare = env.DB.prepare.bind(env.DB);
  const releases = [];
  let aggregateReads = 0;
  env.DB.prepare = sql => {
    const statement = prepare(sql);
    if (sql.startsWith('DELETE FROM')) {
      const run = statement.run.bind(statement);
      statement.run = () => new Promise(resolve => releases.push(() => resolve(run())));
    }
    if (sql.includes('COUNT(*) AS songs')) aggregateReads++;
    return statement;
  };
  const tasks = [];
  worker.scheduled({}, env, { waitUntil(task) { tasks.push(task); } });
  assert.equal(releases.length, 6);
  assert.equal(aggregateReads, 0);
  // Keep playback pruning last: the aggregate must not capture its expired row.
  for (const release of releases.slice(1)) release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aggregateReads, 0);
  releases[0]();
  await Promise.all(tasks);
  assert.equal(aggregateReads, 1);
  assert.equal(env.sqlite.prepare('SELECT plays FROM playback_totals').get().plays, 0);
});

test('cron preserves purge failures and does not refresh partially cleaned stats', async t => {
  const env = testEnv();
  t.after(() => env.sqlite.close());
  const prepare = env.DB.prepare.bind(env.DB);
  const failure = new Error('purge unavailable');
  let aggregateReads = 0;
  env.DB.prepare = sql => {
    const statement = prepare(sql);
    if (sql.startsWith('DELETE FROM qr_sessions')) statement.run = async () => { throw failure; };
    if (sql.includes('COUNT(*) AS songs')) aggregateReads++;
    return statement;
  };
  const tasks = [];
  worker.scheduled({}, env, { waitUntil(task) { tasks.push(task); } });
  await assert.rejects(Promise.all(tasks), error => error === failure);
  assert.equal(aggregateReads, 0);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS count FROM site_stats').get().count, 0);
});

test('cron logs stats failures without rejecting completed cleanup', async t => {
  const env = testEnv();
  t.after(() => env.sqlite.close());
  const prepare = env.DB.prepare.bind(env.DB);
  const failure = new Error('stats unavailable');
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  env.DB.prepare = sql => {
    const statement = prepare(sql);
    if (sql.includes('COUNT(*) AS songs')) statement.first = async () => { throw failure; };
    return statement;
  };
  const tasks = [];
  worker.scheduled({}, env, { waitUntil(task) { tasks.push(task); } });
  await Promise.all(tasks);
  assert.deepEqual(errors, [['[Cron] stats', failure]]);
});

test('recent and top history exclude expired events before the daily cleanup runs', async t => {
  const env = testEnv();
  t.after(() => env.sqlite.close());
  const { user, token } = await signedInUser(env, 'netease', '1001');
  const insert = env.sqlite.prepare(
    'INSERT INTO play_stats (user_id, playlist_id, song_id, play_count, last_played_at_ms) VALUES (?, ?, ?, 1, ?)',
  );
  insert.run(user.id, '123', '555', Date.now());
  insert.run(user.id, '456', '666', Date.now() - PLAY_LOG_RETENTION_MS - 10000);
  await recordPlayback(env, user.id, '123', { id: '555', name: 'Recent' });
  await recordPlayback(env, user.id, '456', { id: '666', name: 'Expired' }, Date.now() - PLAY_LOG_RETENTION_MS - 10000);
  const headers = { 'x-token': token };
  const recent = await worker.fetch(new Request('https://music.example.test/api/history/recent', { headers }), env, {});
  const recentBody = await recent.json();
  assert.equal(recentBody.total, 1);
  assert.equal(recentBody.data.length, 1);
  assert.equal(recentBody.data[0].playlistId, '123');
  const top = await worker.fetch(new Request('https://music.example.test/api/history/top', { headers }), env, {});
  assert.deepEqual((await top.json()).data.map(row => row.songId), ['555']);
});

test('both platforms map lossless to MP3 and record only completed, deduplicated HLS transfers', async t => {
  const env = testEnv();
  t.after(() => env.sqlite.close());
  env.MUSIC_QUALITY = ' LOSSLESS ';
  const oldFetch = globalThis.fetch;
  const oldQuality = process.env.MUSIC_QUALITY;
  process.env.MUSIC_QUALITY = 'lossless';
  const qualities = [];
  const filenames = [];
  const media = new Uint8Array([0xff, 0xfb, 0x90, 0, 1, 2, 3, 4]);
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'interface.music.163.com') {
      const encrypted = new URLSearchParams(options.body).get('params');
      const plain = CryptoJS.AES.decrypt({
        ciphertext: CryptoJS.enc.Hex.parse(encrypted),
      }, CryptoJS.enc.Utf8.parse('e82ckenh8dichen8'), {
        mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7,
      }).toString(CryptoJS.enc.Utf8);
      const data = JSON.parse(plain.split('-36cd479b6b5-')[1]);
      qualities.push(data.level);
      return Response.json({ code: 200, data: [{ url: 'https://m1.music.126.net/test.mp3' }] });
    }
    if (url.hostname === 'u.y.qq.com') {
      const file = JSON.parse(url.searchParams.get('data')).req_0.param.filename[0];
      filenames.push(file);
      return Response.json({ req_0: { data: {
        midurlinfo: [{ purl: file }], sip: ['https://dl.stream.qqmusic.qq.com/'],
      } } });
    }
    return new Response(url.pathname.endsWith('.mp3') ? media : new TextEncoder().encode('fLaCdata'), {
      headers: { 'content-type': 'audio/mpeg', 'content-length': String(media.length) },
    });
  };
  try {
    for (const platform of ['netease', 'qq']) {
      const { user } = await signedInUser(env, platform, '1001');
      const song = { id: '555', name: 'Track', artist: 'Artist', duration: 200 };
      await env.DB.prepare(
        'INSERT INTO playlists (user_id, playlist_id, songs_json, expires_at_ms) VALUES (?, ?, ?, ?)',
      ).bind(user.id, '123', JSON.stringify([song]), Date.now() + 60000).run();
      const token = await createPlaybackToken(env, user, '123');
      const base = 'https://music.example.test/api' + (platform === 'qq' ? '/qq' : '');
      const url = base + '/song/' + token + '/555.mp3?playlist=123&hls=1';
      const tasks = [];
      const ctx = { waitUntil(task) { tasks.push(task); } };
      const head = await worker.fetch(new Request(url, { method: 'HEAD' }), env, ctx);
      assert.equal(head.status, 200);
      assert.equal(tasks.length, 0);
      const aborted = await worker.fetch(new Request(url), env, ctx);
      const reader = aborted.body.getReader();
      await reader.read();
      await reader.cancel();
      assert.equal(tasks.length, 0);
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await worker.fetch(new Request(url), env, ctx);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'audio/mpeg');
        if (attempt === 0) assert.equal(tasks.length, 0);
        const received = new Uint8Array(await response.arrayBuffer());
        assert.deepEqual(received.slice(-media.length), media);
        await Promise.all(tasks);
      }
      assert.equal(env.sqlite.prepare('SELECT COALESCE(SUM(play_count), 0) AS plays FROM play_stats WHERE user_id = ?').get(user.id).plays, 1);
    }
    assert.ok(qualities.length > 0);
    assert.ok(qualities.every(level => level === 'exhigh'));
    assert.ok(filenames.length > 0);
    assert.ok(filenames.every(file => file.startsWith('M800') && file.endsWith('.mp3')));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldQuality === undefined) delete process.env.MUSIC_QUALITY;
    else process.env.MUSIC_QUALITY = oldQuality;
  }
});

async function seedPlaylist(env, user, playlistId = '123456') {
  await env.DB.prepare(`
    INSERT INTO playlists (user_id, playlist_id, name, cover, song_count, songs_json, expires_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(user.id, playlistId, 'Test list', '', 1, JSON.stringify([
    { id: '555', name: 'Track', artist: 'Artist', duration: 200, cover: '' },
  ]), Date.now() + 60000).run();
}

test('real legacy duration reaches all playback surfaces and permanent SQL totals', async t => {
  const env = testEnv(); t.after(() => env.sqlite.close()); env.MUSIC_QUALITY = 'high';
  const media = new Uint8Array([0xff, 0xfb, 0x90, 0, 1, 2, 3, 4]);
  t.mock.method(globalThis, 'fetch', async () => new Response(media, {
    headers: { 'content-type': 'audio/mpeg', 'content-length': String(media.length) },
  }));
  for (const [i, surface] of ['player', 'hls', 'redirect'].entries()) {
    const { user } = await signedInUser(env, 'netease', `duration-surface-${i}`);
    const id = String(9870 + i);
    await seedPlaylist(env, user, id); // legacy array, known 200 seconds
    const key = await sha256Hex(`netease:${user.id}:555:high`);
    await env.DB.prepare('INSERT INTO song_sources VALUES (?, ?, ?)').bind(key, JSON.stringify({
      url: 'https://m1.music.126.net/duration.mp3', quality: 'high', format: 'mp3', bitrate: 320000,
      expiresAt: Date.now() + 60000,
    }), Date.now() + 60000).run();
    const grant = await createPlaybackToken(env, user, id);
    const path = surface === 'player' ? `/api/player/media/555?platform=netease&id=${id}&grant=${grant}&quality=high`
      : `/api/song/${grant}/555.mp3?playlist=${id}${surface === 'hls' ? '&hls=1' : ''}`;
    const tasks = [];
    const response = await worker.fetch(new Request('https://music.example.test' + path), env, { waitUntil(task) { tasks.push(task); } });
    assert.equal(response.status, surface === 'redirect' ? 302 : 200);
    await response.arrayBuffer(); await Promise.all(tasks);
    const event = env.sqlite.prepare('SELECT duration_ms,surface FROM playback_events WHERE user_id=?').get(user.id);
    assert.equal(event.duration_ms, 200000);
    assert.equal(event.surface, surface);
  }
  const totals = env.sqlite.prepare('SELECT plays,duration_ms,known_duration_plays FROM playback_totals').get();
  assert.deepEqual({ ...totals }, { plays: 3, duration_ms: 600000, known_duration_plays: 3 });
});

test('playlist generation resolves the link in a single request', async t => {
  const env = testEnv();
  t.after(() => env.sqlite.close());
  const { user, token } = await signedInUser(env, 'netease', '1001');
  await seedPlaylist(env, user);
  const response = await worker.fetch(new Request('https://music.example.test/api/playlist/generate', {
    method: 'POST',
    headers: { 'x-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://music.163.com/playlist?id=123456' }),
  }), env, { waitUntil() {} });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.playlist.name, 'Test list');
  assert.equal(body.data.playlist.songCount, 1);
  assert.equal(body.data.playlist.totalCount, 1);
  assert.equal(body.data.playlist.includedCount, 1);
  assert.equal(body.data.playlist.partialReason, null);
  assert.equal(body.data.default, 'lite');
  assert.match(body.data.url,
    /^https:\/\/music\.example\.test\/api\/playlist\/m3u8\/[^/]+\/123456\/stream\.m3u8$/);
  assert.equal(body.data.urls[0].url, body.data.url);
  const grant = new URL(body.data.url).pathname.split('/')[4];
  const payload = JSON.parse(Buffer.from(grant.split('.')[0], 'base64url').toString());
  assert.equal(body.data.expiresAt, payload.e * 1000);
});

test('shed mode rejects new sessions while issued links keep playing', async t => {
  const env = testEnv();
  t.after(() => env.sqlite.close());
  const { user, token } = await signedInUser(env, 'netease', '1001');
  await seedPlaylist(env, user);
  const playbackToken = await createPlaybackToken(env, user, '123456');
  env.DEGRADE_MODE = 'shed';
  const ctx = { waitUntil() {} };

  const shed = await worker.fetch(new Request(
    'https://music.example.test/api/playlist/parse?url=123456', { headers: { 'x-token': token } },
  ), env, ctx);
  assert.equal(shed.status, 503);
  assert.ok(Number(shed.headers.get('retry-after')) > 0);

  // 已经签发的播放链接不受影响
  const stream = await worker.fetch(new Request(
    `https://music.example.test/api/playlist/m3u8/${encodeURIComponent(playbackToken)}/123456/stream.m3u8`,
  ), env, ctx);
  assert.equal(stream.status, 200);
  assert.match(await stream.text(), /^#EXTM3U/);

  const health = await worker.fetch(new Request('https://music.example.test/api/health'), env, ctx);
  assert.equal((await health.json()).degradeMode, 'shed');

  env.DEGRADE_MODE = 'links-only';
  const capabilities = await worker.fetch(new Request(
    'https://music.example.test/api/player/capabilities',
  ), env, ctx);
  assert.equal((await capabilities.json()).data.degraded, 'links-only');
});

test('telemetry is optional, sampled and never breaks a request', async () => {
  const env = testEnv();
  const request = new Request('https://music.example.test/api/health');
  // 没有绑定时不抛错，只是不记录
  assert.equal(recordPlayEvent(env, { platform: 'netease', userId: 1, playlistId: '1', song: { id: '5' } }), false);
  assert.equal(recordRequestEvent(env, request, new URL(request.url), 200, 5), false);

  const points = [];
  env.ANALYTICS = { writeDataPoint: point => points.push(point) };
  env.ANALYTICS_REQUESTS = { writeDataPoint: () => { throw new Error('daily quota exceeded'); } };
  env.REQUEST_TELEMETRY_SAMPLE = '1';

  assert.equal(recordPlayEvent(env, {
    platform: 'netease', userId: 1, playlistId: '1', song: { id: '5', name: 'T', artist: 'A' },
    quality: 'low', format: 'mp3', bitrate: 128000, trial: false, surface: 'hls', cacheState: 'MISS',
  }), true);
  assert.equal(points.length, 1);
  assert.equal(points[0].blobs[0], 'play');
  assert.equal(points[0].blobs[3], '5');
  assert.equal(points[0].doubles[2], 128000);

  // 分片与媒体请求已由播放事件覆盖，不再单独记录
  assert.equal(recordRequestEvent(env, request, new URL('https://music.example.test/api/song/t/5.mp3'), 200, 5), false);
  assert.equal(recordRequestEvent(env, request, new URL('https://music.example.test/api/player/media/5'), 200, 5), false);
  // 写入抛错被吞掉，请求不受影响
  assert.equal(recordRequestEvent(env, request, new URL('https://music.example.test/api/health'), 200, 5), false);
  assert.equal(routeKey('/api/qq/playlist/m3u8/x/1/stream.m3u8'), 'playlist.stream');
  assert.equal(routeKey('/api/player/resolve/555'), 'player.resolve');
  assert.equal(routeKey('/unknown'), 'other');
});

test('unsupported Cookie logins cannot replace an existing QQ, Kugou or Kuwo account', async t => {
  const env = testEnv(); t.after(() => env.sqlite.close());
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('forged cookies must not reach upstream'); });
  for (const [platform, cookie] of [
    ['qq', 'uin=9001; qm_keyst=fake'], ['kugou', 'userid=9001; token=fake'], ['kuwo', 'userid=9001; sid=fake'],
  ]) {
    const { token, userId } = await createSession(env, platform, { userId: '9001', nickname: 'Original' }, 'original-cookie');
    const original = env.sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const grant = await createPlaybackToken(env, original, '123');
    const response = await worker.fetch(new Request(`https://music.example.test/api/${platform}/auth/login/cookie`, {
      method: 'POST', body: JSON.stringify({ cookie }),
    }), env, { waitUntil() {} });
    assert.equal(response.status, 405, platform);
    assert.equal((await response.json()).success, false);
    assert.deepEqual(env.sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userId), original);
    const request = new Request('https://music.example.test/', { headers: { [`x-${platform}-token`]: token } });
    assert.equal((await getSessionUser(env, request, platform)).id, userId);
    assert.equal((await getPlaybackUser(env, grant, platform, '123')).id, userId);
  }
});

test('QQ sessions require registered QR confirmation and matching server-returned identity', async t => {
  const env = testEnv(); t.after(() => env.sqlite.close());
  const ctx = { waitUntil() {} };
  const key = 'trusted-qr-key';
  const register = () => env.DB.prepare('INSERT INTO qr_sessions(platform, key_hash, expires_at_ms) VALUES (?, ?, ?)')
    .bind('qq', keyHash, Date.now() + 60000).run();
  const keyHash = await sha256Hex(key);
  let result = { code: 0, cookie: 'uin=9001; qm_keyst=server-key', uin: '9001', nickname: 'QR nickname' };
  let polls = 0;
  t.mock.method(qqmusic, 'checkQRCode', async () => { polls++; return result; });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('profile temporarily unavailable'); });
  const call = () => worker.fetch(new Request(`https://music.example.test/api/qq/auth/qrcode/check?key=${key}`), env, ctx);
  assert.equal((await call()).status, 400);
  assert.equal(polls, 0, 'unregistered QR keys never reach provider');
  await register();
  const response = await call();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.user.userId, '9001');
  assert.equal(body.data.user.nickname, 'QR nickname');
  const before = env.sqlite.prepare('SELECT * FROM users').all();
  assert.equal((await call()).status, 400, 'consumed QR cannot create another session');
  for (const invalid of [
    { ...result, uin: '9002' }, { ...result, cookie: 'uin=9001; skey=only-pt-cookie' }, { ...result, uin: '' },
  ]) {
    result = invalid;
    await register();
    assert.equal((await call()).status, 401);
    assert.deepEqual(env.sqlite.prepare('SELECT * FROM users').all(), before);
  }
});

test('QQ Worker login traverses the real redirect exchange and rejects incomplete or unsafe music callbacks', async t => {
  for (const scenario of ['success', 'unsafe', 'http-error', 'missing-key', 'wrong-identity']) {
    const env = testEnv(); t.after(() => env.sqlite.close());
    const original = await createSession(env, 'qq', { userId: '9001', nickname: 'Before' }, 'uin=9001; qm_keyst=old');
    const before = env.sqlite.prepare('SELECT * FROM users WHERE id = ?').get(original.userId);
    const key = `qr-${scenario}`;
    await env.DB.prepare('INSERT INTO qr_sessions(platform,key_hash,expires_at_ms) VALUES(?,?,?)')
      .bind('qq', await sha256Hex(key), Date.now() + 60000).run();
    let callbackVisited = false;
    t.mock.method(globalThis, 'fetch', async (input, options) => {
      const url = new URL(input);
      if (url.pathname === '/ptqrlogin') return new Response(
        "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?uin=9001','0','登录成功','QR User')", {
          headers: { 'set-cookie': 'uin=9001; Domain=.qq.com; Path=/; Secure' },
        });
      if (url.pathname === '/check_sig') return new Response(null, { status: 302, headers: {
        location: 'https://graph.qq.com/oauth2.0/login_jump', 'set-cookie': 'p_skey=graph; Domain=.graph.qq.com; Path=/',
      } });
      if (url.pathname === '/oauth2.0/login_jump') return new Response('ready');
      if (url.pathname === '/oauth2.0/authorize') return new Response(null, { status: 302, headers: {
        location: scenario === 'unsafe' ? 'https://evil.test/steal' : 'https://y.qq.com/cgi-bin/musicu.fcg?code=fixture',
      } });
      if (url.hostname === 'y.qq.com') {
        callbackVisited = true;
        assert.equal(options.redirect, 'manual');
        assert.match(options.headers.Cookie, /uin=9001/);
        assert.doesNotMatch(options.headers.Cookie, /p_skey/);
        const headers = new Headers();
        if (scenario !== 'missing-key') headers.append('set-cookie', 'qm_keyst=music; Domain=.y.qq.com; Path=/; Secure');
        if (scenario === 'wrong-identity') headers.append('set-cookie', 'uin=9002; Domain=.y.qq.com; Path=/; Secure');
        return new Response('callback', { status: scenario === 'http-error' ? 503 : 200, headers });
      }
      if (url.hostname === 'u.y.qq.com') return Response.json({ code: 0, req_0: { code: 0, data: {
        code: 0, map_userinfo: { '9001': { uin: 9001, nick: 'Verified profile' } },
      } } });
      assert.fail(`unexpected request outside authorization chain: ${url.hostname}`);
    });
    const response = await worker.fetch(new Request(`https://music.example.test/api/qq/auth/qrcode/check?key=${key}`), env, { waitUntil() {} });
    assert.equal(response.status, scenario === 'success' ? 200 : 401, scenario);
    assert.equal(callbackVisited, scenario !== 'unsafe');
    if (scenario === 'success') {
      const body = await response.json();
      assert.equal(body.data.user.userId, '9001');
      const user = await getSessionUser(env, new Request('https://music.example.test/', { headers: { 'x-qq-token': body.data.token } }), 'qq');
      assert.equal(qqmusic.extractMusicKey(await decryptCookie(env, user)), 'music');
    } else {
      assert.deepEqual(env.sqlite.prepare('SELECT * FROM users WHERE id = ?').get(original.userId), before);
    }
  }
});

test('the shared limiter caps writes after rejection and resets at the next minute', async t => {
  const env = testEnv(); t.after(() => env.sqlite.close());
  const request = new Request('https://music.example.test/', { headers: { 'cf-connecting-ip': '192.0.2.1' } });
  const before = env.sqlite.prepare('SELECT total_changes() AS count').get().count;
  const results = await Promise.all(Array.from({ length: 50 }, () => rateLimited(env, request, 'auth-test', 12, { now: 60000 })));
  assert.equal(results.filter(limited => !limited).length, 12);
  assert.equal(env.sqlite.prepare('SELECT hits FROM rate_limits').get().hits, 12);
  assert.equal(env.sqlite.prepare('SELECT total_changes() AS count').get().count - before, 12);
  assert.equal(await rateLimited(env, request, 'auth-test', 12, { now: 120000 }), false);
});

test('all parsing and player control routes consume one shared budget before touching upstream', async t => {
  const env = testEnv(); t.after(() => env.sqlite.close());
  const { user, token } = await signedInUser(env, 'netease', '1001');
  await seedPlaylist(env, user, '654321');
  const now = Math.floor(Date.now() / 60000) * 60000 + 1000;
  t.mock.method(Date, 'now', () => now);
  let upstream = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    upstream++;
    return Response.json({ code: 200, data: [{ url: 'https://m1.music.126.net/a.mp3', br: 128000, type: 'mp3' }] });
  });
  const pending = [], ctx = { waitUntil(promise) { pending.push(promise); } };
  const routes = [
    ['/api/playlist/parse?url=654321'], ['/api/playlist/url?id=654321'],
    ['/api/playlist/generate', { method: 'POST', body: JSON.stringify({ url: '654321' }) }],
    ['/api/player/playlist?id=654321'], ['/api/player/resolve/555?id=654321'],
  ];
  const call = ([path, init = {}]) => worker.fetch(new Request(`https://music.example.test${path}`, {
    ...init, headers: { 'x-token': token, 'cf-connecting-ip': '192.0.2.2' },
  }), env, ctx);
  for (let index = 0; index < 30; index++) assert.equal((await call(routes[index % routes.length])).status, 200);
  const callsAtLimit = upstream;
  for (const route of routes) {
    const response = await call(route);
    assert.equal(response.status, 429, route[0]);
    assert.equal(response.headers.get('retry-after'), '59');
  }
  assert.equal(upstream, callsAtLimit);
  assert.equal(env.sqlite.prepare("SELECT hits FROM rate_limits WHERE scope = 'netease:parse'").get().hits, 30);
  await Promise.all(pending);
});

test('shed rejects every new player entry while valid grants can resolve and stream', async t => {
  const env = testEnv(); t.after(() => env.sqlite.close());
  const { user, token } = await signedInUser(env, 'netease', '1001');
  await seedPlaylist(env, user, '456789');
  const grant = await createPlaybackToken(env, user, '456789');
  env.DEGRADE_MODE = 'shed';
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    fetches++;
    return String(input).includes('music.163.com')
      ? Response.json({ code: 200, data: [{ url: 'https://m1.music.126.net/a.mp3', br: 128000, type: 'mp3' }] })
      : new Response('audio', { headers: { 'content-length': '5', 'content-type': 'audio/mpeg' } });
  });
  const pending = [], ctx = { waitUntil(promise) { pending.push(promise); } };
  const call = (path, suffix = '') => worker.fetch(new Request(`https://music.example.test/api/player/${path}?id=456789${suffix}`, {
    headers: { 'x-token': token },
  }), env, ctx);
  for (const path of ['playlist', 'resolve/555', 'media/555', 'cover/555']) {
    const response = await call(path);
    assert.equal(response.status, 503, path);
    assert.ok(Number(response.headers.get('retry-after')) > 0);
  }
  assert.equal(fetches, 0);
  assert.equal((await call('playlist', `&grant=${grant}`)).status, 200);
  assert.equal((await call('resolve/555', `&grant=${grant}`)).status, 200);
  const media = await call('media/555', `&grant=${grant}`);
  assert.equal(media.status, 200);
  assert.equal(await media.text(), 'audio');
  await Promise.all(pending);
});

test('forced refreshes coalesce in flight, have a shared cooldown, and recover after rejection or failure', async t => {
  const env = testEnv(); t.after(() => env.sqlite.close());
  const { user } = await signedInUser(env, 'netease', '1001');
  let now = Math.floor(Date.now() / 10000) * 10000 + 100;
  t.mock.method(Date, 'now', () => now);
  let fetches = 0, release, started;
  const fetched = new Promise(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async () => {
    fetches++; started();
    await new Promise(resolve => { release = resolve; });
    return Response.json({ code: 200, data: [{ url: 'https://m1.music.126.net/a.mp3', br: 128000, type: 'mp3' }] });
  });
  const first = resolvePlayerSource(env, user, '555', 'low', true);
  await fetched;
  const second = resolvePlayerSource(env, user, '555', 'low', true);
  release();
  assert.equal((await first).url, (await second).url);
  assert.equal(fetches, 1);
  await assert.rejects(resolvePlayerSource(env, user, '555', 'low', true), error => error.status === 429 && error.retryAfter === 10);
  assert.equal(fetches, 1);
  // 第二个绑定对象模拟另一个 isolate，同一 D1 仍执行刷新额度。
  const secondEnv = { ...env, DB: { prepare: sql => env.DB.prepare(sql) } };
  await assert.rejects(resolvePlayerSource(secondEnv, user, '555', 'low', true), error => error.status === 429);
  now += 10000;
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('upstream offline'); });
  await assert.rejects(resolvePlayerSource(env, user, '555', 'low', true), /upstream offline/);
  await assert.rejects(resolvePlayerSource(env, user, '555', 'low', true), error => error.status === 429);
  now += 10000;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 200, data: [
    { url: 'https://m1.music.126.net/b.mp3', br: 128000, type: 'mp3' },
  ] }));
  assert.equal((await resolvePlayerSource(env, user, '555', 'low', true)).url, 'https://m1.music.126.net/b.mp3');
});

test('a forced refresh overlapping a normal cache hit still fetches a new source', async t => {
  const env = testEnv(); t.after(() => env.sqlite.close());
  const { user } = await signedInUser(env, 'netease', '1001');
  const cacheKey = await sha256Hex([user.platform, user.id, '555', 'low'].join(':'));
  await env.DB.prepare('INSERT INTO song_sources(cache_key, source_json, expires_at_ms) VALUES (?, ?, ?)')
    .bind(cacheKey, JSON.stringify({ url: 'https://m1.music.126.net/cached.mp3' }), Date.now() + 60000).run();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ code: 200, data: [{ url: 'https://m1.music.126.net/fresh.mp3', br: 128000, type: 'mp3' }] });
  });
  const normal = resolvePlayerSource(env, user, '555', 'low');
  const refreshed = resolvePlayerSource(env, user, '555', 'low', true);
  const duplicate = resolvePlayerSource(env, user, '555', 'low', true);
  assert.equal((await normal).url, 'https://m1.music.126.net/cached.mp3');
  assert.equal((await refreshed).url, 'https://m1.music.126.net/fresh.mp3');
  assert.equal((await duplicate).url, 'https://m1.music.126.net/fresh.mp3');
  assert.equal(calls, 1);
});
