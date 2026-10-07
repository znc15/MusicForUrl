const PLAY_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PLAY_LOG_DEDUP_MS = 5 * 60 * 1000;
const PLAY_LOG_MAX_PER_USER = 1000;
const PLAY_LOG_MAX_PER_MINUTE = 12;

async function recordPlayback(env, userId, playlistId, song, now = Date.now()) {
  // Admission and retention share a D1 transaction, including concurrent retries.
  return env.DB.batch([
    env.DB.prepare(`
      INSERT INTO play_logs (user_id, playlist_id, song_id, song_name, artist, played_at_ms)
      SELECT ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM play_logs
        WHERE user_id = ? AND playlist_id = ? AND song_id = ? AND played_at_ms >= ?
      ) AND (
        SELECT COUNT(*) FROM play_logs WHERE user_id = ? AND played_at_ms >= ?
      ) < ?
    `).bind(
      userId, playlistId, String(song.id), song.name, song.artist, now,
      userId, playlistId, String(song.id), now - PLAY_LOG_DEDUP_MS,
      userId, now - 60000, PLAY_LOG_MAX_PER_MINUTE,
    ),
    env.DB.prepare('DELETE FROM play_logs WHERE user_id = ? AND played_at_ms < ?')
      .bind(userId, now - PLAY_LOG_RETENTION_MS),
    env.DB.prepare(`
      DELETE FROM play_logs WHERE user_id = ? AND id NOT IN (
        SELECT id FROM play_logs WHERE user_id = ?
        ORDER BY played_at_ms DESC, id DESC LIMIT ?
      )
    `).bind(userId, userId, PLAY_LOG_MAX_PER_USER),
  ]);
}

async function prunePlaybackLogs(env, now = Date.now()) {
  return env.DB.prepare('DELETE FROM play_logs WHERE played_at_ms < ?')
    .bind(now - PLAY_LOG_RETENTION_MS).run();
}

export {
  PLAY_LOG_DEDUP_MS, PLAY_LOG_MAX_PER_MINUTE, PLAY_LOG_MAX_PER_USER,
  PLAY_LOG_RETENTION_MS, prunePlaybackLogs, recordPlayback,
};
