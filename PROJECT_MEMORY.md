# MusicForUrl 项目记录

## 当前方向（2026-11-05）

**当前阶段：实施2.4.1控件与统计修复。** 用户指出音量/音质未对齐、下拉无样式，以及16次播放全缺时长却显示0分钟。当前线上为2.4.0；仍仅维护master、node冻结。Apple Music平台接入继续保留评估。

## 2.4.1 控件与统计修复（2026-11-05）

- 控件改为同高玻璃栏；音质使用已有Radix Select并单独设计菜单，实际音源格式/码率放在菜单头，保留音质选择、禁用和键盘行为。SelectContent仅新增可选Portal容器，支持原生全屏；VolumeControl的百分比为可选，其他调用保持。
- root实际检查320/375/768/1280px：音量与音质中心差0px，菜单均在视口内；键盘选高品质、Escape恢复焦点、禁用无损、切音质保留位置通过。实际128kbps测试音源与所选高品质分别显示；截图在output/playwright/2.4.1/。
- 统计根因已确认：旧数组缓存读取时一律durationKnown=false，误丢非180秒真实时长。线上初次核对16条player事件全为0，48个账号与DB一致。迁移前备份与当前缓存的13个唯一曲目时长/缓存expiry一致，匹配16条事件合计4,201,000ms，可可靠纠正。
- 统计owner负责时长规则、API/展示及离线限定修复脚本；root负责控件、版本/Release、发布后备份和生产修复。先部署以停止新增误标，再刷新安全事件快照/预演、备份、执行修复，禁止猜填默认180或用后来的元数据回写历史。
- 本地验收：243/243（根26、Worker126、前端91）；新增真实隔离D1修复集成1/1，覆盖回滚、首次修正、重复执行和临时触发器清理。React类型/生产、Worker dry-run、Pages Functions和文档构建通过；320px最终菜单截图已查看，页面无横向溢出。

## 2.4.0 播放界面方向（2026-11-05）

