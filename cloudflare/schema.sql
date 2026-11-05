PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL CHECK (platform IN ('netease', 'qq', 'kugou', 'kuwo')),
  platform_user_id TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  vip_type INTEGER NOT NULL DEFAULT 0,
  cookie_cipher TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  token_expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  last_login_at_ms INTEGER NOT NULL,
  UNIQUE (platform, platform_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS users_token_hash_idx ON users(token_hash);

CREATE TABLE IF NOT EXISTS playlists (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  playlist_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  song_count INTEGER NOT NULL DEFAULT 0,
  songs_json TEXT NOT NULL DEFAULT '[]',
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, playlist_id)
);
CREATE INDEX IF NOT EXISTS playlists_expiry_idx ON playlists(expires_at_ms);

CREATE TABLE IF NOT EXISTS qr_sessions (
  -- 平台只在这里存扫码会话，合法性由平台注册表保证；不写 CHECK，新增平台不需要重建表
  platform TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (platform, key_hash)
);
CREATE INDEX IF NOT EXISTS qr_sessions_expiry_idx ON qr_sessions(expires_at_ms);

CREATE TABLE IF NOT EXISTS rate_limits (
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key_hash, bucket)
);
CREATE INDEX IF NOT EXISTS rate_limits_bucket_idx ON rate_limits(bucket);

CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  playlist_id TEXT NOT NULL,
  playlist_name TEXT NOT NULL DEFAULT '',
  playlist_cover TEXT NOT NULL DEFAULT '',
  nickname TEXT,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, playlist_id)
);
CREATE INDEX IF NOT EXISTS favorites_user_created_idx ON favorites(user_id, created_at_ms DESC);

-- 播放统计：一次播放一行写入的聚合表，(用户, 歌单, 歌曲) 唯一。
-- 保留策略按 last_played_at_ms 判断，不再需要每次播放做行数裁剪。
-- duration_ms 保留兼容个人历史；永久估算时长在 playback_totals 中按事件累加。
CREATE TABLE IF NOT EXISTS play_stats (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  playlist_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  song_name TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  play_count INTEGER NOT NULL DEFAULT 0,
  last_played_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, playlist_id, song_id)
);
CREATE INDEX IF NOT EXISTS play_stats_user_time_idx ON play_stats(user_id, last_played_at_ms DESC);
CREATE INDEX IF NOT EXISTS play_stats_time_idx ON play_stats(last_played_at_ms);

-- 旧版逐事件表，仅用于一次性回填 play_stats（见 migrations/）。
-- 回填完成并观察一个版本后即可删除。
CREATE TABLE IF NOT EXISTS play_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  playlist_id TEXT,
  song_id TEXT NOT NULL,
  song_name TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  played_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS play_logs_user_time_idx ON play_logs(user_id, played_at_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS play_logs_time_idx ON play_logs(played_at_ms);

CREATE TABLE IF NOT EXISTS song_sources (
  cache_key TEXT PRIMARY KEY,
  source_json TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS song_sources_expiry_idx ON song_sources(expires_at_ms);

-- 站点统计。实时项（parsedSongs / generatedLinks）由生成链接时累加，
-- v2 派生快照由 cron 与惰性刷新从 playback_events、users 重算，见 src/stats.js。
CREATE TABLE IF NOT EXISTS site_stats (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL DEFAULT 0
);

-- v2 totals start at migration time. Legacy snapshots remain in site_stats;
-- their incomplete retention window is not imported as lifetime history.
CREATE TABLE IF NOT EXISTS playback_totals (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  started_at_ms INTEGER NOT NULL,
  plays INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  known_duration_plays INTEGER NOT NULL DEFAULT 0,
  player_plays INTEGER NOT NULL DEFAULT 0,
  hls_plays INTEGER NOT NULL DEFAULT 0,
  redirect_plays INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);
INSERT OR IGNORE INTO playback_totals (id, started_at_ms, updated_at_ms)
VALUES (1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- Retained for exactly 30 days. Nullable account metadata deliberately has no
-- users FK: guests have no users row and account removal must preserve totals.
CREATE TABLE IF NOT EXISTS playback_events (
  id INTEGER PRIMARY KEY,
  actor_key TEXT NOT NULL,
  user_id INTEGER,
  platform TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  song_name TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  surface TEXT NOT NULL CHECK (surface IN ('player', 'hls', 'redirect')),
  played_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS playback_events_actor_time_idx ON playback_events(actor_key, played_at_ms DESC);
CREATE INDEX IF NOT EXISTS playback_events_dedup_idx ON playback_events(actor_key, playlist_id, song_id, played_at_ms DESC);
CREATE INDEX IF NOT EXISTS playback_events_time_idx ON playback_events(played_at_ms);
CREATE INDEX IF NOT EXISTS playback_events_user_time_idx ON playback_events(user_id, played_at_ms DESC);

-- Admission, permanent counters and personal aggregate update are atomic even
-- across isolates. Pruning events never decrements the permanent counters.
CREATE TRIGGER IF NOT EXISTS playback_events_totals AFTER INSERT ON playback_events BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM playback_totals WHERE id = 1)
    THEN RAISE(ABORT, 'playback totals missing') END;
  UPDATE playback_totals SET
    plays = plays + 1,
    duration_ms = duration_ms + NEW.duration_ms,
    known_duration_plays = known_duration_plays + (NEW.duration_ms > 0),
    player_plays = player_plays + (NEW.surface = 'player'),
    hls_plays = hls_plays + (NEW.surface = 'hls'),
    redirect_plays = redirect_plays + (NEW.surface = 'redirect'),
    updated_at_ms = MAX(updated_at_ms, NEW.played_at_ms)
  WHERE id = 1;
  INSERT INTO play_stats (user_id, playlist_id, song_id, song_name, artist, duration_ms, play_count, last_played_at_ms)
  SELECT NEW.user_id, NEW.playlist_id, NEW.song_id, NEW.song_name, NEW.artist, NEW.duration_ms, 1, NEW.played_at_ms
  WHERE NEW.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
  ON CONFLICT (user_id, playlist_id, song_id) DO UPDATE SET
    play_count = play_stats.play_count + 1, last_played_at_ms = MAX(play_stats.last_played_at_ms, excluded.last_played_at_ms),
    song_name = excluded.song_name, artist = excluded.artist, duration_ms = excluded.duration_ms;
END;
