import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import CryptoJS from 'crypto-js';
import worker from '../src/index.js';
import {
  PLAY_LOG_DEDUP_MS, PLAY_LOG_MAX_PER_MINUTE, PLAY_LOG_MAX_PER_USER,
  PLAY_LOG_RETENTION_MS, recordPlayback,
} from '../src/playback-history.js';
import {
  createPlaybackToken, createSession, decryptCookie, getPlaybackUser, getSessionUser,
  logout, requireSecret, sha256Hex,
} from '../src/security.js';

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
        range: match ? { offset, length } : undefined, httpEtag: '"fixture"',
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
    const key = await sha256Hex([user.platform, user.id, user.token_hash, '555', 'high'].join(':'));
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

test('placeholder deployment keys are rejected', () => {
  assert.throws(() => requireSecret({ ENCRYPTION_KEY: 'your-32-character-secret-key-here' }));
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
    assert.deepEqual(Object.keys(body.data.user).sort(), ['avatar', 'nickname', 'userId', 'vipType']);
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
  const ctx = { waitUntil() {} };

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
    INSERT INTO play_logs (user_id, playlist_id, song_id, song_name, artist, played_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
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
  await Promise.all(Array.from({ length: 20 }, () => recordPlayback(env, user.id, '123', song, now)));
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS count FROM play_logs').get().count, 1);
  await recordPlayback(env, user.id, '456', song, now);
  await recordPlayback(env, other.id, '123', song, now);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS count FROM play_logs').get().count, 3);
  await recordPlayback(env, user.id, '123', song, now + PLAY_LOG_DEDUP_MS);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS count FROM play_logs').get().count, 3);
  await recordPlayback(env, user.id, '123', song, now + PLAY_LOG_DEDUP_MS + 1);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS count FROM play_logs').get().count, 4);
});

test('logging limits each account to 12 new events in a rolling minute', async t => {
  const env = testEnv();
  t.after(() => env.sqlite.close());
  const { user } = await signedInUser(env, 'netease', '1001');
  const now = Date.now();
  for (let index = 0; index < PLAY_LOG_MAX_PER_MINUTE + 3; index++) {
    await recordPlayback(env, user.id, '123', { id: String(index), name: 'Track', artist: '' }, now);
  }
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS count FROM play_logs').get().count, 12);
  await recordPlayback(env, user.id, '123', { id: '999', name: 'Track', artist: '' }, now + 60001);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS count FROM play_logs').get().count, 13);
});

test('playback history retains at most 1000 records per account and cron removes expired records', async t => {
  const env = testEnv();
  t.after(() => env.sqlite.close());
  const { user } = await signedInUser(env, 'netease', '1001');
  const other = (await signedInUser(env, 'qq', '2002')).user;
  const now = Date.now();
  const insert = env.sqlite.prepare(
    'INSERT INTO play_logs (user_id, playlist_id, song_id, played_at_ms) VALUES (?, ?, ?, ?)',
  );
  for (let index = 0; index < PLAY_LOG_MAX_PER_USER + 8; index++) {
    insert.run(user.id, '123', String(index), now - (index + 2) * 60000);
  }
  insert.run(user.id, '123', 'expired', now - PLAY_LOG_RETENTION_MS - 10000);
  insert.run(other.id, '456', 'expired', now - PLAY_LOG_RETENTION_MS - 10000);
  insert.run(other.id, '456', 'recent', now);
  await recordPlayback(env, user.id, '123', { id: '99999', name: 'New', artist: '' }, now);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS count FROM play_logs WHERE user_id = ?').get(user.id).count, 1000);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS count FROM play_logs WHERE user_id = ? AND song_id = 'expired'").get(user.id).count, 0);
  assert.ok(env.sqlite.prepare("SELECT 1 FROM play_logs WHERE song_id = '99999'").get());
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS count FROM play_logs WHERE user_id = ?').get(other.id).count, 2);
  const tasks = [];
  worker.scheduled({}, env, { waitUntil(task) { tasks.push(task); } });
  await Promise.all(tasks);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS count FROM play_logs WHERE user_id = ?').get(other.id).count, 1);
});

test('recent and top history exclude expired events before the daily cleanup runs', async t => {
  const env = testEnv();
  t.after(() => env.sqlite.close());
  const { user, token } = await signedInUser(env, 'netease', '1001');
  const insert = env.sqlite.prepare(
    'INSERT INTO play_logs (user_id, playlist_id, song_id, played_at_ms) VALUES (?, ?, ?, ?)',
  );
  insert.run(user.id, '123', '555', Date.now());
  insert.run(user.id, '456', '666', Date.now() - PLAY_LOG_RETENTION_MS - 10000);
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
      assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS count FROM play_logs WHERE user_id = ?').get(user.id).count, 1);
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
