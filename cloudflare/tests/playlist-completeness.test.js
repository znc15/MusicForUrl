import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { adapter, buildLitePlaylist, getPlaylist } from '../src/playlists.js';
import { createSession } from '../src/security.js';
import policy from '../../lib/player-policy.js';

const json = value => Response.json(value);
const hash = index => index.toString(16).toUpperCase().padStart(32, '0');
const kugouItems = count => Array.from({ length: count }, (_, i) => ({
  hash: hash(i + 1), filename: `Artist - Track ${i + 1}`, duration: i ? 200 : 0,
}));

function kugouFixture(t, total = 35) {
  const state = { failPage: 2, calls: 0 };
  const items = kugouItems(total);
  t.mock.method(globalThis, 'fetch', async input => {
    state.calls++;
    const url = new URL(input);
    if (url.pathname.startsWith('/plist/list/')) return json({
      list: { list: { total, info: items.slice(0, 10) } },
      info: { list: { specialname: 'Fixture playlist' } },
    });
    assert.equal(url.pathname, '/api/v3/special/song');
    const page = Number(url.searchParams.get('page'));
    if (page === state.failPage) throw new Error('fixture page failed');
    return json({ data: { info: items.slice((page - 1) * 30, page * 30) } });
  });
  return state;
}

function memoryCache(t) {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const entries = new Map();
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
    async match(key) { return entries.get(String(key))?.clone(); },
    async put(key, value) { entries.set(String(key), value.clone()); },
  } } });
  t.after(() => {
    if (old) Object.defineProperty(globalThis, 'caches', old);
    else delete globalThis.caches;
  });
  return entries;
}

function testEnv(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  return {
    sqlite, ENCRYPTION_KEY: 'fixture-secret-1029384756-abcdef-9182736455',
    DB: { prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return sqlite.prepare(sql).get(...args) || null; },
        async run() { return sqlite.prepare(sql).run(...args); },
      };
    } },
  };
}

