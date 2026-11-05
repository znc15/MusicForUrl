import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { schema, VERSION, inspectDatabase, migrationPlan, migrateDatabase } from '../scripts/migrate.mjs';

function fixture(t, source = '') {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('PRAGMA foreign_keys = ON;');
  if (source) sqlite.exec(source);
  return {
    sqlite,
    query: sql => sqlite.prepare(sql).all(),
    execute(sql) {
      sqlite.exec('BEGIN;');
      try { sqlite.exec(sql); sqlite.exec('COMMIT;'); }
      catch (error) { sqlite.exec('ROLLBACK;'); throw error; }
    },
  };
}

const legacySchema = schema.replace("'netease', 'qq', 'kugou', 'kuwo'", "'netease', 'qq'")
  .replace(/CREATE TABLE IF NOT EXISTS schema_migrations \([\s\S]*?\);/, '')
  .replace(/(CREATE TABLE IF NOT EXISTS qr_sessions \([\s\S]*?platform TEXT NOT NULL)/, "$1 CHECK (platform IN ('netease', 'qq'))")
  .replace(/  duration_ms INTEGER NOT NULL DEFAULT 0,\r?\n/, '');

function seed(db) {
  db.sqlite.exec(`INSERT INTO users VALUES (7, 'netease', 'n7', 'Account', 'avatar', 1, 'cipher', 'token', 9999999999999, 11, 12);
    INSERT INTO users VALUES (100, 'qq', 'q100', '', '', 0, 'cipher2', 'token2', 9999999999999, 11, 12);
    DELETE FROM users WHERE id = 100;
    INSERT INTO playlists VALUES (7, 'p1', 'Playlist', 'cover', 2, '[{"id":"s1"}]', 9999999999999);
    INSERT INTO favorites VALUES (7, 'p1', 'Playlist', 'cover', 'Alias', 13);
    INSERT INTO play_logs VALUES (21, 7, 'p1', 's1', 'Song', 'Artist', 100);
    INSERT INTO play_logs VALUES (22, 7, 'p1', 's1', 'Song', 'Artist', 200);
    INSERT INTO play_logs VALUES (23, 7, 'p1', 's2', 'Second', 'Artist', 300);
    INSERT INTO play_logs VALUES (200, 7, 'p1', 'deleted', '', '', 1);
    DELETE FROM play_logs WHERE id = 200;
    INSERT INTO qr_sessions VALUES ('netease', 'qr', 9999999999999);`);
}

const rows = (db, table) => db.query(`SELECT * FROM ${table}`).map(row => ({ ...row }));

test('fresh database migrates once and accepts all four account platforms', async t => {
  const db = fixture(t);
  assert.deepEqual(await migrateDatabase(db), { changed: true, version: VERSION });
  for (const platform of ['netease', 'qq', 'kugou', 'kuwo']) {
    db.sqlite.prepare('INSERT INTO users (platform, platform_user_id, cookie_cipher, token_hash, token_expires_at_ms, created_at_ms, last_login_at_ms) VALUES (?, ?, ?, ?, 1, 1, 1)')
      .run(platform, platform, 'cipher', platform);
  }
  assert.deepEqual(await migrateDatabase(db), { changed: false, version: VERSION });
  assert.equal(rows(db, 'users').length, 4);
});

test('legacy users rebuild preserves primary keys, child data, sequences, indexes and QR sessions', async t => {
  const db = fixture(t, legacySchema);
  seed(db);
  db.sqlite.exec("INSERT INTO play_stats VALUES (7, 'p1', 's1', 'New name', 'New artist', 9, 900);");
  const preserved = Object.fromEntries(['users', 'playlists', 'favorites', 'play_logs', 'qr_sessions'].map(name => [name, rows(db, name)]));
  await migrateDatabase(db);
  for (const [name, expected] of Object.entries(preserved)) assert.deepEqual(rows(db, name), expected, name);
  const stats = rows(db, 'play_stats');
  assert.equal(stats.find(row => row.song_id === 's1').play_count, 9);
  assert.equal(stats.find(row => row.song_id === 's1').last_played_at_ms, 900);
  assert.equal(stats.find(row => row.song_id === 's1').duration_ms, 0);
  assert.equal(stats.find(row => row.song_id === 's2').play_count, 1);
  assert.equal(db.query("SELECT seq FROM sqlite_sequence WHERE name='users'")[0].seq, 100);
  assert.equal(db.query("SELECT seq FROM sqlite_sequence WHERE name='play_logs'")[0].seq, 200);
  db.sqlite.exec("INSERT INTO users VALUES (101, 'kugou', 'k101', '', '', 0, 'c3', 't3', 1, 1, 1);");
  db.sqlite.exec("INSERT INTO users VALUES (102, 'kuwo', 'k102', '', '', 0, 'c4', 't4', 1, 1, 1);");
  db.sqlite.exec("INSERT INTO qr_sessions VALUES ('kugou', 'qr2', 1);");
  assert.equal(db.query('PRAGMA foreign_key_check').length, 0);
  assert.ok(db.query("SELECT name FROM sqlite_schema WHERE type='index' AND name='users_token_hash_idx'").length);
  assert.equal(db.query("SELECT name FROM sqlite_schema WHERE name LIKE '__mfu_%'").length, 0);
  assert.deepEqual(await migrateDatabase(db), { changed: false, version: VERSION });
  assert.deepEqual(rows(db, 'play_stats'), stats);
});

test('pre-0001 database imports legacy logs without dropping their original rows', async t => {
  const db = fixture(t, legacySchema);
  seed(db);
  db.sqlite.exec('DROP TABLE play_stats; DROP TABLE site_stats;');
  await migrateDatabase(db);
  assert.equal(rows(db, 'play_logs').length, 3);
  assert.equal(rows(db, 'play_stats').find(row => row.song_id === 's1').play_count, 2);
});

test('databases with manually applied 0001-0003 retain current aggregates and known durations', async t => {
  const db = fixture(t, legacySchema);
  seed(db);
  for (const name of ['0001-backfill-play-stats.sql', '0002-site-stats.sql', '0003-qr-sessions-kugou.sql']) {
    db.sqlite.exec(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  db.sqlite.exec("UPDATE play_stats SET play_count=17, duration_ms=215000, last_played_at_ms=950 WHERE song_id='s1';");
  db.sqlite.exec("INSERT INTO site_stats VALUES ('generatedLinks', 123, 456);");
  const stats = rows(db, 'play_stats');
  const site = rows(db, 'site_stats');
  await migrateDatabase(db);
  assert.deepEqual(rows(db, 'play_stats'), stats);
  assert.deepEqual(rows(db, 'site_stats'), site);
});

test('current schema without a migration ledger is adopted without replaying historical counts', async t => {
  const db = fixture(t, schema);
  db.sqlite.exec('DROP TABLE schema_migrations;');
  seed(db);
  db.sqlite.exec("INSERT INTO play_stats VALUES (7, 'p1', 's1', 'Current', 'Artist', 123000, 20, 1000);");
  await migrateDatabase(db);
  assert.equal(rows(db, 'play_stats').find(row => row.song_id === 's1').play_count, 20);
  assert.equal(rows(db, 'schema_migrations').length, 1);
});

test('failure inside the migration batch rolls back parent and child data together', async t => {
  const db = fixture(t, legacySchema);
  seed(db);
  const before = rows(db, 'favorites');
  const plan = migrationPlan(await inspectDatabase(db.query));
  assert.throws(() => db.execute(plan + '\nINSERT INTO missing_table VALUES (1);'));
  assert.deepEqual(rows(db, 'favorites'), before);
  assert.equal(rows(db, 'users')[0].id, 7);
  assert.equal(db.query("SELECT name FROM sqlite_schema WHERE name = 'schema_migrations'").length, 0);
  assert.equal(db.query('PRAGMA foreign_key_check').length, 0);
  await migrateDatabase(db);
});
