# MusicForUrl 项目记录

## 当前方向（2026-11-05）

用户决定采用两个分支，后续仅维护 Cloudflare 方案，传统 Node.js 方案保持冻结。

| 分支 | 用途 | 基线 |
| --- | --- | --- |
| `master` | 后续功能、修复、依赖与文档维护 | 从 `f3830c4` 分出 |
| `node` | 传统 Node.js / SQLite / Docker 原版本 | 固定 `f3830c4`，2.1.1 |

当前工作目录为 `K:\MusicForUrl`。2026-11-05 按用户最新决定，Cloudflare 分支改名为 `master`，传统冻结分支改名为 `node`，分支名去除前缀。`master` 跟踪 `origin/master`。用户随后授权推送两个分支并更新既有 Cloudflare 生产服务。

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
- 真实 QQ/酷狗/酷我账号与 VRChat/AVPro 验证仍需账号及客户端参与。本次生产检查发现 QQ 活跃会话为 0，酷狗/酷我无用户，现有网易云 7 个活跃会话保留。

## 生产发布（2026-11-05）

- 已推送：`master=cca392eb54ed9bf5260a38f6a884641fe8e5436f`，`node=f3830c4374d3e6d48f14e889acf66a80570c5600`。GitHub 默认分支为 master，Node 原树保持。通过真实 merge 纳入远端至 `1118ca9` 的 4 个提交，保留 Cron 顺序、平台存储/播放器取消、Pages Functions 构建及部署指南修复。
- GitHub Actions：Project checks `42001835685`、Project website `42001835681` 均成功，文档站已发布。合并候选根 24 + Worker/迁移 79 + 前端 29 = 132 项、本地 D1 集成 1 项通过；React/Worker/Pages/文档构建通过。
- 原 D1 已完成 `0004-unified-platform-schema`，users 允许四平台，外键检查通过，重复执行返回 `Already applied`。迁移前后完整导出逐行核对：47 用户、1 歌单、2 收藏、284 历史事件、404 聚合及其他原表、自增序列保持。
- 备份及发布证据：Git 忽略目录 `.codex/releases/2026-11-05-master-51c81ed/`。迁移前书签 `00000348-00000000-0000511a-8a632b15e91dddaf6ffc04b2602d3721`；原可用 Worker 版本 `453a44ea-70e5-4351-953b-9ee5744a6698`。
- 推送触发了既有 Cloudflare Workers Builds（build `73f7e4f3-509b-4d1a-8410-5b57729474ac`）。其发布结果为纯静态版本 `1e51015b-e951-487d-92c0-519d06d72c70`，首页引用 `/src/main.tsx`，API 404，且丢失原绑定。已回退原版本后按 `cloudflare/wrangler.jsonc` 手动发布完整 Worker。
- 纯静态发布还移除了在线 `ENCRYPTION_KEY` 绑定；已使用原有 `.dev.vars.production` 备份恢复同一密钥，无轮换。恢复前在本地检查全部 43 条非空 Cookie 密文均可解密，7 个活跃会话均匹配；4 条已退出账号的空 Cookie 保持原样。没有撤销会话。
- 当前生产 Worker 版本：`e3d55dce-2ed7-4417-9895-6e8e2b0d70f1`（100%），应用标记 `DEPLOY_VERSION=cca392e`。原 D1、私有 R2、Analytics、两个域名、workers.dev 与每日 UTC 03:17 Cron 已恢复并沿用。
- 线上验证：三个域名 health 均 200 / ok / cca392e；capabilities 与匿名 auth/status 为 200 JSON；QQ/酷狗/酷我 Cookie 入口为 405；首页引用生产 assets，375×812 页面宽度 375、输入框 52px，桌面/移动截图已检查；accounts/user/preview 刷新 200，无页面异常。真实平台账号与 VRChat/AVPro 尚待实际用户验收。

## 自动发布修复（2026-11-05）

- 用户已完成控制台登录。已核实原配置为仓库根目录 `/`、空构建命令、默认 `npx wrangler deploy`，导致未读取 `cloudflare/wrangler.jsonc`。现已保存正确设置，生产分支继续为 `master`。
- 构建：`npm --prefix cloudflare ci && npm --prefix web ci && npm test && npm run build:worker`。
- 部署：`node cloudflare/node_modules/wrangler/bin/wrangler.js deploy --config cloudflare/wrangler.jsonc --keep-vars --var "DEPLOY_VERSION:$WORKERS_CI_COMMIT_SHA"`。
- 构建变量：`NODE_VERSION=24`、`SKIP_DEPENDENCY_INSTALL=1`。继续沿用原构建令牌、D1、R2、Analytics、Cron、域名与运行 Secret。
- 发布脚本补丁 `df2e936` 修复 Wrangler 远端文件导入输出混入进度文本导致的解析误报；严格查询 JSON、非零退出处理、迁移后 FK 与版本 ledger 检查保留。迁移单测 10/10、Worker 总测试 83/83、真实本地 D1 集成 1/1 通过，生产 no-op 检查通过。
- 下一步：推送补丁与自动部署说明，跟进实际 Cloudflare Workers Builds 和 GitHub Actions，核对线上版本、API、生产 assets 与原绑定。
