import { readFile, writeFile, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
export const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
export const VERSION = '0004-unified-platform-schema';
const children = ['playlists', 'favorites', 'play_stats', 'play_logs'];
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const tableDefinition = name => schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]+?\\n\\);`))[0];

// The plan only reads schema metadata. All data copies and the ledger update run
// in one D1 batch; foreign_keys remains enabled throughout the rebuild.
export function migrationPlan(snapshot) {
  if (snapshot.applied.includes(VERSION)) return null;
  const tables = new Map(snapshot.objects.filter(row => row.type === 'table').map(row => [row.name, row]));
  if ([...tables.keys()].some(name => name.startsWith('__mfu_'))) {
    throw new Error('Migration scratch tables already exist; inspect the previous migration before continuing.');
  }
  const sql = [];
  const users = tables.get('users');
  if (users && (!users.sql.includes("'kugou'") || !users.sql.includes("'kuwo'"))) {
    const userColumns = ['id', 'platform', 'platform_user_id', 'nickname', 'avatar', 'vip_type', 'cookie_cipher',
      'token_hash', 'token_expires_at_ms', 'created_at_ms', 'last_login_at_ms'];
    if (snapshot.userColumns.length !== userColumns.length || userColumns.some(name => !snapshot.userColumns.includes(name))) {
      throw new Error('Unexpected users columns; review the schema before rebuilding users.');
    }
    for (const row of tables.values()) {
      if (/REFERENCES\s+["`\[]?users\b/i.test(row.sql || '') && !children.includes(row.name)) {
        throw new Error(`Unexpected users foreign key in ${row.name}; include that table in the migration first.`);
      }
    }
    sql.push(tableDefinition('users').replace('IF NOT EXISTS users', '__mfu_users'));
    const columns = userColumns.map(quote).join(', ');
    sql.push(`INSERT INTO __mfu_users (${columns}) SELECT ${columns} FROM users;`);
    sql.push(`CREATE TABLE __mfu_sequence AS SELECT name, seq FROM sqlite_sequence WHERE name IN ('users', 'play_logs');`);
    // Dropping a parent fires CASCADE even with defer_foreign_keys enabled.
    // Remove child tables after copying them, then recreate their original DDL.
    for (const name of children.filter(name => tables.has(name))) {
      sql.push(`CREATE TABLE ${quote('__mfu_' + name)} AS SELECT * FROM ${quote(name)};`);
      sql.push(`DROP TABLE ${quote(name)};`);
    }
    sql.push('DROP TABLE users; ALTER TABLE __mfu_users RENAME TO users;');
    for (const name of children.filter(name => tables.has(name))) {
      sql.push(tables.get(name).sql + ';');
      sql.push(`INSERT INTO ${quote(name)} SELECT * FROM ${quote('__mfu_' + name)};`);
      sql.push(`DROP TABLE ${quote('__mfu_' + name)};`);
    }
    sql.push(`UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM __mfu_sequence WHERE name = sqlite_sequence.name), 0)) WHERE name IN ('users', 'play_logs');`);
    sql.push(`INSERT INTO sqlite_sequence (name, seq) SELECT name, seq FROM __mfu_sequence old WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence current WHERE current.name = old.name);`);
    sql.push('DROP TABLE __mfu_sequence;');
    for (const row of snapshot.objects) {
      if (row.sql && ['index', 'trigger'].includes(row.type) && ['users', ...children].includes(row.tbl_name)) sql.push(row.sql + ';');
    }
  }
  // Preserve every existing aggregate, including counts written after a manual
  // 0001 backfill. Import only missing keys; overlapping old events stay archived.
  sql.push(schema);
  if (tables.has('play_stats') && !snapshot.statsColumns.includes('duration_ms')) {
    sql.push('ALTER TABLE play_stats ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;');
  }
  sql.push(`INSERT INTO play_stats (user_id, playlist_id, song_id, song_name, artist, play_count, last_played_at_ms)
    SELECT user_id, playlist_id, song_id, MAX(song_name), MAX(artist), COUNT(*), MAX(played_at_ms)
    FROM play_logs WHERE playlist_id IS NOT NULL AND playlist_id <> ''
    GROUP BY user_id, playlist_id, song_id
    ON CONFLICT (user_id, playlist_id, song_id) DO NOTHING;`);
  const qr = tables.get('qr_sessions');
  if (qr && /\bCHECK\s*\(/i.test(qr.sql)) {
    sql.push(tableDefinition('qr_sessions').replace('IF NOT EXISTS qr_sessions', '__mfu_qr_sessions'));
    sql.push('INSERT INTO __mfu_qr_sessions SELECT * FROM qr_sessions; DROP TABLE qr_sessions; ALTER TABLE __mfu_qr_sessions RENAME TO qr_sessions;');
    sql.push('CREATE INDEX qr_sessions_expiry_idx ON qr_sessions(expires_at_ms);');
  }
  sql.push(`INSERT INTO schema_migrations (version, applied_at_ms) VALUES ('${VERSION}', CAST(strftime('%s', 'now') AS INTEGER) * 1000);`);
  return sql.join('\n');
}

