# 两种部署方式

## 兼容范围

| 能力 | Workers / Pages Functions | 自有 Node.js / Docker |
| --- | --- | --- |
| 登录、歌单、收藏、账号管理 | D1 + AES-GCM | SQLite + 原有加密模块 |
| 网页音质选择、封面、队列 | MP3 档位 | MP3 / FLAC，取决于浏览器 |
| 私有音频缓存 | R2 绑定 | 可选本地磁盘缓存 |
| 轻量音频 M3U8 | Packed Audio | 保留旧输出接口 |
| FFmpeg HLS / MP4 | 无 | 安装 FFmpeg 后使用 |
| 历史清理 | Worker Cron | Node 进程内清理 |

共享 `/api/player/*`、音质策略和流式代理，前端通过 `/capabilities` 自动识别环境。两种数据库、加密密钥和播放签名不能直接互换，迁移需重新登录或单独编写受控数据迁移。

## 推荐：Workers + D1 + R2

在 `cloudflare/` 执行，Node.js 24+：

```sh
npm ci
npx wrangler login
npx wrangler d1 create music-for-url
npx wrangler r2 bucket create music-for-url-private-cache
```

修改 `wrangler.jsonc` 的 D1 ID、桶名和自己的域名；删除仓库站点的 `routes`。保留绑定名 `DB` / `AUDIO_CACHE`。密钥用 Secret，首次发布参照 [Cloudflare 仓库文档](../generated/cloudflare)。

```sh
npm run db:remote
npx wrangler r2 bucket lifecycle add music-for-url-private-cache expire-audio --prefix audio/v2/ --expire-days 1
npx wrangler r2 bucket lifecycle add music-for-url-private-cache expire-cover --prefix cover/v2/ --expire-days 2
npm run deploy
```

首次部署前必须设置 `ENCRYPTION_KEY`，可用 `npx wrangler secret put ENCRYPTION_KEY`。`AUDIO_CACHE_ENABLED=true` 启用缓存；没有 R2 时删除绑定并设为 `false`。升级先备份 D1、运行幂等 schema，再发布。已有 Secret 不应轮换。

## Pages Functions

根目录 `functions/[[path]].js` 复用 Worker 处理器，`cloudflare/wrangler.pages.jsonc` 是示例。修改 D1 ID / R2 桶，并在 Pages 项目设置相同 Secret。从仓库根目录执行：

```sh
npm --prefix cloudflare ci
npm --prefix cloudflare run build:assets
npx --prefix cloudflare wrangler pages deploy public --config cloudflare/wrangler.pages.jsonc
```

Pages Functions 需要 D1、R2 绑定，不能仅上传静态 HTML。本项目每日清理使用 Worker `scheduled`，Pages 部署须另配维护 Worker 的 Cron 执行 schema 中过期表清理，或使用推荐的 Workers 部署。参考 [Pages Functions 绑定](https://developers.cloudflare.com/pages/functions/bindings/)与 [Workers Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。

## 自有服务器

在仓库根目录执行：

```sh
npm ci
cp env.example .env
npm start
```

设置独立 `ENCRYPTION_KEY`、`PORT`，可选 `DATA_DIR`、`AUDIO_CACHE_ENABLED=true`、`PLAYER_CACHE_DIR` 和 `MUSIC_QUALITY`。持久化 SQLite、缓存目录并备份密钥。网页逐首 MP3 / FLAC 预览不依赖 FFmpeg，旧 HLS / MP4 仍需安装 FFmpeg。Docker 命令见 [服务器部署说明](../generated/server)。

发布后检查 `/api/health`、`/api/player/capabilities`，再使用真实账号测试登录、低 / 高音质、封面、拖动进度与退出撤销。R2 缓存可先关闭用于排障。
