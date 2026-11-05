-- 历史迁移，仅用于旧版本追溯与回归夹具。当前安装/升级统一执行 npm run db:migrate -- --local 或 --remote。
-- 一次性回填：把旧版逐事件表 play_logs 聚合成 play_stats。
--
-- 执行顺序（重要）：
--   1. npm run db:remote      -- 先建表（schema.sql 幂等，可重复执行）
--   2. npm run db:backfill    -- 本文件，必须在部署新版 Worker 之前执行一次
--   3. npm run deploy
--
-- 本文件可重复执行，但**只应在新版 Worker 上线前执行**：它按 play_logs 重算并覆盖
-- play_stats 的值，如果新版已经写入新数据，重跑会把新计数覆盖回旧值。
-- 回填完成并观察一个版本后，play_logs 及其索引即可从 schema.sql 中删除。

INSERT INTO play_stats (user_id, playlist_id, song_id, song_name, artist, play_count, last_played_at_ms)
SELECT user_id, playlist_id, song_id, MAX(song_name), MAX(artist), COUNT(*), MAX(played_at_ms)
FROM play_logs
WHERE playlist_id IS NOT NULL AND playlist_id <> ''
GROUP BY user_id, playlist_id, song_id
ON CONFLICT (user_id, playlist_id, song_id) DO UPDATE SET
  play_count = excluded.play_count,
  last_played_at_ms = excluded.last_played_at_ms,
  song_name = excluded.song_name,
  artist = excluded.artist;
