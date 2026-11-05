# MusicForUrl 项目记录

## 当前方向（2026-11-05）

用户决定采用两个分支，后续仅维护 Cloudflare 方案，传统 Node.js 方案保持冻结。

| 分支 | 用途 | 基线 |
| --- | --- | --- |
| `codex/cloudflare` | 后续功能、修复、依赖与文档维护 | 从 `f3830c4` 分出 |
| `codex/nodejs-frozen` | 传统 Node.js / SQLite / Docker 原版本 | 固定 `f3830c4`，2.1.1 |

当前工作目录为 `K:\MusicForUrl`。原本地 `master` 重命名为 `codex/cloudflare` 并解除对 `origin/master` 的跟踪，避免误推原分支。本次仅操作本地，远端分支、默认分支和线上部署保持原状态。

## 结构与入口

- `web/`：React 前端；`cloudflare/`：Worker、D1 schema/迁移、R2 与回归测试。
- `lib/player-api.js`、`player-policy.js`、`player-cache.js`、`qqmusic.js`：Worker 依赖的 CommonJS 模块，保留原路径。
- `functions/` 和 `cloudflare/wrangler.pages.jsonc`：Pages 兼容入口，静态产物为 `web/dist`。
- 根命令统一指向 Cloudflare：`dev`、`start`、`test`、`check`、`build:worker`、`docs:build`。
- 传统服务端、Docker、旧前端及其专属依赖与测试从 Cloudflare 维护树移出；原文件可在冻结分支获取。
- 详细安装与发布说明见 `README.md`、`cloudflare/README.md`；分支操作约定见 `AGENTS.md`。

## 待办与验收

- 本次拆分已完成。根测试 20 项、Worker 回归 58 项全部通过；前端类型检查与生产构建、Worker dry-run、Pages Functions 打包、VitePress 文档构建通过。
- 本地 Wrangler 的 `/api/health`、`/api/player/capabilities`、`/preview` 和品牌图均返回 200；已实际查看构建后的播放器页面、Cloudflare 部署指南及旧 `/generated/server` 冻结版指引。
- Node.js 冻结分支仍指向原基线；Cloudflare 业务源码、数据库 schema 和迁移本次未变。前端构建保留既有 hls.js 分块体积提示。
- 前次审计发现的 Cloudflare 认证、前端账号存储/缓存、迁移、限流及移动端问题仍待独立修复；本次只处理分支和构建维护边界。
- 远端推送、默认分支调整、冻结分支保护和生产部署待用户授权；本地拆分不依赖这些操作。
