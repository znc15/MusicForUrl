PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL CHECK (platform IN ('netease', 'qq')),
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

CREATE TABLE IF NOT EXISTS qr_sessions (
  platform TEXT NOT NULL CHECK (platform IN ('netease', 'qq')),
  key_hash TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (platform, key_hash)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key_hash, bucket)
);

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

CREATE TABLE IF NOT EXISTS play_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  playlist_id TEXT,
  song_id TEXT NOT NULL,
  song_name TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  played_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS play_logs_user_playlist_time_idx ON play_logs(user_id, playlist_id, played_at_ms DESC);
CREATE INDEX IF NOT EXISTS play_logs_user_song_time_idx ON play_logs(user_id, playlist_id, song_id, played_at_ms DESC);
CREATE INDEX IF NOT EXISTS play_logs_user_time_idx ON play_logs(user_id, played_at_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS play_logs_time_idx ON play_logs(played_at_ms);

CREATE TABLE IF NOT EXISTS song_sources (
  cache_key TEXT PRIMARY KEY,
  source_json TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS song_sources_expiry_idx ON song_sources(expires_at_ms);
