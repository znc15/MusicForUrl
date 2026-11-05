import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { recordPlayback, prunePlaybackLogs, readPlaybackRanking, readGlobalPlaybackRanking, PLAY_LOG_RETENTION_MS } from '../src/playback-history.js';
import { readSiteStats, refreshSiteStats } from '../src/stats.js';
import { guestUser } from '../src/platforms.js';

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const DB = {
    prepare(sql) {
      let args = [];
      return { bind(...values) { args = values; return this; },
        async first() { return sqlite.prepare(sql).get(...args) || null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        runSync() { return { meta: { changes: sqlite.prepare(sql).run(...args).changes } }; },
        async run() { return this.runSync(); } };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const rows = statements.map(s => s.runSync()); sqlite.exec('COMMIT'); return rows; }
      catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  };
  return { DB, sqlite, ENCRYPTION_KEY: 'isolated-stats-test-secret-0123456789' };
}
function user(env, id, platform = 'netease') {
  env.sqlite.prepare(`INSERT INTO users (id, platform, platform_user_id, cookie_cipher, token_hash, token_expires_at_ms, created_at_ms, last_login_at_ms)
    VALUES (?, ?, ?, '', ?, 9999999999999, 1, 1)`).run(id, platform, String(id), `test-${id}`);
  return { id, platform };
}
const song = { id: '123', name: 'Track', artist: 'Artist', duration: 90, durationKnown: true };
const request = ip => new Request('https://example.test/api/kuwo/song/signed/123', { headers: { 'cf-connecting-ip': ip, 'user-agent': 'Test' } });

test('persistent totals include account and guest sources, preserve unknown durations and survive cleanup', async t => {
  const env = fixture(t), first = user(env, 1), second = user(env, 2, 'qq');
  const now = Date.now();
  await recordPlayback(env, first, 'p1', song, now, { surface: 'player' });
  await recordPlayback(env, first, 'p2', song, now, { surface: 'hls' });
  await recordPlayback(env, second, 'p1', { ...song, durationKnown: false }, now, { surface: 'redirect' });
  await recordPlayback(env, guestUser('kuwo'), 'p1', { ...song, duration: 0 }, now, { request: request('192.0.2.1'), surface: 'hls' });
  let stats = await readSiteStats(env);
  assert.equal(stats.version, 2);
  assert.equal(stats.plays, 4);
  assert.equal(stats.playDurationMs, 180000);
  assert.equal(stats.knownDurationPlays, 2);
  assert.equal(stats.unknownDurationPlays, 2);
  assert.equal(stats.listeners, 2);
  assert.deepEqual(stats.playSources, { player: 1, hls: 2, redirect: 1 });
  assert.equal(stats.songs, 3); // Same song ID across different platforms stays distinct.
  await prunePlaybackLogs(env, now + PLAY_LOG_RETENTION_MS + 1);
  stats = await readSiteStats(env);
  assert.equal(stats.plays, 4);
  assert.equal(stats.playDurationMs, 180000);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM playback_events').get().n, 0);
});

