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
-- duration_ms 只服务「关于」页的总播放时长，跟着歌曲元数据更新，不额外产生写入。
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
-- 其余由 cron 与惰性刷新从 play_stats、users 重算，见 src/stats.js。
CREATE TABLE IF NOT EXISTS site_stats (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL DEFAULT 0
);
