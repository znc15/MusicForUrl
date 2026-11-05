# MusicForUrl 项目记录

## 当前方向（2026-11-05）

用户决定采用两个分支，后续仅维护 Cloudflare 方案，传统 Node.js 方案保持冻结。

| 分支 | 用途 | 基线 |
| --- | --- | --- |
| `master` | 后续功能、修复、依赖与文档维护 | 从 `f3830c4` 分出 |
| `node` | 传统 Node.js / SQLite / Docker 原版本 | 固定 `f3830c4`，2.1.1 |

当前工作目录为 `K:\MusicForUrl`。2026-11-05 按用户最新决定，Cloudflare 分支改名为 `master`，传统冻结分支改名为 `node`，分支名去除前缀。`master` 跟踪 `origin/master`；当前仅操作本地，远端分支和线上部署保持原状态。

## 结构与入口

- `web/`：React 前端；`cloudflare/`：Worker、D1 schema/迁移、R2 与回归测试。
- `lib/player-api.js`、`player-policy.js`、`player-cache.js`、`qqmusic.js`：Worker 依赖的 CommonJS 模块，保留原路径。
- `functions/` 和 `cloudflare/wrangler.pages.jsonc`：Pages 兼容入口，静态产物为 `web/dist`。
- 根命令统一指向 Cloudflare：`dev`、`start`、`test`、`check`、`build:worker`、`docs:build`。
- 传统服务端、Docker、旧前端及其专属依赖与测试从 Cloudflare 维护树移出；原文件可在冻结分支获取。
- 详细安装与发布说明见 `README.md`、`cloudflare/README.md`；分支操作约定见 `AGENTS.md`。

## 拆分验收

- 本次拆分已完成。根测试 20 项、Worker 回归 58 项全部通过；前端类型检查与生产构建、Worker dry-run、Pages Functions 打包、VitePress 文档构建通过。
- 本地 Wrangler 的 `/api/health`、`/api/player/capabilities`、`/preview` 和品牌图均返回 200；已实际查看构建后的播放器页面、Cloudflare 部署指南及旧 `/generated/server` 冻结版指引。
- 拆分提交 `ee7e0fc` 保留 Cloudflare 业务源码及数据库结构。前端构建有既有 hls.js 分块体积提示。

## 审计修复第一批（2026-11-05，已完成本地验收）

用户已授权按审计开始修改，仅在 `master` 实施；`node` 固定原基线。

- 后端已修：S1 禁止 QQ/酷狗/酷我手填 Cookie 建会话，QQ 完成受信授权回调并按 Cookie 作用域转发；P1 等价入口共享限流、shed 拒绝新签发、fresh 固定窗口与并发合并、拒绝后计数封顶；P5 酷狗/酷我 15 秒及响应体预算。
- 前端已修：C1 四平台独立令牌及有明确归属的旧 token 迁移；S8 账号私有查询键与请求取消；C3 播放异步竞争；C4 收藏分页同步；U1 手机输入与常驻播放器；U2 游客生成；U3 错误/空/未知状态与重试；P3 初始化去重及按标签请求；U4 对比度、键盘进度与平台切换、小屏音量/音质设置。
- 工程已修：E1 统一版本化迁移 `0004-unified-platform-schema`，保留旧主键、外键子数据、自增序列和现有聚合；S9 更新 forge 1.4.3、Wrangler 4.157.0、web/website Vite 6.4.5，三个工作区 npm audit 均 0。
- 迁移入口：`npm --prefix cloudflare run db:migrate -- --local` / `--remote`，必须显式选择目标；旧 db:* 命令保留为统一入口别名。生产先备份/取得 Time Travel bookmark，迁移成功后发布。历史未知 duration_ms 为 0，已知值保留。
- 当前批次后继续处理：O1 大歌单部分结果与真实纳入数量，O2 播放统计周期/人数/时长口径。Node 专属问题留在冻结版本，不向该分支补丁。
- 验收：`npm test` 113/113（根 24、Worker/迁移 76、前端状态机 13），另 Wrangler 本地 D1 迁移集成 1/1；类型检查、前端生产构建、Worker dry-run 与文档构建通过。QQ 完整可信重定向链及越域/缺 key/失败/身份冲突已用受控响应验证。
- 浏览器验收：A→B 后旧列表清除、19 条收藏删除末页项后回退为 18 条、错误重试恢复、预览失败无成功提示；375×812 无横纵溢出，首页输入 52px、预览输入 44px、播放器/队列/设置可达，进度方向键可用；未知统计显示 —，重试后真实 0 正确显示。真实本地 Worker 三个平台 Cookie 入口返回 405，health/capabilities/页面返回 200。
- 上线前仍需真实 QQ/酷狗/酷我账号与 VRChat/AVPro 验证；建议评估撤销旧入口签发的 QQ/酷狗/酷我已有会话并重新登录，保留账号、收藏和历史。远端迁移与会话撤销本次未执行。

## 远端状态

- 远端推送、默认分支调整、冻结分支保护和生产部署待用户授权；本地拆分不依赖这些操作。