async function account(env, platform = 'kugou') {
  const { userId } = await createSession(env, platform, { userId: 'fixture-account' }, 'fixture-cookie');
  return env.sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function assertCounts(playlist, total, included, reason) {
  assert.equal(playlist.songCount, total);
  assert.equal(playlist.totalCount, total);
  assert.equal(playlist.includedCount, included);
  assert.equal(playlist.tracks.length, included);
  assert.equal(playlist.partialReason, reason);
}

test('Kugou keeps successful pages after a later failure and M3U8 matches includedCount', async t => {
  kugouFixture(t);
  const playlist = await getPlaylist({}, { platform: 'kugou', guest: true }, '123');
  assertCounts(playlist, 35, 30, 'upstream_page_failed');
  assert.equal(playlist.tracks[29].id, hash(30));
  assert.equal(playlist.tracks[0].duration, 0);
  assert.equal(playlist.tracks[0].durationKnown, false);
  assert.equal(playlist.tracks[1].durationKnown, true);
  const text = buildLitePlaylist(new Request('https://fixture.test/'), 'kugou', 'fixture', '123', playlist.tracks);
  assert.equal((text.match(/#EXTINF:/g) || []).length, playlist.includedCount);
  assert.match(text, /#EXTINF:180\.000/);
});

test('Kugou uses metadata fallback only when no page succeeds', async t => {
  const state = kugouFixture(t);
  state.failPage = 1;
  const playlist = await adapter('kugou').getPlaylistDetail('123', '', {});
  assertCounts(playlist, 35, 10, 'upstream_page_failed');
});

test('Kugou reports a malformed later page while retaining the successful page', async t => {
  const items = kugouItems(35);
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    if (url.pathname.startsWith('/plist/list/')) return json({
      list: { list: { total: 35, info: items.slice(0, 10) } }, info: { list: {} },
    });
    return url.searchParams.get('page') === '1'
      ? json({ data: { info: items.slice(0, 30) } }) : json({ status: 0, error: 'fixture failure' });
  });
  assertCounts(await adapter('kugou').getPlaylistDetail('123', '', {}), 35, 30, 'upstream_page_failed');
});

test('platform limits are explicit for Kugou, Netease and Kuwo', async t => {
  await t.test('Kugou page cap', async t => {
    const state = kugouFixture(t); state.failPage = 0;
    assertCounts(await adapter('kugou').getPlaylistDetail('123', '', { GUEST_PLAYLIST_MAX_PAGES: 1 }),
      35, 30, 'platform_limit');
  });
  await t.test('Netease track cap', async t => {
    t.mock.method(globalThis, 'fetch', async () => json({ code: 200, playlist: {
      id: '123', trackCount: 3, tracks: [{ id: 1, dt: 200000 }, { id: 2 }],
    } }));
    assertCounts(await adapter('netease').getPlaylistDetail('123', '', { PLAYLIST_TRACK_CAP: 2 }),
      3, 2, 'platform_limit');
  });
  await t.test('Kuwo first-page cap', async t => {
    t.mock.method(globalThis, 'fetch', async input => {
      assert.equal(new URL(input).searchParams.get('rn'), '1000');
      return json({ data: { total: 1001, musicList: Array.from({ length: 1000 }, (_, i) => ({ rid: i + 1 })) } });
    });
    assertCounts(await adapter('kuwo').getPlaylistDetail('123', '', { KUWO_COOKIE: 'kw_token=fixture' }),
      1001, 1000, 'platform_limit');
  });
});

test('guest partial cache lasts 60 seconds and explicit retry recovers without bypassing complete cache', async t => {
  const entries = memoryCache(t);
  const state = kugouFixture(t);
  const user = { platform: 'kugou', guest: true };
  assertCounts(await getPlaylist({}, user, '123'), 35, 30, 'upstream_page_failed');
  assert.equal([...entries.values()][0].headers.get('cache-control'), 'max-age=60');
  const before = state.calls;
  assertCounts(await getPlaylist({}, user, '123'), 35, 30, 'upstream_page_failed');
  assert.equal(state.calls, before);
  state.failPage = 0;
  assertCounts(await getPlaylist({}, user, '123', null, { refreshPartial: true }), 35, 35, null);
  assert.equal([...entries.values()][0].headers.get('cache-control'), 'max-age=86400');
  const after = state.calls;
  await getPlaylist({}, user, '123', null, { refreshPartial: true });
  assert.equal(state.calls, after);
});

test('D1 partial cache preserves metadata, expires quickly and retries to a complete result', async t => {
  const env = testEnv(t), user = await account(env);
  const state = kugouFixture(t);
  const before = Date.now();
  assertCounts(await getPlaylist(env, user, '123'), 35, 30, 'upstream_page_failed');
  const row = env.sqlite.prepare('SELECT * FROM playlists').get();
  assert.ok(row.expires_at_ms >= before + 60000 && row.expires_at_ms <= Date.now() + 60000);
  assert.equal(JSON.parse(row.songs_json).cacheVersion, 2);
  const calls = state.calls;
  const cached = await getPlaylist(env, user, '123');
  assertCounts(cached, 35, 30, 'upstream_page_failed');
  assert.equal(cached.tracks[1].durationKnown, true);
  assert.equal(state.calls, calls);
  state.failPage = 0;
  assertCounts(await getPlaylist(env, user, '123', null, { refreshPartial: true }), 35, 35, null);
  assert.ok(env.sqlite.prepare('SELECT expires_at_ms FROM playlists').get().expires_at_ms >= before + 86400000);
});

test('old long-lived partial caches refresh while ambiguous legacy 180 seconds remain unknown', async t => {
  const env = testEnv(t), user = await account(env);
  const state = kugouFixture(t); state.failPage = 0;
  const legacyTracks = [{ id: hash(1), name: 'Legacy', duration: 180 }];
  env.sqlite.prepare('INSERT INTO playlists (user_id, playlist_id, song_count, songs_json, expires_at_ms) VALUES (?, ?, ?, ?, ?)')
    .run(user.id, '123', 35, JSON.stringify(legacyTracks), Date.now() + 86400000);
  assertCounts(await getPlaylist(env, user, '123'), 35, 35, null);
  env.sqlite.prepare('INSERT INTO playlists (user_id, playlist_id, song_count, songs_json, expires_at_ms) VALUES (?, ?, ?, ?, ?)')
    .run(user.id, '456', 1, JSON.stringify(legacyTracks), Date.now() + 86400000);
  const complete = await getPlaylist(env, user, '456');
  assert.equal(complete.tracks[0].duration, 180);
  assert.equal(complete.tracks[0].durationKnown, false);

  const entries = memoryCache(t);
  entries.set('https://playlist.mfu.internal/kugou/123', json({ songCount: 35, tracks: legacyTracks }));
  assertCounts(await getPlaylist(env, { platform: 'kugou', guest: true }, '123'), 35, 35, null);
  entries.set('https://playlist.mfu.internal/kugou/456', json({ songCount: 1, tracks: legacyTracks }));
  assert.equal((await getPlaylist(env, { platform: 'kugou', guest: true }, '456')).tracks[0].durationKnown, false);
});

test('legacy arrays preserve real seconds across four platforms while only ambiguous or invalid values remain unknown', async t => {
  const entries = memoryCache(t);
  for (const platform of ['netease', 'qq', 'kugou', 'kuwo']) {
    const env = testEnv(t), user = await account(env, platform);
    const tracks = [285, 180, 0, 446, 180].map((duration, i) => ({
      id: platform === 'kugou' ? hash(i + 1) : String(i + 1), duration,
      ...(i === 3 ? { durationKnown: false } : i === 4 ? { durationKnown: true } : {}),
    }));
    env.sqlite.prepare('INSERT INTO playlists (user_id,playlist_id,song_count,songs_json,expires_at_ms) VALUES (?,?,?,?,?)')
      .run(user.id, '789', tracks.length, JSON.stringify(tracks), Date.now() + 60000);
    const playlist = await getPlaylist(env, user, '789');
    assert.deepEqual(playlist.tracks.map(track => track.durationKnown), [true, false, false, false, true], platform);
    assert.equal(policy.normalizedPlaylist(playlist, platform).tracks[0].duration, 285);
    assert.equal(policy.normalizedPlaylist(playlist, platform).tracks[0].durationKnown, true);
    if (platform === 'kugou' || platform === 'kuwo') {
      entries.set(`https://playlist.mfu.internal/${platform}/789`, json({ songCount: tracks.length, tracks }));
      assert.deepEqual((await getPlaylist(env, { platform, guest: true }, '789')).tracks.map(track => track.durationKnown),
        [true, false, false, false, true]);
    }
  }
});

test('fresh adapter durations use seconds through v2 caches including genuine 180-second songs', async t => {
  const durationValues = [285, 180, 0];
  for (const platform of ['netease', 'qq', 'kugou', 'kuwo']) await t.test(platform, async t => {
    const env = testEnv(t), user = await account(env, platform);
    env.KUWO_COOKIE = 'kw_token=fixture';
    t.mock.method(globalThis, 'fetch', async input => {
      if (platform === 'netease') return json({ code: 200, playlist: { id: '123', trackCount: 3,
        tracks: durationValues.map((n, i) => ({ id: i + 1, dt: n * 1000 })) } });
      if (platform === 'qq') return json({ code: 0, cdlist: [{ songnum: 3,
        songlist: [{ songmid: '1', interval: '4:45' }, { songmid: '2', interval: 180 }, { songmid: '3', interval: 0 }] }] });
      if (platform === 'kuwo') return json({ data: { total: 3,
        musicList: durationValues.map((n, i) => ({ rid: i + 1, duration: n })) } });
      const info = durationValues.map((n, i) => ({ hash: hash(i + 1), duration: n }));
      return new URL(input).hostname === 'm.kugou.com'
        ? json({ list: { list: { total: 3, info } }, info: { list: {} } }) : json({ data: { total: 3, info } });
    });
    for (let i = 0; i < 2; i++) {
      const playlist = await getPlaylist(env, user, '123');
      assert.deepEqual(playlist.tracks.map(track => track.duration), durationValues);
      assert.deepEqual(playlist.tracks.map(track => track.durationKnown), [true, true, false]);
    }
  });
});

test('QQ normalization reports missing and invalid tracks rather than claiming a complete export', async t => {
  const env = testEnv(t), user = await account(env, 'qq');
  t.mock.method(adapter('qq'), 'getPlaylistDetail', async () => ({
    name: 'QQ fixture', songCount: 3, tracks: [{ id: 'validMID', duration: 201 }, { id: 'invalid:id', duration: 0 }],
  }));
  const playlist = await getPlaylist(env, user, '123');
  assertCounts(playlist, 3, 1, 'missing_tracks');
  assert.equal(playlist.tracks[0].durationKnown, true);
});
