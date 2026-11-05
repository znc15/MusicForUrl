# MusicForUrl 维护约定

## 分支

- `codex/cloudflare`：唯一持续维护分支，使用 React + Cloudflare Workers + D1，可选 R2。
- `codex/nodejs-frozen`：传统 Node.js / SQLite / Docker 冻结快照，基线为 `f3830c4`（2.1.1）。保留该提交的代码、依赖、文档和入口。
- 后续功能、修复、依赖升级和文档更新只提交到 `codex/cloudflare`。用户明确改变冻结决定前，不向 Node.js 分支提交、合并、变基或挑选提交。
- 开始工作先检查当前分支、工作区变化和 `PROJECT_MEMORY.md`。推送、修改远端默认分支与部署按当次用户授权执行。

## 入口

- 根 `npm run dev` / `npm start`：构建前端后启动本地 Wrangler。
- 根 `npm test`：播放器/QQ 适配器纯函数测试与 Worker 回归。
- 根 `npm run check`：前端类型检查。
- 根 `npm run build:worker`：前端生产构建与 Worker 本地 dry-run 打包，不发布。
- 文档构建：先安装 `website/` 依赖，再运行根 `npm run docs:build`。
- 安装前端与 Worker 依赖：`npm ci --prefix web`、`npm ci --prefix cloudflare`；根包只提供命令和版本元数据。

## 结构

`web/` 为当前前端，`cloudflare/` 为后端和数据库迁移，`functions/` 为 Pages 兼容入口。
根 `lib/` 保留 Worker 使用的四个 CommonJS 模块。维持其路径和模块格式，修改时验证 Worker 打包及测试。
当前分支保留 Cloudflare 方案的既有功能；前次审计中的业务问题按独立修复任务处理。
