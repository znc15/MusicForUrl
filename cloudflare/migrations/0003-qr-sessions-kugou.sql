-- 历史迁移，仅用于旧版本追溯与回归夹具。当前安装/升级统一执行 npm run db:migrate -- --local 或 --remote。
-- 酷狗扫码登录上线：qr_sessions 原先的 CHECK 只允许 netease / qq。
-- 表里只有有效期 3 分钟的扫码会话，没有持久数据，直接重建。
-- 必须在部署新版 Worker 之前执行一次；旧版 Worker 重建后仍可正常工作。
DROP TABLE IF EXISTS qr_sessions;

CREATE TABLE qr_sessions (
  platform TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (platform, key_hash)
);

CREATE INDEX IF NOT EXISTS qr_sessions_expiry_idx ON qr_sessions(expires_at_ms);
