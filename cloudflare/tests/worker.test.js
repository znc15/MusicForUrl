import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import {
  createPlaybackToken, createSession, decryptCookie, getPlaybackUser, getSessionUser,
  logout, requireSecret,
} from '../src/security.js';

function testEnv() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const DB = {
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
        async run() {
          const result = sqlite.prepare(sql).run(...args);
          return { meta: { changes: result.changes } };
        },
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