export async function inspectDatabase(query) {
  const objects = await query("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL");
  const has = name => objects.some(row => row.type === 'table' && row.name === name);
  return {
    objects,
    userColumns: has('users') ? (await query("PRAGMA table_info('users')")).map(row => row.name) : [],
    statsColumns: has('play_stats') ? (await query("PRAGMA table_info('play_stats')")).map(row => row.name) : [],
    applied: has('schema_migrations') ? (await query('SELECT version FROM schema_migrations')).map(row => row.version) : [],
  };
}

export function wranglerDatabase(options, spawn = spawnSync) {
  const cli = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
  const base = [cli, 'd1', 'execute', options.database || 'music-for-url', options.remote ? '--remote' : '--local', '--json'];
  if (options.config) base.push('--config', options.config);
  if (options.persistTo) base.push('--persist-to', options.persistTo);
  const run = args => {
    const result = spawn(process.execPath, [...base, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Wrangler exited ${result.status}`);
    return result.stdout;
  };
  return {
    query(sql) {
      let output;
      try { output = JSON.parse(run(['--command', sql])); }
      catch (error) {
        if (error instanceof SyntaxError) throw new Error('Wrangler query returned invalid JSON.');
        throw error;
      }
      const results = Array.isArray(output) ? output : [output];
      if (results.some(row => row?.success === false)) throw new Error('D1 rejected the migration query.');
      if (!results.length || results.some(row => row?.success !== true || !Array.isArray(row.results))) {
        throw new Error('Wrangler query returned an unexpected result shape.');
      }
      return results.flatMap(row => row.results);
    },
    async execute(sql) {
      const directory = await mkdtemp(path.join(tmpdir(), 'mfu-migration-'));
      const file = path.join(directory, 'migration.sql');
      try {
        await writeFile(file, sql);
        // Remote --file uses D1 import. Wrangler's spinner writes progress to
        // stdout even with --json; successful completion is its zero exit code.
        // Import errors exit nonzero. migrateDatabase verifies FK + ledger next.
        run(['--file', file, '--yes']);
      } finally {
        await rm(file, { force: true });
        await rmdir(directory);
      }
    },
  };
}

export async function migrateDatabase(db) {
  const violations = await db.query('PRAGMA foreign_key_check');
  if (violations.length) throw new Error('Existing foreign key violations; repair or restore the database before migrating.');
  const plan = migrationPlan(await inspectDatabase(db.query));
  if (!plan) return { changed: false, version: VERSION };
  await db.execute(plan);
  const after = await db.query('PRAGMA foreign_key_check');
  if (after.length) throw new Error('Foreign key validation failed after migration. Restore the pre-migration backup.');
  const applied = await db.query(`SELECT version FROM schema_migrations WHERE version = '${VERSION}'`);
  if (applied.length !== 1 || applied[0].version !== VERSION) {
    throw new Error('Migration completion was not recorded. Inspect the database before retrying.');
  }
  return { changed: true, version: VERSION };
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--local') options.local = true;
    else if (arg === '--remote') options.remote = true;
    else if (['--config', '--persist-to', '--database'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[{ '--config': 'config', '--persist-to': 'persistTo', '--database': 'database' }[arg]] = value;
    } else throw new Error(`Unknown option ${arg}`);
  }
  if (Boolean(options.local) === Boolean(options.remote)) throw new Error('Choose exactly one target: --local or --remote.');
  if (options.remote && options.persistTo) throw new Error('--persist-to is only available with --local.');
  const result = await migrateDatabase(wranglerDatabase(options));
  console.log(`${result.changed ? 'Applied' : 'Already applied'} ${result.version} (${options.remote ? 'remote' : 'local'}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
