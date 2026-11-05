# Cloudflare 部署

`master` 是后续维护入口，推荐使用 Workers Static Assets + D1，按需启用私有 R2。已有 Pages 项目也可以使用下方的 Functions 兼容入口。

Node.js / Docker 版本保存在 `node`。其运行命令、SQLite 与 FFmpeg 配置见[冻结基线 f3830c4 的原始文档](https://github.com/znc15/MusicForUrl/blob/f3830c4/README.node-docker.md)。

## 安装依赖与本地运行

需要 Node.js 24+。在 Cloudflare 工作副本根目录执行：

```sh
npm --prefix web ci
npm --prefix cloudflare ci
cp cloudflare/.dev.vars.example cloudflare/.dev.vars
```

将 `cloudflare/.dev.vars` 中的 `ENCRYPTION_KEY` 换成至少 32 字符的独立随机密钥，然后初始化本地数据库并启动：

```sh
npm --prefix cloudflare run db:local
npm run dev
```

根目录提供统一入口：`npm test` 运行基础模块、Worker、数据库迁移与前端状态机回归，`npm run check` 检查前端类型，`npm run build` 输出 `web/dist`。根目录无需单独安装依赖。

## 推荐：Workers + D1 + R2

完成依赖安装后，在 `cloudflare/` 执行：

```sh
npx wrangler login
npx wrangler d1 create music-for-url
npx wrangler r2 bucket create music-for-url-private-cache
```

修改 `wrangler.jsonc` 的 D1 ID、桶名和自己的域名；删除仓库站点的 `routes`。保留绑定名 `DB` / `AUDIO_CACHE`。密钥用 Secret，首次发布参照 [Cloudflare 仓库文档](../generated/cloudflare)。

复制 `.dev.vars.example` 为 `.dev.vars.production`，将其中的 `ENCRYPTION_KEY` 改为至少 32 字符的独立随机密钥，再执行：

```sh
npm run db:remote
npx wrangler r2 bucket lifecycle add music-for-url-private-cache expire-audio --prefix audio/v2/ --expire-days 1
npx wrangler r2 bucket lifecycle add music-for-url-private-cache expire-cover --prefix cover/v2/ --expire-days 2
npm run build:assets
npx wrangler deploy --secrets-file .dev.vars.production
```

上面的部署命令会同时上传 Secret。`AUDIO_CACHE_ENABLED=true` 启用缓存；没有 R2 时删除绑定并设为 `false`。后续代码更新执行 `npm run deploy`，会自动构建前端并保留已有 Secret。

### 旧数据库升级

1. 保存 D1 数据库导出或 Time Travel bookmark。
2. 在 `cloudflare/` 运行 `npm run db:migrate -- --remote`，完成四平台约束和历史表的统一升级。
3. 命令成功后再发布 Worker，并检查登录、收藏和历史。重复迁移会返回 `Already applied`。

原 `db:remote`、backfill、stats、qr npm 命令均调用同一版本化入口；已有账号和关联数据保留。详细回填与回滚方式见 [数据库升级说明](../generated/cloudflare#播放历史与保留)。

首次上线本次认证补丁时，建议安排 QQ、酷狗和酷我的已有会话重新登录，以清理旧 Cookie 入口曾签发的会话；执行前备份，保留账号及收藏、历史数据。

## Pages Functions

根目录 `functions/[[path]].js` 复用 Worker 处理器，`cloudflare/wrangler.pages.jsonc` 是示例，输出目录为 `web/dist`。修改 D1 ID / R2 桶，并在 Pages 项目设置相同 Secret。完成本页的依赖安装后，从仓库根目录执行：

```sh
npm run build
npx --prefix cloudflare wrangler pages deploy web/dist --config cloudflare/wrangler.pages.jsonc
```

保持仓库根目录为执行位置，供 Wrangler 同时打包 `functions/` 与 `web/dist`。Pages Functions 需要 D1、可选 R2 绑定及 Secret。本项目每日清理使用 Worker `scheduled`，Pages 部署须另配维护 Worker 的 Cron 执行过期数据清理与统计刷新，或使用推荐的 Workers 部署。参考 [Pages Functions 绑定](https://developers.cloudflare.com/pages/functions/bindings/)与 [Workers Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。

## 发布验证

发布后检查 `/api/health`、`/api/player/capabilities`，再使用真实账号测试登录、低 / 高音质、封面、拖动进度与退出撤销。R2 缓存可先关闭用于排障。
