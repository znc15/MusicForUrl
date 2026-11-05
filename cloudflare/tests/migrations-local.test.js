import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { schema, inspectDatabase, migrationPlan, migrateDatabase, wranglerDatabase } from '../scripts/migrate.mjs';

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
  const legacy = schema.replace("'netease', 'qq', 'kugou', 'kuwo'", "'netease', 'qq'")
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
});
