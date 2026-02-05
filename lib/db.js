const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'database.sqlite'));

try {
  db.pragma('journal_mode = WAL');
} catch (e) {
  console.warn('[DB] WAL 不可用，已回退到 journal_mode=DELETE：', e?.message || e);
  try {
    db.pragma('journal_mode = DELETE');
  } catch (_) {}
}

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      netease_id TEXT UNIQUE NOT NULL,
      nickname TEXT,
      avatar TEXT,
      vip_type INTEGER DEFAULT 0,
      cookie TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS playlists (
      playlist_id TEXT PRIMARY KEY,
      name TEXT,
      cover TEXT,
      song_count INTEGER,
      songs TEXT,
      cached_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      playlist_id TEXT NOT NULL,
      playlist_name TEXT,
      playlist_cover TEXT,
      nickname TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, playlist_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS play_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      playlist_id TEXT,
      song_id TEXT,
      song_name TEXT,
      artist TEXT,
      played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_favorites_user_created_at ON favorites(user_id, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_play_logs_user_played_at ON play_logs(user_id, played_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_play_logs_user_song_id ON play_logs(user_id, song_id)');

  console.log('数据库初始化完成');
}

initDatabase();

const userOps = {
  upsert: db.prepare(`
    INSERT INTO users (netease_id, nickname, avatar, vip_type, cookie, token, last_login)
    VALUES (@netease_id, @nickname, @avatar, @vip_type, @cookie, @token, CURRENT_TIMESTAMP)
    ON CONFLICT(netease_id) DO UPDATE SET
      nickname = @nickname,
      avatar = @avatar,
      vip_type = @vip_type,
      cookie = @cookie,
      token = @token,
      last_login = CURRENT_TIMESTAMP
  `),

  getByToken: db.prepare('SELECT * FROM users WHERE token = ?'),

  getByNeteaseId: db.prepare('SELECT * FROM users WHERE netease_id = ?'),

  updateCookie: db.prepare('UPDATE users SET cookie = ?, last_login = CURRENT_TIMESTAMP WHERE id = ?'),

  rotateToken: db.prepare('UPDATE users SET token = ?, cookie = ? WHERE id = ?'),

  delete: db.prepare('DELETE FROM users WHERE id = ?')
};

const playlistOps = {
  get: db.prepare('SELECT * FROM playlists WHERE playlist_id = ? AND expires_at > CURRENT_TIMESTAMP'),

  set: db.prepare(`
    INSERT INTO playlists (playlist_id, name, cover, song_count, songs, cached_at, expires_at)
    VALUES (@playlist_id, @name, @cover, @song_count, @songs, CURRENT_TIMESTAMP, @expires_at)
    ON CONFLICT(playlist_id) DO UPDATE SET
      name = @name,
      cover = @cover,
      song_count = @song_count,
      songs = @songs,
      cached_at = CURRENT_TIMESTAMP,
      expires_at = @expires_at
  `),

  clearExpired: db.prepare('DELETE FROM playlists WHERE expires_at <= CURRENT_TIMESTAMP')
};

const favoriteOps = {
  getByUser: db.prepare('SELECT * FROM favorites WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'),

  add: db.prepare(`
    INSERT INTO favorites (user_id, playlist_id, playlist_name, playlist_cover, nickname)
    VALUES (@user_id, @playlist_id, @playlist_name, @playlist_cover, @nickname)
    ON CONFLICT(user_id, playlist_id) DO UPDATE SET
      playlist_name = @playlist_name,
      playlist_cover = @playlist_cover,
      nickname = COALESCE(@nickname, nickname)
  `),

  remove: db.prepare('DELETE FROM favorites WHERE user_id = ? AND playlist_id = ?'),

  check: db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND playlist_id = ?'),

  count: db.prepare('SELECT COUNT(*) as count FROM favorites WHERE user_id = ?')
};

const playLogOps = {
  log: db.prepare(`
    INSERT INTO play_logs (user_id, playlist_id, song_id, song_name, artist)
    VALUES (@user_id, @playlist_id, @song_id, @song_name, @artist)
  `),

  getRecent: db.prepare(`
    SELECT * FROM play_logs 
    WHERE user_id = ? 
    ORDER BY played_at DESC 
    LIMIT ? OFFSET ?
  `),

  count: db.prepare('SELECT COUNT(*) as count FROM play_logs WHERE user_id = ?'),

  getTopSongs: db.prepare(`
    SELECT song_id, song_name, artist, COUNT(*) as play_count
    FROM play_logs
    WHERE user_id = ?
    GROUP BY song_id
    ORDER BY play_count DESC
    LIMIT ?
  `)
};

module.exports = {
  db,
  initDatabase,
  userOps,
  playlistOps,
  favoriteOps,
  playLogOps
};