test('guest dedup is independent of users and independent between addresses, with a shared per-minute limit', async t => {
  const env = fixture(t), guest = guestUser('kuwo'), now = Date.now();
  const opts = { request: request('192.0.2.1') };
  const results = await Promise.all(Array.from({ length: 20 }, () => recordPlayback(env, guest, 'p', song, now, opts)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.ok(await recordPlayback(env, guest, 'p', song, now, { request: request('192.0.2.2') }));
  for (let n = 0; n < 15; n++) await recordPlayback(env, guest, 'p', { ...song, id: `s${n}` }, now, opts);
  assert.equal(env.sqlite.prepare('SELECT plays FROM playback_totals').get().plays, 13);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM play_stats').get().n, 0);
  for (const row of env.sqlite.prepare('SELECT actor_key, user_id FROM playback_events').all()) {
    assert.equal(row.user_id, null);
    assert.doesNotMatch(row.actor_key, /192\.0\.2/);
  }
});

test('30-day ranking counts only events inside its window, without carrying forward older replays', async t => {
  const env = fixture(t), account = user(env, 1), now = Date.now();
  await recordPlayback(env, account, 'p', song, now - PLAY_LOG_RETENTION_MS - 1);
  await recordPlayback(env, account, 'p', song, now);
  await recordPlayback(env, account, 'other', song, now);
  await recordPlayback(env, guestUser('kuwo'), 'p', song, now, { request: request('192.0.2.1') });
  const personal = await readPlaybackRanking(env, { userId: account.id, now });
  assert.equal(personal.data.length, 1);
  assert.equal(personal.data[0].playCount, 2);
  assert.equal(personal.windowDays, 30);
  const global = await readPlaybackRanking(env, { now });
  assert.equal(global.data.length, 2);
  assert.equal(global.data.reduce((n, row) => n + row.playCount, 0), 3);
  assert.equal(env.sqlite.prepare('SELECT plays FROM playback_totals').get().plays, 4);
});

test('legacy history is retained but not imported as precise lifetime or recent-event totals', async t => {
  const env = fixture(t), account = user(env, 1);
  env.sqlite.prepare(`INSERT INTO play_stats VALUES (?, 'p', '123', 'Old', '', 180000, 800, ?)`)
    .run(account.id, Date.now());
  assert.equal((await readSiteStats(env)).plays, 0);
  assert.deepEqual((await readPlaybackRanking(env)).data, []);
  await recordPlayback(env, account, 'p', song);
  assert.equal(env.sqlite.prepare('SELECT play_count FROM play_stats').get().play_count, 801);
  assert.equal((await readSiteStats(env)).plays, 1);
});

test('a fresh parsed counter cannot hide missing snapshots; real zero remains distinct from missing counters', async t => {
  const env = fixture(t);
  env.sqlite.prepare("INSERT INTO site_stats VALUES ('parsedSongs', 42, ?)").run(Date.now());
  const stats = await readSiteStats(env);
  assert.equal(stats.listeners, 0);
  assert.equal(stats.plays, 0);
  assert.equal(stats.generatedLinks, null);
  assert.deepEqual(stats.unknown, ['generatedLinks']);
  assert.equal(stats.stale, false);
  assert.ok(stats.startedAt > 0 && stats.updatedAt > 0);
});

test('initial refresh failure reports 503; an incomplete old snapshot stays stale with explicit unknowns', async t => {
  const env = fixture(t), prepare = env.DB.prepare;
  env.DB.prepare = sql => {
    const stmt = prepare(sql);
    if (sql.includes('COUNT(*) AS songs')) stmt.first = async () => { throw new Error('fixture unavailable'); };
    return stmt;
  };
  env.sqlite.prepare("INSERT INTO site_stats VALUES ('parsedSongs', 42, ?)").run(Date.now());
  await assert.rejects(readSiteStats(env), e => e.status === 503);
  env.sqlite.exec("INSERT INTO site_stats VALUES ('v2:listeners', 7, 1)");
  const stale = await readSiteStats(env);
  assert.equal(stale.listeners, 7);
  assert.equal(stale.songs, null);
  assert.ok(stale.unknown.includes('songs'));
  assert.equal(stale.stale, true);
  env.DB.prepare = prepare;
  assert.equal((await readSiteStats(env)).listeners, 0);
});

test('snapshot freshness is the oldest required metric, not the newest unrelated counter', async t => {
  const env = fixture(t);
  await refreshSiteStats(env);
  env.sqlite.exec("UPDATE site_stats SET value=99, updated_at_ms=1 WHERE key='v2:listeners'");
  assert.equal((await readSiteStats(env)).listeners, 0);
});

test('fresh pre-upgrade catalog snapshots are not published as v2 event counts', async t => {
  const env = fixture(t);
  for (const [key, value] of [['songs', 99], ['playlists', 9], ['listeners', 0], ['plays', 800]]) {
    env.sqlite.prepare('INSERT INTO site_stats VALUES (?, ?, ?)').run(key, value, Date.now());
  }
  const stats = await readSiteStats(env);
  assert.equal(stats.songs, 0);
  assert.equal(stats.playlists, 0);
  assert.equal(stats.plays, 0);
  assert.equal(stats.stale, false);
  assert.equal(env.sqlite.prepare("SELECT value FROM site_stats WHERE key='plays'").get().value, 800);
  assert.equal(env.sqlite.prepare("SELECT value FROM site_stats WHERE key='v2:songs'").get().value, 0);
});

test('a failed totals trigger rolls back the event and personal aggregate atomically', async t => {
  const env = fixture(t), account = user(env, 1);
  env.sqlite.exec("CREATE TRIGGER stop_totals BEFORE UPDATE ON playback_totals BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
  await assert.rejects(recordPlayback(env, account, 'p', song), /fixture/);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM playback_events').get().n, 0);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM play_stats').get().n, 0);
  assert.equal(env.sqlite.prepare('SELECT plays FROM playback_totals').get().plays, 0);
  env.sqlite.exec('DROP TRIGGER stop_totals');
  assert.ok(await recordPlayback(env, account, 'p', song));
  assert.equal(env.sqlite.prepare('SELECT plays FROM playback_totals').get().plays, 1);
});

test('public ranking coalesces reads, caches five minutes, returns bounded stale data and then 503', async t => {
  const env = fixture(t), account = user(env, 1), now = Date.now();
  await recordPlayback(env, account, 'p', song, now);
  const original = Date.now;
  t.mock.method(Date, 'now', () => now);
  const prepare = env.DB.prepare;
  let reads = 0, fail = false;
  env.DB.prepare = sql => {
    const statement = prepare(sql);
    if (sql.includes('GROUP BY platform, song_id ORDER BY')) {
      const all = statement.all;
      statement.all = async () => { reads++; if (fail) throw new Error('offline'); return all(); };
    }
    return statement;
  };
  const initial = await Promise.all(Array.from({ length: 10 }, () => readGlobalPlaybackRanking(env, null, 10)));
  assert.equal(reads, 1);
  assert.equal(initial[0].data[0].playCount, 1);
  assert.equal((await readGlobalPlaybackRanking(env, null, 10)).stale, false);
  assert.equal((await readGlobalPlaybackRanking(env, null, 20)).stale, false);
  assert.equal(reads, 1);
  fail = true;
  t.mock.method(Date, 'now', () => now + 300001);
  assert.equal((await readGlobalPlaybackRanking(env, null, 10)).stale, true);
  assert.equal(reads, 2);
  t.mock.method(Date, 'now', () => now + 3600001);
  await assert.rejects(readGlobalPlaybackRanking(env, null, 10), e => e.status === 503);
  await assert.rejects(readGlobalPlaybackRanking(env, null, 20), e => e.status === 503);
  Date.now = original;
});
