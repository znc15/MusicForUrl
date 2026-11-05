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

## 推荐：Workers + D1（可选 R2）

完成依赖安装后，在 `cloudflare/` 执行：

```sh
npx wrangler login
npx wrangler d1 create music-for-url
```

将新库的 ID 写入 `wrangler.jsonc`，保留 `DB` 绑定名；删除仓库站点的 `routes` 或改为自己的域名。

**先选择是否使用 R2**：

- 不使用：删除整个 `r2_buckets` 配置，并将 `vars.AUDIO_CACHE_ENABLED` 设为 `"false"`。只设为 `false` 仍会要求配置中的桶存在。
- 使用：创建自己的私有桶，更新 `bucket_name` 并保留 `AUDIO_CACHE` 绑定名，将 `AUDIO_CACHE_ENABLED` 设为 `"true"`，配置生命周期：

```sh
npx wrangler r2 bucket create music-for-url-private-cache
npx wrangler r2 bucket lifecycle add music-for-url-private-cache expire-audio --prefix audio/v2/ --expire-days 1
npx wrangler r2 bucket lifecycle add music-for-url-private-cache expire-cover --prefix cover/v2/ --expire-days 2
```

然后初始化新库并首次发布：

```sh
npm run db:remote
cp .dev.vars.example .dev.vars.production
# 编辑 ENCRYPTION_KEY 为独立的至少 32 字符随机密钥并安全备份；不要提交此文件
npm run build:assets
npx wrangler deploy --secrets-file .dev.vars.production
```

直接调用 Wrangler 不会触发 npm 的 `predeploy`，因此首次发布必须显式构建 `web/dist`。之后使用 `npm run deploy` 会自动构建并保留已有 Secret。完整说明见 [Cloudflare 仓库文档](../generated/cloudflare)。已有密钥随更新保留。

### 旧数据库升级

1. 保存 D1 数据库导出或 Time Travel bookmark。
2. 在 `cloudflare/` 运行 `npm run db:migrate -- --remote`，完成四平台约束和历史表的统一升级。
3. 命令成功后再发布 Worker，并检查登录、收藏和历史。重复迁移会返回 `Already applied`。

原 `db:remote`、backfill、stats、qr npm 命令均调用同一版本化入口；已有账号和关联数据保留。详细回填与回滚方式见 [数据库升级说明](../generated/cloudflare#播放历史与保留)。

首次上线本次认证补丁时，建议安排 QQ、酷狗和酷我的已有会话重新登录，以清理旧 Cookie 入口曾签发的会话；执行前备份，保留账号及收藏、历史数据。

## 现有 Pages 项目接入 React

保留现有 Pages 项目、域名、D1 数据库与 `ENCRYPTION_KEY`，不用新建资源或迁到 Workers。根目录 `functions/[[path]].js` 复用 `cloudflare/src/index.js`，负责同源 `/api/*`；React 前端发布 `web/dist`；`website/.vitepress/dist` 用于 GitHub 文档站。

### Git 构建设置

| 设置 | 值 |
| --- | --- |
| 生产分支 | `master`（发布前核对目标提交） |
| 根目录 | 仓库根目录，留空或 `/`；**不要设为 `web` 或 `cloudflare`** |
| 构建命令 | `npm --prefix cloudflare ci && npm --prefix web ci && npm run build:pages` |
| 构建输出目录 | `web/dist` |
| 构建变量 | `NODE_VERSION=24.22.1`、`SKIP_DEPENDENCY_INSTALL=1` |

`build:pages` 先做 React 类型检查/构建，再编译根 `functions/`，验证服务端依赖可解析；校验产物放入忽略的 `.pages-build/`，不会把 `_worker.js` 混入 `web/dist` 或切换成 Advanced mode。Pages 发布时仍自动编译根 `functions/`。只上传 `web/dist` 静态文件、遗漏 `functions/`，会导致页面可见但 API 不可用。

`web/public/_routes.json` 随 Vite 复制到输出，仅让 `/api/*` 调用 Functions，静态资源和 `/user`、`/accounts` 等 SPA 路由交给 Pages。产物不提供顶层 `404.html`，使用 Pages 默认 SPA 回退。不要把 API 重写到 `index.html`。

参考 [Functions 项目根目录要求](https://developers.cloudflare.com/pages/functions/get-started/)、[Pages SPA 路由](https://developers.cloudflare.com/pages/configuration/serving-pages/)和[构建变量](https://developers.cloudflare.com/pages/configuration/build-image/)。

### 配置与数据检查（发布前）

- 确认 Pages 的 `DB` 仍绑定原数据库，保留原 `ENCRYPTION_KEY` Secret，不重新生成或提交密钥。
- `AUDIO_CACHE` / `AUDIO_CACHE_ENABLED` 沿用原有设置；R2 不使用时不需要新建桶。不要为切换 UI 改其他绑定或权限。
- `cloudflare/wrangler.pages.jsonc` 是**显式 CLI 示例**：部署前核实项目名和 D1 ID，替换占位值。Git 根目录不存在默认 Wrangler 配置时，使用 Dashboard 的既有绑定。不要假定嵌套的自定义文件会自动接管控制台设置。
- 若选择显式 `--config cloudflare/wrangler.pages.jsonc` 的 CLI 发布，必须先核对其项目名、DB、可选 R2 与现有项目一致；输出相对该配置为 `../web/dist`。本指南不建议为了切 UI 顺便切换配置管理来源。
- 先只读确认实际表结构：`users.platform` 允许四平台、`qr_sessions` 允许酷狗、`play_stats` 有 `duration_ms`、存在 `site_stats`。保存原 D1 备份后，核对显式迁移配置的 `DB.database_id` 与 Pages Dashboard 的原绑定一致，再在 `cloudflare/` 运行 `npm run db:migrate -- --remote --config "<已核实配置的绝对路径>" --database DB`。该配置仅指定迁移目标，Pages 发布继续沿用原有配置管理方式；默认 Worker 配置可能指向其他库。统一入口会检查并升级，已记录该版本的库返回 `Already applied`。

Pages 不会自动执行 Worker 的 `scheduled`。既有维护任务应保留；若尚无清理任务，另行规划维护 Worker，不应为本次前端接入自动创建资源。也不要运行 `npm --prefix cloudflare run deploy`，该命令会部署独立 Worker。

### 发布验收与回退

先在使用独立测试绑定的预览环境验证；没有隔离绑定时，不用真实登录/写入来测试生产库。检查：首页 HTML 引用 `/assets/*.js` 模块而非 `/js/main.js`；首页和 `/accounts` 有四平台；`/user` 仍只显示支持个人音乐库的网易云与 QQ（酷狗/酷我暂不支持个人歌单库）；直接刷新 `/user`、`/accounts` 正常；`/api/health` 与 `/api/player/capabilities` 返回 JSON 而非 HTML。再在获授权后验证登录、生成、播放和退出。

发布失败可回退到原 Pages 部署，不切换数据库或密钥。数据库迁移须单独备份和审核，数据库恢复应使用迁移前备份或 Time Travel 书签。相关数据库步骤见 [Cloudflare 文档](../generated/cloudflare)。

## 发布验证

发布后检查 `/api/health`、`/api/player/capabilities`，再使用真实账号测试登录、低 / 高音质、封面、拖动进度与退出撤销。R2 缓存可先关闭用于排障。
