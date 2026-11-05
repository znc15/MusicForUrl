import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { schema, inspectDatabase, migrationPlan, migrateDatabase, wranglerDatabase } from '../scripts/migrate.mjs';
import { planDurationRepair } from '../scripts/repair-legacy-duration.mjs';

// Explicit, isolated Wrangler integration test. Never uses the developer's
// wrangler.jsonc, .wrangler database or a remote binding.
test('Wrangler D1 batch preserves legacy foreign-key children and rolls back failed upgrades', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mfu-d1-migration-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('mfu-d1-migration-'));
    await rm(directory, { recursive: true, force: true });
  });
  const config = path.join(directory, 'wrangler.json');
  await writeFile(config, JSON.stringify({
    name: 'migration-test', compatibility_date: '2026-10-03',
    d1_databases: [{ binding: 'DB', database_name: 'migration-test', database_id: '00000000-0000-0000-0000-000000000004' }],
  }));
  const db = wranglerDatabase({ config, persistTo: path.join(directory, 'state'), database: 'migration-test' });
  const legacy = schema.split('-- v2 totals')[0].replace("'netease', 'qq', 'kugou', 'kuwo'", "'netease', 'qq'")
    .replace(/CREATE TABLE IF NOT EXISTS schema_migrations \([\s\S]*?\);/, '')
    .replace(/(CREATE TABLE IF NOT EXISTS qr_sessions \([\s\S]*?platform TEXT NOT NULL)/, "$1 CHECK (platform IN ('netease', 'qq'))")
    .replace(/  duration_ms INTEGER NOT NULL DEFAULT 0,\r?\n/, '');
  await db.execute(legacy + `
    INSERT INTO users VALUES (7, 'netease', 'n7', 'Account', '', 0, 'cipher', 'token', 9999999999999, 1, 1);
    INSERT INTO playlists VALUES (7, 'p1', 'Playlist', '', 1, '[]', 9999999999999);
    INSERT INTO favorites VALUES (7, 'p1', 'Playlist', '', 'Alias', 1);
    INSERT INTO play_logs VALUES (21, 7, 'p1', 's1', 'Song', 'Artist', 100);
    INSERT INTO play_stats VALUES (7, 'p1', 's1', 'Song', 'Artist', 10, 200);
    INSERT INTO qr_sessions VALUES ('netease', 'qr', 9999999999999);`);
  const before = db.query('SELECT * FROM favorites');
  const plan = migrationPlan(await inspectDatabase(db.query));
  await assert.rejects(db.execute(plan + '\nINSERT INTO missing_table VALUES (1);'));
  assert.deepEqual(db.query('SELECT * FROM favorites'), before);
  assert.equal(db.query("SELECT name FROM sqlite_schema WHERE name = 'schema_migrations'").length, 0);
  await migrateDatabase(db);
  assert.deepEqual(db.query('SELECT * FROM favorites'), before);
  assert.equal(db.query('SELECT * FROM playlists').length, 1);
  assert.equal(db.query('SELECT * FROM play_logs').length, 1);
  assert.equal(db.query('SELECT * FROM play_stats')[0].play_count, 10);
  assert.equal(db.query('PRAGMA foreign_key_check').length, 0);
  db.query("INSERT INTO users VALUES (8, 'kugou', 'k8', '', '', 0, 'cipher2', 'token2', 1, 1, 1)");
  db.query("INSERT INTO users VALUES (9, 'kuwo', 'k9', '', '', 0, 'cipher3', 'token3', 1, 1, 1)");
  assert.equal((await migrateDatabase(db)).changed, false);
  // Exercise the real D1 trigger/atomicity semantics, including guest events
  // with no users FK and permanent totals that survive retention cleanup.
  const startedAt = db.query('SELECT started_at_ms FROM playback_totals')[0].started_at_ms;
  const event = `INSERT INTO playback_events (actor_key, user_id, platform, playlist_id, song_id, duration_ms, surface, played_at_ms)
    VALUES ('guest:fixture', NULL, 'kuwo', '1', '2', 90000, 'hls', 1000);`;
  await db.execute(event);
  assert.equal(db.query('SELECT plays FROM playback_totals')[0].plays, 1);
  assert.equal(db.query('SELECT duration_ms FROM playback_totals')[0].duration_ms, 90000);
  await assert.rejects(db.execute(event + '\nINSERT INTO missing_table VALUES (1);'));
  assert.equal(db.query('SELECT plays FROM playback_totals')[0].plays, 1);
  assert.equal(db.query('SELECT COUNT(*) AS n FROM playback_events')[0].n, 1);
  await db.execute('DELETE FROM playback_events;');
  assert.equal(db.query('SELECT plays FROM playback_totals')[0].plays, 1);
  assert.equal(db.query('SELECT started_at_ms FROM playback_totals')[0].started_at_ms, startedAt);
  assert.equal((await migrateDatabase(db)).changed, false);
  assert.equal(db.query('SELECT plays FROM playback_totals')[0].plays, 1);
});

test('Wrangler D1 legacy duration repair rolls back failures and preserves counters on repetition', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mfu-duration-repair-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('mfu-duration-repair-'));
    await rm(directory, { recursive: true, force: true });
  });
  const config = path.join(directory, 'wrangler.json');
  await writeFile(config, JSON.stringify({ name: 'duration-repair-test', compatibility_date: '2026-10-03',
    d1_databases: [{ binding: 'DB', database_name: 'duration-repair-test', database_id: '00000000-0000-0000-0000-000000000041' }],
  }));
  const db = wranglerDatabase({ config, persistTo: path.join(directory, 'state'), database: 'duration-repair-test' });
  await db.execute(schema + `UPDATE playback_totals SET started_at_ms=1000;
    INSERT INTO playback_events (id,actor_key,user_id,platform,playlist_id,song_id,duration_ms,surface,played_at_ms)
    VALUES (1,'fixture',7,'netease','123','456',0,'player',2000), (2,'new',NULL,'kuwo','999','999',60000,'hls',3000);`);
  const tracks = JSON.stringify([{ id: '456', duration: 285 }]);
  const snapshot = { user_id: 7, playlist_id: '123', expires_at_ms: 9000, songs_json: tracks };
  const sql = planDurationRepair({ startedAt: 1000, backupBeforeMs: 900,
    events: [{ id: 1, user_id: 7, platform: 'netease', playlist_id: '123', song_id: '456', duration_ms: 0, played_at_ms: 2000 }],
    current: [{ ...snapshot, cache_shape: 'array', tracks_json: tracks }],
  }, [snapshot]).sql;
  const totals = () => db.query('SELECT plays,duration_ms,known_duration_plays,player_plays,hls_plays FROM playback_totals')[0];
  await assert.rejects(db.execute(sql + '\nINSERT INTO missing_table VALUES (1);'));
  assert.deepEqual(totals(), { plays: 2, duration_ms: 60000, known_duration_plays: 1, player_plays: 1, hls_plays: 1 });
  await db.execute(sql);
  const restored = totals();
  assert.deepEqual(restored, { plays: 2, duration_ms: 345000, known_duration_plays: 2, player_plays: 1, hls_plays: 1 });
  await db.execute(sql);
  assert.deepEqual(totals(), restored);
  assert.equal(db.query('SELECT duration_ms FROM playback_events WHERE id=1')[0].duration_ms, 285000);
  assert.equal(db.query("SELECT name FROM sqlite_schema WHERE name='__mfu_repair_legacy_duration'").length, 0);
});
