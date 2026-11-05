# MusicForUrl 维护约定

## 分支

- `master`：唯一持续维护分支，使用 React + Cloudflare Workers + D1，可选 R2。
- `node`：传统 Node.js / SQLite / Docker 冻结快照，基线为 `f3830c4`（2.1.1）。保留该提交的代码、依赖、文档和入口。
- 后续功能、修复、依赖升级和文档更新只提交到 `master`。用户明确改变冻结决定前，不向 Node.js 分支提交、合并、变基或挑选提交。
- 开始工作先检查当前分支、工作区变化和 `PROJECT_MEMORY.md`。推送、修改远端默认分支与部署按当次用户授权执行。

## 入口

- 根 `npm run dev` / `npm start`：构建前端后启动本地 Wrangler。
- 根 `npm test`：播放器/QQ 适配器、Worker、迁移与前端状态机回归。
- 根 `npm run check`：前端类型检查。
- 根 `npm run build:worker`：前端生产构建与 Worker 本地 dry-run 打包，不发布。
- 文档构建：先安装 `website/` 依赖，再运行根 `npm run docs:build`。
- 安装前端与 Worker 依赖：`npm ci --prefix web`、`npm ci --prefix cloudflare`；根包只提供命令和版本元数据。

## 版本与 Release

- 用户于 2026-11-05 明确要求：每次更新都同步递增版本号，并更新对应的 GitHub Release，作为发布完成条件执行。
- 根 `package.json` 是产品版本来源；根、`web/`、`cloudflare/` 的 package.json 与 package-lock.json 顶层及根包版本保持一致。前端通过 `__APP_VERSION__` 读取根版本；`DEPLOY_VERSION` 继续记录部署提交 SHA。
- 修复与小调整递增 patch，新增能力或成批功能更新递增 minor，破坏性变更递增 major。同一发布批次的准备与验收记录使用同一版本。
- 更新 `CHANGELOG.md`，只列已实现内容和实际升级要求。通过相关测试与构建、推送 master 并验证部署后，为实际发布提交创建 `vX.Y.Z` 标签和 GitHub Release，填写中文更新说明并核对 Latest。
- 保留历史标签与 Release；新版本仅来自 master，冻结 node 分支的代码与 2.1.1 版本保持原样。推送、发布与部署沿用当次有效授权。

## 结构

`web/` 为当前前端，`cloudflare/` 为后端和数据库迁移，`functions/` 为 Pages 兼容入口。
根 `lib/` 保留 Worker 使用的四个 CommonJS 模块。维持其路径和模块格式，修改时验证 Worker 打包及测试。
按项目记录中的审计优先级修复 Cloudflare 方案；保留既有合法登录、分享和播放入口，并为修复增加对应回归测试。
