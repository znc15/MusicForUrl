// Offline planner only: reads a pre-event backup's playlists INSERT statements
// and credential-free read-only observations. It never connects to production.
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function readPlaylistEvidence(backupPath) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE playlists (user_id INTEGER, playlist_id TEXT, name TEXT, cover TEXT, song_count INTEGER, songs_json TEXT, expires_at_ms INTEGER)');
  try {
    const lines = createInterface({ input: createReadStream(backupPath), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.startsWith('INSERT INTO "playlists" (')) db.prepare(line).run();
    }
    return db.prepare('SELECT user_id, playlist_id, songs_json, expires_at_ms FROM playlists').all();
  } finally { db.close(); }
}

const integer = value => Number.isSafeInteger(value) && value > 0;
const numericId = value => /^\d{1,20}$/.test(String(value));

export function planDurationRepair(evidence, snapshots) {
  if (!integer(evidence.startedAt) || !integer(evidence.backupBeforeMs) || evidence.backupBeforeMs > evidence.startedAt) {
    throw new Error('A pre-ledger backup timestamp and the exact ledger start are required.');
  }
  if (!Array.isArray(evidence.events) || evidence.events.length > 100) throw new Error('Expected at most 100 explicitly scoped events.');
  const candidates = [], skipped = [];
  const seen = new Set();
  for (const event of evidence.events) {
    if (!integer(event.id) || seen.has(event.id)) throw new Error('Event IDs must be unique positive integers.');
    seen.add(event.id);
    const matching = rows => rows.filter(row => row.user_id === event.user_id && String(row.playlist_id) === String(event.playlist_id));
    const old = matching(snapshots), current = matching(evidence.current || []);
    let seconds = 0;
    if (old.length === 1 && current.length === 1 && current[0].cache_shape === 'array'
      && old[0].expires_at_ms === current[0].expires_at_ms) {
      const previousTracks = JSON.parse(old[0].songs_json);
      const currentTracks = JSON.parse(current[0].tracks_json);
      const tracksFor = tracks => Array.isArray(tracks) ? tracks.filter(track => String(track.id) === String(event.song_id)) : [];
      const before = tracksFor(previousTracks), after = tracksFor(currentTracks);
      if (before.length === 1 && after.length === 1 && before[0].durationKnown !== false && after[0].durationKnown !== false
        && Number(before[0].duration) === Number(after[0].duration)) seconds = Number(before[0].duration);
    }
    const durationMs = Math.round(seconds * 1000);
    // This repair is deliberately limited to the observed Netease legacy-array
    // incident. Ambiguous old 180s and later metadata are never promoted.
    if (event.platform !== 'netease' || event.duration_ms !== 0 || !integer(event.user_id)
      || !numericId(event.playlist_id) || !numericId(event.song_id) || !integer(event.played_at_ms)
      || event.played_at_ms <= evidence.backupBeforeMs || !integer(durationMs) || seconds === 180
      || event.played_at_ms >= old[0]?.expires_at_ms) {
      skipped.push(event.id); continue;
    }
    candidates.push({ ...event, duration_ms: durationMs });
  }
  if (!candidates.length) return { candidates, skipped, durationMs: 0, sql: '-- No reliably matched events.\n' };
  // All interpolated values below are validated integers / digit-only IDs.
  const tuples = candidates.map(e => `(${e.id}, ${e.user_id}, '${e.playlist_id}', '${e.song_id}', ${e.played_at_ms}, ${e.duration_ms})`).join(',\n  ');
  const sql = `-- Reviewed, exact-scope repair. Execute this entire file as one D1 import transaction.
-- Only zero-duration rows matching every event coordinate are changed. Repeat execution is a no-op.
CREATE TRIGGER __mfu_repair_legacy_duration AFTER UPDATE OF duration_ms ON playback_events
WHEN OLD.duration_ms = 0 AND NEW.duration_ms > 0 BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM playback_totals WHERE id = 1 AND started_at_ms = ${evidence.startedAt})
    THEN RAISE(ABORT, 'Unexpected playback ledger') END;
  UPDATE playback_totals SET duration_ms = duration_ms + NEW.duration_ms,
    known_duration_plays = known_duration_plays + 1,
    updated_at_ms = MAX(updated_at_ms, CAST(strftime('%s', 'now') AS INTEGER) * 1000) WHERE id = 1;
END;
WITH expected(id, user_id, playlist_id, song_id, played_at_ms, duration_ms) AS (VALUES
  ${tuples}
)
UPDATE playback_events SET duration_ms = (SELECT duration_ms FROM expected WHERE expected.id = playback_events.id)
WHERE duration_ms = 0 AND platform = 'netease' AND EXISTS (
  SELECT 1 FROM expected WHERE expected.id = playback_events.id AND expected.user_id = playback_events.user_id
    AND expected.playlist_id = playback_events.playlist_id AND expected.song_id = playback_events.song_id
    AND expected.played_at_ms = playback_events.played_at_ms
);
DROP TRIGGER __mfu_repair_legacy_duration;
`;
  return { candidates, skipped, durationMs: candidates.reduce((sum, e) => sum + e.duration_ms, 0), sql };
}

export async function dryRunDurationRepair(evidence, plan) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
    db.prepare('UPDATE playback_totals SET started_at_ms=?').run(evidence.startedAt);
    const insert = db.prepare(`INSERT INTO playback_events (id,actor_key,user_id,platform,playlist_id,song_id,duration_ms,surface,played_at_ms)
      VALUES (?, 'offline-fixture', ?, ?, ?, ?, ?, 'player', ?)`);
    for (const e of evidence.events) insert.run(e.id, e.user_id, e.platform, e.playlist_id, e.song_id, e.duration_ms, e.played_at_ms);
    const totals = () => ({ ...db.prepare('SELECT plays,duration_ms,known_duration_plays,player_plays,hls_plays,redirect_plays FROM playback_totals').get() });
    const before = totals();
    db.exec('BEGIN'); db.exec(plan.sql); db.exec('COMMIT');
    const after = totals();
    db.exec('BEGIN'); db.exec(plan.sql); db.exec('COMMIT');
    return { scopedEvents: evidence.events.length, matchedEvents: plan.candidates.length, skipped: plan.skipped,
      restoredDurationMs: plan.durationMs, before, after, repeated: totals() };
  } finally { db.close(); }
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--backup', '--evidence', '--sql'].includes(args[i]) || !args[i + 1]) throw new Error('Use --backup <pre-event.sql> --evidence <safe.json> [--sql <output.sql>].');
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options.backup || !options.evidence) throw new Error('--backup and --evidence are required.');
  const evidence = JSON.parse(await readFile(options.evidence, 'utf8'));
  const plan = planDurationRepair(evidence, await readPlaylistEvidence(options.backup));
  const report = await dryRunDurationRepair(evidence, plan);
  if (options.sql) await writeFile(options.sql, plan.sql);
  console.log(JSON.stringify(report, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
