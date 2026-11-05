import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { schema, VERSION, inspectDatabase, migrationPlan, migrateDatabase, wranglerDatabase } from '../scripts/migrate.mjs';

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

test('Wrangler query output stays strict and rejects unsuccessful or malformed results', () => {
  let result = { status: 0, stdout: JSON.stringify([{ success: true, results: [{ value: 7 }] }]), stderr: '' };
  const db = wranglerDatabase({ remote: true }, (_command, args) => {
    assert.ok(args.includes('--command'));
    assert.ok(args.includes('--json'));
    return result;
  });
  assert.deepEqual(db.query('SELECT 7 AS value'), [{ value: 7 }]);
  result.stdout = JSON.stringify({ success: true, results: [] });
  assert.deepEqual(db.query('PRAGMA foreign_key_check'), []);
  result.stdout = JSON.stringify([{ success: false, results: [] }]);
  assert.throws(() => db.query('SELECT 1'), /D1 rejected/);
  for (const stdout of ['', '├ Checking if file needs uploading\n[]', '{malformed']) {
    result.stdout = stdout;
    assert.throws(() => db.query('SELECT 1'), /invalid JSON/);
  }
  for (const payload of [null, [], {}, { error: 'rejected' }, { success: true }, { success: true, results: {} }]) {
    result.stdout = JSON.stringify(payload);
    assert.throws(() => db.query('SELECT 1'), /unexpected result shape/);
  }
});

test('Wrangler file imports accept progress plus JSON while process failures still reject', async () => {
  const success = JSON.stringify([{ results: [{ 'Total queries executed': 4 }], success: true, finalBookmark: 'fixture' }], null, 2);
  let result = { status: 0, stdout: `├ Checking if file needs uploading\n│\n├ 🌌 Uploading migration.sql\n│ 🌌 Uploading complete.\n\n${success}\n`, stderr: '' };
  const db = wranglerDatabase({ remote: true }, (_command, args) => {
    assert.ok(args.includes('--file'));
    assert.ok(args.includes('--yes'));
    assert.ok(args.includes('--remote'));
    assert.equal(readFileSync(args[args.indexOf('--file') + 1], 'utf8'), 'SELECT 1;');
    return result;
  });
  await db.execute('SELECT 1;');
  result = { status: 1, stdout: '├ Checking if file needs uploading\n' + JSON.stringify({ error: { text: 'import failed' } }), stderr: '' };
  await assert.rejects(db.execute('SELECT 1;'), /import failed/);
  result = { status: 1, stdout: success, stderr: 'process failed after output' };
  await assert.rejects(db.execute('SELECT 1;'), /process failed/);
  const failure = new Error('spawn failed');
  result = { error: failure, status: null, stdout: '', stderr: '' };
  await assert.rejects(db.execute('SELECT 1;'), error => error === failure);
});

test('progress-bearing imports reach post-migration FK and ledger checks and then become a no-op', async t => {
  const memory = fixture(t, legacySchema);
  seed(memory);
  let imports = 0;
  const queriesAfterImport = [];
  const db = wranglerDatabase({ remote: true }, (_command, args) => {
    if (args.includes('--command')) {
      const sql = args[args.indexOf('--command') + 1];
      if (imports) queriesAfterImport.push(sql);
      return { status: 0, stdout: JSON.stringify([{ success: true, results: memory.query(sql) }]), stderr: '' };
    }
    const file = args[args.indexOf('--file') + 1];
    memory.execute(readFileSync(file, 'utf8'));
    imports++;
    return { status: 0, stdout: '├ Checking if file needs uploading\n│\n' + JSON.stringify([
      { success: true, results: [{ 'Total queries executed': 40 }], finalBookmark: 'fixture' },
    ]), stderr: '' };
  });
  assert.deepEqual(await migrateDatabase(db), { changed: true, version: VERSION });
  assert.ok(queriesAfterImport.includes('PRAGMA foreign_key_check'));
  assert.ok(queriesAfterImport.some(sql => sql.startsWith('SELECT version FROM schema_migrations WHERE')));
  assert.deepEqual(await migrateDatabase(db), { changed: false, version: VERSION });
  assert.equal(imports, 1);
});

test('migration rejects missing completion ledger or failed post-import FK check', async t => {
  for (const failure of ['ledger', 'foreign-key']) {
    const memory = fixture(t, schema);
    const baseQuery = memory.query;
    let executed = false;
    const db = {
      query(sql) {
        if (executed && failure === 'foreign-key' && sql === 'PRAGMA foreign_key_check') return [{ table: 'fixture', rowid: 1 }];
        return baseQuery(sql);
      },
      execute() { executed = true; },
    };
    await assert.rejects(migrateDatabase(db), failure === 'ledger' ? /completion was not recorded/ : /Foreign key validation failed/);
  }
});