- 参考 Apple 官方[全屏/迷你播放器](https://support.apple.com/en-gb/guide/music-web/apdm333a63ec/web)、[材质指南](https://developer.apple.com/design/human-interface-guidelines/materials)及 Mac 用户指南的全屏截图。采用大封面与封面模糊色背景；玻璃集中在控制和队列层。
- 桌面左侧封面/歌曲/进度/播放控制，右侧可搜索播放队列；手机单列，保留队列和打开入口。空状态直接提供播放链接、本地文件及歌单入口，不填充虚构歌曲或歌词。
- 视觉：系统字体；主文字 #f5f7fb、次文字 #c4d4e3、基底 #132b3d / #091923、品牌强调 #79c9ec、玻璃边缘白色 16%。真实封面决定氛围，回退沿用品牌蓝；主标题 26–32px，正文 14px，控制触点至少 40px。
- 播放保持唯一常驻 audio；大播放器和底部播放条共享进度与控制。补齐随机/循环、系统媒体控制；保留原签名链接、HTTPS 直链、本地音视频与跨路由播放。
- 分工：根负责页面、mini、样式与整合/发布；运行层 owner 负责持久媒体与模式；直链/本地 owner 负责 MediaStage。验收覆盖真实合成音频、切路由、拖动、音量、模式、错误、全屏、移动/亮暗主题及本地文件。
- 已实现：`player.css` 沉浸页面与mini玻璃层；`player-controls.tsx` 共享控制/搜索队列；`playback-engine.tsx` 唯一音频元素、进度恢复与MediaSession；`stores/playback.ts`控制桥；`stores/player.ts`随机/循环/访问历史；MediaStage保持独立直链/本地入口。导航名“播放器”、路径仍 `/preview`。
- 本地测试 219/219（根26、Worker115、前端78），React类型/生产、Worker dry-run、Pages Functions、文档构建通过。本版无后端行为或数据库结构变更，沿用0005。
- 浏览器实际验收使用合成Range WAV、12/150首队列、本地WAV和canvas生成WebM：同audio跨路由无pause，进度键盘可调，切音质保留位置，队列点歌/随机回退/自然单曲循环与手动下一首通过；第130首搜索后定位可达；mini队列缩到375px可关闭；切源/关闭时旧audio已暂停；本地音频controls、视频原生controls、旧ObjectURL释放通过。
- 原生全屏请求在受控Chrome返回 `TypeError: not granted`，已验证拒绝提示，普通浏览器的实际进入/退出留待手动确认。全屏期间自动公告延期和退出后调度由实际组件5项单测覆盖。剪贴板写入有成功反馈；未读取系统剪贴板内容。
- 视觉已检查桌面、768/375/320px、亮暗主题、空状态与本地媒体。审查修复长队列定位范围/仅队列内滚动、mini队列窄屏关闭入口。证据：`output/playwright/2.4.0/`（Git忽略）；测试素材仅用于验收。
- 发布提交 `e757ecee8bbe775c803f9964dfdb94f9dc11d5ad` 已推master；GitHub [Project checks 42044508365](https://github.com/znc15/MusicForUrl/actions/runs/42044508365)、[Project website 42044508534](https://github.com/znc15/MusicForUrl/actions/runs/42044508534) 均成功，CI复验219项、D1隔离集成1项及全部构建，文档站已发布。
- Cloudflare 首次构建 `524f85c3-0557-4650-a61f-2ab3a5526e87` 测试与上传成功，在最终部署返回通用错误，日志未给具体原因；线上当时仍为2.3.0。用既有显式Wrangler命令成功发布 `f2385f15-7291-4258-a00b-985dc11eeaa1`，随后自动构建重试 `e4d4f13f-5cac-4d53-a37a-91b7227096d5` 完整成功，当前Worker为 `b8920211-de26-4d2f-8bcc-e15edc06bf90`。没有更改构建配置/令牌/数据库/Secret。
- 三域名health为200/ok/e757ece；DB/R2/两项Analytics/ASSETS/ENCRYPTION_KEY绑定沿用。线上关于页2.4.0、新公告、播放器空态和375px本地音频实际播至结束验证通过，无页面异常。证据 `.codex/releases/2026-11-05-2.4.0/`。
- [v2.4.0 Release](https://github.com/znc15/MusicForUrl/releases/tag/v2.4.0) 已发布并设为Latest，标签准确指向e757ece；原生全屏手动验收缺口已在Release说明记录。其余真实平台账号与VRChat/AVPro客户端的实播仍沿用此前待验收状态，Apple Music接入继续等待独立环境/账号。

## 2.3.0 实施与验收（2026-11-05）

- 歌单详情可复制地址，卡片保留独立播放；部分歌单显示实际纳入数、原因与真实有效期并支持重取。修复登录迟到响应、终曲重建音量和旧播放错误竞争。
- 登录与共享 Dialog 完整进出动效；平台/分类单行切换条、手机导航、字段错误反馈和系统字体完成。公告 `release-2.3.0` 首次展示、本机已读、手动重开、登录优先。
- 新增永久 `playback_totals`、30 天 `playback_events`、游客覆盖和公开排行；未知/零值/旧快照/错误区分。媒体传输完整性及失败 AE 分类已补齐，原生日志配置继续沿用。
- 本地测试 183/183（根 26、Worker 115、前端 42）；独立本地 D1 集成 1/1。类型检查、React 生产构建、Worker dry-run、Pages Functions 打包和文档构建通过。hls.js 仍有既有按需块体积提示。
- 隔离浏览器合成数据验收：详情无自动播放、复制/重取、收藏/最近入口、A/B 登录竞争、键盘焦点、减弱动效、空输入和损坏链接；统计未知为 —、真实零、旧数据重试；终曲重建静音保持 0、非静音保持 0.2；公告与登录切换期间同一音频元素且 pause 事件为 0。320px 深色与 375/768/1440px 浅色截图已实际查看；字体请求为 0。
- 生产 D1 已备份并应用 `0005-persistent-playback-stats`。原表迁移前后数量相同：users 48、playlists 3、favorites 2、play_stats 405、play_logs 284；外键违规 0，ledger 包含 0004 与 0005。新累计起算 `1793883320000`（2026-11-05T12:55:20Z），初始 plays=0。
- 备份与发布证据：`.codex/releases/2026-11-05-2.3.0/`；迁移前书签 `00000357-00000000-0000511a-26ed0af386d2b89c86b6b5ad48aec137`。前一 Worker 为 `41815286-f171-48db-9c97-50b6b0f6d4d1`，可回退代码并保留增量表。测试/UI 证据 `.codex/audits/2026-11-05-update/`。
- 发布提交 `6bfb55e30c3229cb0c08b715ef807487d8bd86a4` 已推送 master；`v2.3.0` 标签准确指向该提交，[GitHub Release](https://github.com/znc15/MusicForUrl/releases/tag/v2.3.0) 已发布并标记 Latest。node 继续冻结于 `f3830c4374d3e6d48f14e889acf66a80570c5600`。
- Cloudflare 自动构建 `c00cbe2a-f7c6-4d2d-a450-97ea26a026ec` 成功，生产 Worker `0f2699bc-ed3b-475b-b58a-094d129e877e`。三个域名 health 均 200/ok/6bfb55e；DB、R2、两项 Analytics、ASSETS、ENCRYPTION_KEY 绑定、域名和 Cron 保持。
- 线上 stats 为 version=2、startedAt=1793883320000、stale=false；原解析数 14835、生成数 52、账号数 48。公开排行 200、30 天窗口；新累计初始为 0。实际浏览器关于页显示 2.3.0，公告首次展示；375px 首页无横向溢出、无页面异常、字体请求 0，截图已查看。
- GitHub [Project checks 42031722958](https://github.com/znc15/MusicForUrl/actions/runs/42031722958) 与 [Project website 42031722805](https://github.com/znc15/MusicForUrl/actions/runs/42031722805) 均成功；CI 复验 183/183、本地 D1 集成 1/1 以及 React/Worker/Pages/文档构建，文档站已发布。
- 后续依赖：真实四平台账号登录和 VRChat/AVPro 实播需账号与客户端参与；Apple Music 等用户准备隔离 Linux/Docker 环境、有效订阅测试账号后继续 B 方案评估。媒体 AE 分类已有测试和线上绑定验证，真实上游流失败的入库分布留待生产流量观察。

用户决定采用两个分支，后续仅维护 Cloudflare 方案，传统 Node.js 方案保持冻结。

| 分支 | 用途 | 基线 |
| --- | --- | --- |
| `master` | 后续功能、修复、依赖与文档维护 | 从 `f3830c4` 分出 |
| `node` | 传统 Node.js / SQLite / Docker 原版本 | 固定 `f3830c4`，2.1.1 |

当前工作目录为 `K:\MusicForUrl`。2026-11-05 按用户最新决定，Cloudflare 分支改名为 `master`，传统冻结分支改名为 `node`，分支名去除前缀。`master` 跟踪 `origin/master`。用户随后授权推送两个分支并更新既有 Cloudflare 生产服务。

用户于 2026-11-05 补充发布要求：以后每次更新都递增版本号，并同步更新 GitHub Release。具体版本同步与发布验收步骤写入 `AGENTS.md`；更新记录统一维护在 `CHANGELOG.md`。

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
- 初次恢复版本：`e3d55dce-2ed7-4417-9895-6e8e2b0d70f1`，应用标记 `DEPLOY_VERSION=cca392e`，后续已由下方自动发布版本替换。原 D1、私有 R2、Analytics、两个域名、workers.dev 与每日 UTC 03:17 Cron 已恢复并沿用。
- 线上验证：三个域名 health 均 200 / ok / cca392e；capabilities 与匿名 auth/status 为 200 JSON；QQ/酷狗/酷我 Cookie 入口为 405；首页引用生产 assets，375×812 页面宽度 375、输入框 52px，桌面/移动截图已检查；accounts/user/preview 刷新 200，无页面异常。真实平台账号与 VRChat/AVPro 尚待实际用户验收。

## 自动发布修复（2026-11-05）

- 用户已完成控制台登录。已核实原配置为仓库根目录 `/`、空构建命令、默认 `npx wrangler deploy`，导致未读取 `cloudflare/wrangler.jsonc`。现已保存正确设置，生产分支继续为 `master`。
- 构建：`npm --prefix cloudflare ci && npm --prefix web ci && npm test && npm run build:worker`。
- 部署：`node cloudflare/node_modules/wrangler/bin/wrangler.js deploy --config cloudflare/wrangler.jsonc --keep-vars --var "DEPLOY_VERSION:$WORKERS_CI_COMMIT_SHA"`。
- 构建变量：`NODE_VERSION=24`、`SKIP_DEPENDENCY_INSTALL=1`。继续沿用原构建令牌、D1、R2、Analytics、Cron、域名与运行 Secret。
- 发布脚本补丁 `df2e936` 修复 Wrangler 远端文件导入输出混入进度文本导致的解析误报；严格查询 JSON、非零退出处理、迁移后 FK 与版本 ledger 检查保留。迁移单测 10/10、Worker 总测试 83/83、真实本地 D1 集成 1/1 通过，生产 no-op 检查通过。
- `df2e936` 与自动部署文档已推送，候选 `07b201b` 的 GitHub Actions 检查及文档发布通过。
- Cloudflare 专属构建失败已定位为 `EMFILE`：构建容器软/硬文件句柄上限均为 1024，提升额度被拒绝。包安装与解析诊断确认 clsx 完整；Vite 默认模块读取并发与 246 个字体 URL 读取叠加导致资源紧张。已在 `web/vite.config.ts` 将 Rollup `maxParallelFileOps` 设为 128，为字体加载留出空间；本地与真实 Cloudflare Builds 构建均已通过。临时诊断及 ulimit 命令已移除。
- 构建并发修复提交 `162edb95846004c964fe307958d0c91df16c6d21` 已推送并通过实际 Cloudflare Workers Builds：`689f24a4-8023-4f3b-af0f-0c6293394910`，完整测试、React 构建、Worker dry-run 与部署成功；构建/发布日志保存在 `.codex/releases/2026-11-05-master-51c81ed/automatic-build-162edb9.log`。
- 该次自动发布 Worker：`ea1d63cd-49eb-4067-9f85-de7abb103d19`，`DEPLOY_VERSION=162edb95846004c964fe307958d0c91df16c6d21`。三域名 health=200/ok、capabilities=200、三平台 Cookie=405；生产 assets、375px 页面和全部绑定（含 ENCRYPTION_KEY）验收通过。原 47 个账号与数据库迁移验收继续有效。
- Cloudflare 构建监视排除 `PROJECT_MEMORY.md`，只更新发布记录时不重新部署应用；其他路径继续触发构建。临时诊断及 ulimit 命令均已移除，生产分支仍为 master。
- Cloudflare 实际部署与线上核验已成功；其 GitHub check-run 回写暂显示 in_progress，保留原始状态，不用手工改写。GitHub Actions `Project checks` run `42008009568` 已成功，覆盖 136 项测试、本地 D1 集成、React/Worker/Pages 与文档构建。独立文档站沿用已成功的 `42005728225`。
- 真实平台账号扫码/密码登录和 VRChat/AVPro 仍需实际账号与客户端验证。后续维护仅改 master，node 保持 f3830c4。

## 第二轮问题与 UI 需求（2026-11-05，分析阶段）

- 已建立 `OPTIMIZATION_BACKLOG.md`，包含剩余问题、用户新增五项需求、文件位置、优先级与验收方式。后续仍只在 master 实施。
- 用户明确新增：登录悬浮窗开关/切换动画；截图中的切换条样式；歌单卡片进入详情后可复制播放地址并保留独立播放入口；新增 Apple Music（由更多平台需求收敛）；公告悬浮窗。
- 公告需求已记录为 U07，建议采用顶栏入口、未读公告首次自动展示、按公告 ID 本机已读、手动重开，并复用登录弹窗的动效/可访问性；正文发布时提供，首版沿用 master 数据维护与发布流程。
- 已复现关键问题：部分歌单导出数量失真/长缓存；旧登录响应覆盖新账号；终曲结束后静音界面仍为开但 audio.volume=1；旧手动播放 Promise 错误污染新曲目；后端统计缺失伪装为零、累计/人数/时长口径不一致。
- UI/性能补充：320px 标签拆字与分段控件 3+1 换行；首页输入键盘焦点不可见/空提交无反馈；损坏 grant 触发 URIError；首页首次字体 18 请求、1116160 字节传输。截图在 `.codex/audits/2026-11-05-ui/`。
- 用户于 2026-11-05 将首批平台扩展收敛为 Apple Music，随后选择 B：继续评估 Apple 原音全曲直链用于 VRChat/AVPro；外播目标已确定，继续核对独立服务与实际播放链路。
- 该轮分析已归档。用户已确认本轮开发与统计口径，实施结果见 2.3.0；Apple Music 路线 B 暂留评估，等待测试环境与账号。

## Workers Observability（2026-11-05，已发布）

- 用户随后明确要求启用 Workers Observability。本次只实施原生日志及直接相关的凭据日志修复，上述 UI、平台扩展与公告需求仍待实施。
- `master` 已推送 `847176533c6c620c98b6cf89107db0fb38fdf70d`；`cloudflare/wrangler.jsonc` 启用持久化请求调用日志、console 与运行时错误，调用采样 100%，`redact_query_string=true`；Traces 关闭，无外部导出。`node` 仍固定 `f3830c4374d3e6d48f14e889acf66a80570c5600`。
- `lib/qqmusic.js` 删除失败重试日志中的原始 vkey/purl，保留尝试次数与上游错误码；回归测试先复现旧行为，再验证修复且成功音源 URL 保持完整。
- 实际 Cloudflare Builds `1a409620-e460-4b79-a64e-cade7d2b0e49` 成功。该次生产 Worker `c79b0261-a695-4a4d-890e-14d67e1331c4`，`DEPLOY_VERSION=847176533c6c620c98b6cf89107db0fb38fdf70d`；三个域名 health 均为 200/ok，D1/R2/Analytics/域名/Cron 沿用。
- 验收：QQ 针对测试 4/4；自动构建 137/137（根 24、Worker 84、前端 29）。GitHub Project checks `42017259180` 与 Project website `42017259273` 成功，包含本地 D1 集成与 Worker/Pages/文档构建。
- 已在控制台 Observability 查询实际持久化事件：合成 health 请求 200，合成无效播放签名请求 401；查询串标记未保存，x-token/x-qq-token/x-kugou-token/x-kuwo-token 均为 REDACTED。URL 路径标记仍保留，已向用户说明 HLS 路径短期签名可能保存在日志，日志权限仅授予排障维护者。
- 控制台确认当前 Free 套餐日志额度为 200K events/day，超额采样；日志入库界面提示最多 2 分钟延迟。构建及脱敏验收摘要在 `.codex/releases/2026-11-05-master-51c81ed/observability-build-8471765.log` 与 `observability-verification.json`。

## 2.2.0 版本与 Release（2026-11-05，已发布）

- 用户要求每次更新都修改版本号并更新 Release；已写入已推送的 `AGENTS.md`。新增 `CHANGELOG.md`，三个应用 package 与对应 lock 共 9 个版本字段统一为 2.2.0，根测试校验版本及最新更新记录一致性。前端版本继续来自根 package，health 的 version 仍为部署提交 SHA。
- 发布提交及标签：`eadef145a04b59d1cd6c1eee3820aaf0b1ed05d0` / `v2.2.0`。GitHub Release 已发布并标记 Latest：https://github.com/znc15/MusicForUrl/releases/tag/v2.2.0 。旧 v2.1.1 Release 与冻结 node 保留。
- 当前生产 Worker `41815286-f171-48db-9c97-50b6b0f6d4d1`，来自实际 Cloudflare build `2985ff67-22fc-4ee7-9819-771759b5705c`；三个域名 health=200/ok/eadef14，浏览器关于页实际显示“前端版本 2.2.0”。日志配置随仓库保留。
- GitHub Project checks `42018830155`、Project website `42018829738` 成功；139/139 常规测试和 1/1 本地 D1 集成通过，React/Worker/Pages/文档构建完成。构建证据 `.codex/releases/2026-11-05-master-51c81ed/release-build-eadef14.log`。
- 本版汇总已交付的 Cloudflare 拆分、第一批审计修复、自动部署和 Observability；第二轮 UI、Apple Music 与公告需求继续保留在 `OPTIMIZATION_BACKLOG.md`，尚待实施。

## Apple Music 接入调研（2026-11-05）

- 首批平台由用户选定为 Apple Music；已搜索 GitHub 并核对 Apple 官方文档，结果整合到 `OPTIMIZATION_BACKLOG.md` 的 R01 与 Apple Music 调研节。
- 用户已选择 B，全曲直链用于 VRChat/AVPro。评估方向改为 Cloudflare 网站/API/签名链接 + 独立 Apple Music 原生音频服务；优先核查 `lbr77/apple-music-api`，`gamdl` 作为下载引擎参照。当前导出实际要求 MP3，优先验证独立服务输出 MP3并复用 Packed Audio。
- GitHub 参考：anthony-liddle/apple-music-developer-token（MIT，签名核心）、Musish/Musish（旧 React/MusicKit，AGPL 与 package MIT 标注冲突）、glomatico/gamdl（Python/Rust 下载引擎）、lbr77/apple-music-api（原生 Linux/Android HTTP 音频服务）。后两项需要额外运行服务，现成 m4a/ALAC 输出还需格式适配与实播验证。
- B 方案确认范围为继续可行性评估；官方站内路线保留为调研背景。用户确认测试环境和账号暂未准备，2.3.0 保留评估结果。后续受控实测需用户准备隔离 Linux/Docker 环境并自行完成有效订阅账号登录，提供 VRChat/AVPro 客户端；账号隔离、歌单读取、首播缓存和格式适配为关键验收点。
- 深入核查 `lbr77/apple-music-api@3eb3b4a0b43d563ad4abee8513c26f73ea0755ce`：daemon 单活跃账号、缺少歌单详情/分页接口、缓存音频统一 Bearer 鉴权、冷请求等待下载完成；Subsonic 明确拒绝 MP3，普通 playback 的底层 MP3 支持待验证。B 计划据此列为单曲→本站签名直链→歌单与多用户→VRChat 实播→实施结论，附提交固定的源码链接与实测责任。
