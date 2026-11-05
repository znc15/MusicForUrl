-- 历史迁移，仅用于旧版本追溯与回归夹具。当前安装/升级统一执行 npm run db:migrate -- --local 或 --remote。
-- 0002 — 站点统计与播放时长
--
-- 必须在部署带 /api/stats 的 Worker 之前执行，否则 recordPlayback 会因为缺少
-- duration_ms 列而整条语句失败（D1 写入自 2026-09-01 起是硬失败）。
--
-- 线上执行（只跑一次，重复执行会因为 duplicate column 报错，这是有意的）：
--   cd cloudflare
--   npx wrangler d1 execute music-for-url --remote --file=./migrations/0002-site-stats.sql
--
-- 新库不需要这个迁移：schema.sql 已经包含同样的定义。

ALTER TABLE play_stats ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;

-- 历史行没有时长，回填成 180 秒的默认值，避免「总播放时长」长期显示 0。
-- 只能做一次，所以刻意放在迁移里而不是请求路径上。
UPDATE play_stats SET duration_ms = 180000 WHERE duration_ms = 0;

CREATE TABLE IF NOT EXISTS site_stats (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL DEFAULT 0
);
