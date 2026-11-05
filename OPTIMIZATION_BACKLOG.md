# MusicForUrl 2.3.0 实现与发布验收清单

更新：2026-11-05。**2.3.0 发布候选的实现与验收清单。** 用户已确认本轮开发和统计口径；现有四平台修复、UI、公告、统计与媒体失败遥测已落地。Apple Music 本轮保留 B 方案评估，测试环境与订阅账号尚未准备。实际部署提交、线上验收与 Release 状态统一记录在 [项目记录](PROJECT_MEMORY.md#230-实施与验收2026-11-05)。

## 本轮交付

- **线上基线**：2.2.0，提交 `eadef145a04b59d1cd6c1eee3820aaf0b1ed05d0`。[已发布 Release](https://github.com/znc15/MusicForUrl/releases/tag/v2.2.0)。本地候选为 2.3.0，生产迁移、自动部署和 Release 验收由发布阶段完成。
- **维护范围**：仅维护 `master`；`node` 保持 `f3830c4`、版本 2.1.1。
- **既有能力**：Cloudflare 自动部署、Workers Observability、版本一致性检查和 Release 流程继续沿用。
- **阅读顺序**：先看下表及发布验收，再查看原审计条目与 Apple Music 评估计划。原审计复现作为回归依据保留。

| 清单项 | 2.3.0 已实现结果 | 当前实现入口 |
| --- | --- | --- |
| B01 | 保留成功分页；返回总数、纳入数和部分原因；部分缓存 60 秒，重新生成立即重取；有效期来自实际签名 | [playlists.js](K:/MusicForUrl/cloudflare/src/playlists.js)、[index.js](K:/MusicForUrl/cloudflare/src/index.js)、[首页](K:/MusicForUrl/web/src/views/home.tsx) |
| B02 | 登录操作可取消，关闭、切平台/方式与新提交使旧响应失效 | [login-dialog.tsx](K:/MusicForUrl/web/src/components/login-dialog.tsx) |
| B03、B04 | 媒体元素重建时同步音量；手动播放结果按媒体元素、来源和代次核对 | [mini-player.tsx](K:/MusicForUrl/web/src/components/mini-player.tsx) |
| B05 | 区分真实零、未知、旧快照与失败；未知为 null，旧快照标 stale，首次无有效快照返回 503 | [stats.js](K:/MusicForUrl/cloudflare/src/stats.js)、[关于页](K:/MusicForUrl/web/src/views/about.tsx) |
| B06 | 永久累计含游客；估算时长记录已知/未知覆盖；账号数独立展示；全站与个人精确 30 天排行分离 | [playback-history.js](K:/MusicForUrl/cloudflare/src/playback-history.js)、[schema.sql](K:/MusicForUrl/cloudflare/schema.sql) |
| U01 | 卡片主点击进入详情，可复制地址、重新获取并播放；独立播放按钮保留 | [playlist-details.tsx](K:/MusicForUrl/web/src/components/playlist-details.tsx)、[playlist-card.tsx](K:/MusicForUrl/web/src/components/playlist-card.tsx) |
| U02 | 共享 Dialog 进入/退出动画，登录平台和方式内容短过渡，保留退出生命周期与焦点恢复 | [dialog.tsx](K:/MusicForUrl/web/src/components/ui/dialog.tsx)、[index.css](K:/MusicForUrl/web/src/index.css) |
| U03 | 平台使用分段控件，内容分类使用单行标签；窄屏横向滚动且文字不拆行 | [primitives.tsx](K:/MusicForUrl/web/src/motion/primitives.tsx)、[tabs.tsx](K:/MusicForUrl/web/src/components/ui/tabs.tsx) |
| U04、U05 | 首页输入焦点与空值反馈可见；损坏的播放链接由安全解析与字段错误处理 | [首页](K:/MusicForUrl/web/src/views/home.tsx)、[api.ts](K:/MusicForUrl/web/src/lib/api.ts) |
| U06 | 手机导航显示生成/音乐/预览/账号/关于；精简重复标题与眉题 | [sidebar.tsx](K:/MusicForUrl/web/src/components/sidebar.tsx)、[topbar.tsx](K:/MusicForUrl/web/src/components/topbar.tsx)、[page-header.tsx](K:/MusicForUrl/web/src/components/page-header.tsx) |
| U07 | 顶栏公告入口、新 ID 首次展示、本机已读和手动重开；登录优先，播放保持 | [announcement-dialog.tsx](K:/MusicForUrl/web/src/components/announcement-dialog.tsx)、[announcements.ts](K:/MusicForUrl/web/src/lib/announcements.ts) |
| P01 | 改用系统字体栈，移除界面中文网络字体请求 | [fonts.css](K:/MusicForUrl/web/src/fonts.css)、[index.css](K:/MusicForUrl/web/src/index.css) |
| E01 | 成功媒体继续跳过请求 AE，失败按标准路由和安全类别采样；完整传输校验长度、读取失败和取消 | [telemetry.js](K:/MusicForUrl/cloudflare/src/telemetry.js)、[media-transfer.js](K:/MusicForUrl/cloudflare/src/media-transfer.js) |
| R01 | 已选 B，完成源码与接口评估；独立测试环境、账号和客户端准备后继续实测 | 文末 Apple Music B 方案评估计划 |

视觉继续采用蓝色主题与亮/暗模式。界面正文使用系统字体，平台选择与内容分类保持不同层级；公告复用共享 Dialog。首版公告已写入 `release-2.3.0`，标题为“歌单复制与播放体验更新”，日期为 2026-11-05，正文介绍详情复制、弹窗与切换过渡、登录和播放状态修复。后续公告通过同一数据文件及版本发布流程维护。

## 已确认统计口径与迁移

用户已确认并采用以下口径：

- **累计有效播放请求**：覆盖账号与游客；站内媒体和 HLS 按成功完整传输、直链按成功返回 302 计入。按 `player`、`hls`、`redirect` 分类，沿用 5 分钟去重与每身份滚动一分钟 12 条限额。
- **估算播放时长**：累加有效记录当时已知的曲目时长；未知时长另记覆盖数。旧缓存的 180 秒默认值按未知处理。
- **已登录账号**：按 `users` 账号记录数计数，跨平台分别计入。
- **近期排行**：独立 30 天事件窗口，全站包含游客；个人接口按账号隔离。公开排行共用 top-50 缓存，5 分钟刷新，失败最多使用 1 小时旧快照。
- **历史数据**：保留旧账号、收藏、歌单、历史及统计行。0005 迁移建立新永久累计和事件表，`startedAt` 明确起算点；新旧派生快照使用不同 key，历史缺失保持未知。

生产升级先保存数据库导出和 Time Travel bookmark，再执行 `npm --prefix cloudflare run db:migrate -- --remote`，核对 `0005-persistent-playback-stats` ledger 和外键检查后发布。重复执行保持现有计数；回退 Worker 时保留新增表，并记录旧代码运行期间的新口径覆盖缺口。详细步骤见 [Cloudflare 指南](K:/MusicForUrl/cloudflare/README.md)。

## 发布验收与后续工作

| 范围 | 当前状态 | 发布阶段验收 |
| --- | --- | --- |
| B01—B04、U01—U06 | 已实现 | 前后端整合；部分结果恢复、迟到登录响应、静音与快速切歌；详情复制、320/375/768/1440px、键盘、焦点和减少动态效果 |
| B05、B06 | 已实现，固定样例与隔离 D1 迁移验证通过 | 备份、生产 0005 迁移；检查起算时间、累计与排行、未知/错误状态和账号隔离 |
| U07、P01 | 已实现，公告正文已写入 | 首次/已读/重开与登录优先；字体冷请求及中英文布局 |
| E01 | 已实现，媒体状态与流终态专项通过 | 发布后核对安全失败分类及成功媒体采样成本 |
| R01 Apple Music | 本轮保留评估 | 用户准备独立测试环境、订阅测试账号和 VRChat/AVPro 客户端后，按文末计划继续 |
| 版本与 Release | 2.3.0 发布准备 | 核对 package/lock/CHANGELOG 一致；完成检查、部署、线上版本和 GitHub Release 验收 |

### 已有验证与原始证据

- 后端完整回归 115/115；隔离 Wrangler 本地 D1 集成 1/1，覆盖迁移、触发器、失败回滚和重跑。新专项覆盖歌单完整性 11 项、统计 10 项、媒体遥测 9 项。完整发布检查及浏览器验收由发布阶段统一记录。
- 原始审计基线：线上 `162edb95846004c964fe307958d0c91df16c6d21`、本地 `dbb95e8`；当时检查首页、我的音乐、账号、预览和关于页，覆盖亮/暗主题及桌面、375px、320px 视口。
- 账号竞争、播放器状态与后台数据问题的原始证据来自隔离浏览器、模拟上游和内存数据库。截图见 [原审计证据目录](K:/MusicForUrl/.codex/audits/2026-11-05-ui/)。真实平台账号和 VRChat/AVPro 客户端的发布验证单独留证。
- 以下 16 个条目保留原复现、影响和优先级。**“原审计位置”中的行号对应上述审计基线；链接仅打开文件，当前实现入口以上表为准。** B01—B06、U01—U07、P01、E01 均已实现待发布验收；R01 保持评估。

## 数据完整性（原审计）

### B01 大歌单只生成部分歌曲，仍按完整结果展示

- 当前状态：2.3.0 已实现，待发布验收。
- 原状态与依据：已确认：当前代码与模拟上游/内存数据库复现。
- 原审计位置（历史行号）：[cloudflare/src/upstream/kugou.js:126-146,168-173](K:/MusicForUrl/cloudflare/src/upstream/kugou.js)；[cloudflare/src/playlists.js:100-166](K:/MusicForUrl/cloudflare/src/playlists.js)；[cloudflare/src/index.js:353-361](K:/MusicForUrl/cloudflare/src/index.js)；[web/src/views/home.tsx:268](K:/MusicForUrl/web/src/views/home.tsx)。
- 原问题描述：酷狗分页失败时会用元数据中的前 10 首覆盖已成功取得的分页。35 首歌单的复现返回 songCount=35、HTTP 200，但 M3U8 仅 10 首，部分结果缓存 86400 秒，立即重生成新增上游请求为 0。网易云、酷我的读取上限也缺少统一部分结果契约。
- 影响：核心导出缺曲，用户看到成功与原始总数，重试继续复用不完整结果。
- 严重级别：高
- 原修复方向：保留成功分页；返回 totalCount、includedCount、partialReason，结果展示“已生成 30 / 35 首”；部分结果短缓存并提供重新获取，正常完整缓存保持。
- 优先级：P1：直接影响歌单转链接的交付完整性。
- 验证方式：覆盖分页中途失败、各平台上限及恢复后重试；接口数量、页面数量与 EXTINF 条数一致。

## 账号与交互可靠性

### B02 迟到的登录响应覆盖后来选择的账号

- 当前状态：2.3.0 已实现，待发布验收。
- 原状态与依据：已确认：线上构建在隔离浏览器中使用模拟响应复现。
- 原审计位置（历史行号）：[web/src/components/login-dialog.tsx:111-124,154-167,191-204,271-288,354-369,410-414](K:/MusicForUrl/web/src/components/login-dialog.tsx)。
- 原问题描述：提交 A 后关闭弹窗，再提交 B，先返回 B 成功、再返回 A 成功。顶栏账号由“审计账号 B”变回“审计账号 A”。密码、验证码、Cookie 与酷我表单缺少统一取消/提交代次校验。
- 影响：已取消操作继续改变当前身份，用户可能在错误账号下继续收藏或生成。
- 严重级别：中
- 原修复方向：建立登录提交代次；关闭、换平台/方式或新提交时作废旧代次，API 贯通 AbortSignal；成功与错误回调均核对代次。
- 优先级：P1：当前身份必须服从用户最新操作。
- 验证方式：用假响应覆盖关闭、切平台和 A/B 先后提交；旧成功、旧错误均不改当前账号、弹窗和提示。

## 播放器可靠性

### B03 终曲结束后静音界面与实际音量不一致

- 当前状态：2.3.0 已实现，待发布验收。
- 原状态与依据：已确认：真实浏览器音频元素、受控静音音频及结束事件复现。
- 原审计位置（历史行号）：[web/src/components/mini-player.tsx:74-78,100-105](K:/MusicForUrl/web/src/components/mini-player.tsx)；[web/src/stores/player.ts:142-150](K:/MusicForUrl/web/src/stores/player.ts)。
- 原问题描述：终曲 next 推进 generation 并重建 audio，source URL 未变，音量 effect 未重新执行。复现：结束前 volume=0，结束后新元素 volume=1，界面 aria-pressed 仍为 true。
- 影响：再次播放可能突然以最大音量输出。
- 严重级别：中
- 原修复方向：在每次媒体元素重建时应用全局有效音量；将 generation 纳入 effect 或使用稳定 ref 初始化。
- 优先级：P1：直接影响声音输出与用户对静音的信任。
- 验证方式：分别以静音和 20% 音量播放单曲/终曲到结束，再次播放时 UI 与 audio.volume 保持一致。

### B04 旧曲目的手动播放错误污染新曲目

- 当前状态：2.3.0 已实现，待发布验收。
- 原状态与依据：已确认：原 store 与手动播放回调的内存受控复现。
- 原审计位置（历史行号）：[web/src/components/mini-player.tsx:139-145](K:/MusicForUrl/web/src/components/mini-player.tsx)；[web/src/stores/player.ts:178-179](K:/MusicForUrl/web/src/stores/player.ts)。
- 原问题描述：A 的 audio.play Promise 延迟拒绝，期间 B 已加载。手动 catch 调用 fail 时未传旧 generation，默认使用当前代次，导致 B 变为 error。
- 影响：快速切歌后误报“播放被浏览器阻止”，提示和实际失败对象不一致。
- 严重级别：中
- 原修复方向：捕获发起时的媒体元素、source 与 generation；只处理当前操作的失败，并区分旧操作取消。
- 优先级：P1：补齐已有播放器代次保护，避免切歌/重试误报。
- 验证方式：延迟 A 的 play Promise，切 B 后返回 AbortError/NotAllowedError；B 状态保持，当前曲目真实失败仍正常提示。

## 数据状态与错误反馈

### B05 统计缺失或刷新失败被返回为成功零值

- 当前状态：2.3.0 已实现，待发布验收。
- 原状态与依据：已确认：内存数据库与聚合失败模拟。
- 原审计位置（历史行号）：[cloudflare/src/stats.js:24-28,83-108](K:/MusicForUrl/cloudflare/src/stats.js)；[web/src/views/about.tsx:115-126](K:/MusicForUrl/web/src/views/about.tsx)。
- 原问题描述：emptyStats 将缺失填 0；所有统计行中最大的更新时间决定新鲜度。仅有新 parsedSongs 时，缺失的 plays/listeners 返回 0 且不聚合；首次聚合失败也返回 HTTP 200 和全零。
- 影响：前端未知值与重试状态无法生效，故障被显示成真实业务数据。
- 严重级别：中
- 原修复方向：缺失指标返回 null；派生指标单独判断完整性和更新时间。有旧快照时标 stale，无有效数据且聚合失败时返回明确错误。
- 优先级：P1：已公开展示的数据状态必须准确。
- 验证方式：覆盖空表、部分指标、首次失败、旧快照刷新失败和真实零值，核对 API 状态与页面 —/重试。

## 产品统计口径

### B06 累计数、人数和时长的含义与计算方式不一致

- 当前状态：2.3.0 已实现，待发布验收。
- 原状态与依据：已确认：源码与固定数据样例。
- 原审计位置（历史行号）：[cloudflare/src/playback-history.js:12-28,39-41](K:/MusicForUrl/cloudflare/src/playback-history.js)；[cloudflare/src/stats.js:58-74](K:/MusicForUrl/cloudflare/src/stats.js)；[web/src/views/about.tsx:111,122-126](K:/MusicForUrl/web/src/views/about.tsx)。
- 原问题描述：计数在单行长期累加，清理按最后播放时间整行删除。40 天前一次、今天两次的样例显示 3，闲置 31 天后降为 0。listeners 为账号数，时长为计数乘整曲时长，同曲跨歌单会重复计入 songs。
- 影响：“累计”会下降，“人数”混入多平台账号口径，“总播放时长”容易被理解为实际收听时长。
- 严重级别：中
- 原修复方向：建议分别使用持久的“累计有效播放请求”、明确标识的“估算播放时长”和“已登录账号”；近期排行使用明确周期聚合。本轮已确认并采用含游客的持久累计及独立 30 天排行。
- 优先级：P1：先确定数据含义，再调整查询与标签。
- 验证方式：固定样例验证跨月清理、同曲跨歌单、多账号、游客、未知时长；每个指标先列预期值。

## 用户新增需求

### U01 歌单卡片提供详情与复制地址，保留独立播放入口

- 当前状态：2.3.0 已实现，待发布验收。
- 原状态与依据：已确认当前行为；用户要求调整。
- 原审计位置（历史行号）：[web/src/views/user.tsx:114-117,177,197,245](K:/MusicForUrl/web/src/views/user.tsx)；[web/src/views/home.tsx:37-39](K:/MusicForUrl/web/src/views/home.tsx)；[web/src/components/playlist-card.tsx:62-78](K:/MusicForUrl/web/src/components/playlist-card.tsx)。
- 原问题描述：卡片主点击直接 openPlaylist 并跳转 /preview，列表入口缺少生成与复制地址的步骤。用户希望点进歌单后也能复制地址。
- 影响：从“我的歌单/收藏/最近播放”到外部播放器的使用路径不完整。
- 严重级别：中
- 原修复方向：推荐卡片主点击打开歌单详情面板，复用生成结果能力，提供“复制播放地址”“播放”。保留独立的一键播放按钮，展示实际纳入歌曲数和真实有效期；Apple Music 在全曲外播链路验收通过后接入同一流程，音频准备中与生成失败提供对应反馈。
- 优先级：P1：补齐项目核心“歌单转外部播放链接”的使用路径。
- 验证方式：三个列表均可查看详情、生成并复制可用链接；主点击不自动起播；独立播放按钮仍可直接播放；复制失败可选中完整地址。

### U02 登录悬浮窗缺少开关与内容切换动画

- 当前状态：2.3.0 已实现，待发布验收。
- 原状态与依据：已确认：用户截图及源码。
- 原审计位置（历史行号）：[web/src/components/ui/dialog.tsx:16-25](K:/MusicForUrl/web/src/components/ui/dialog.tsx)；[web/src/components/app-shell.tsx:71-76](K:/MusicForUrl/web/src/components/app-shell.tsx)；[web/src/components/login-dialog.tsx:425-462](K:/MusicForUrl/web/src/components/login-dialog.tsx)。
- 原问题描述：遮罩与对话框只有静态类；外层按 loginOpen 条件挂载，关闭时立即卸载。平台/登录方式切换的内容也直接替换。
- 影响：弹窗突然出现/消失，双层切换缺少连续反馈。
- 严重级别：低
- 原修复方向：复用现有动画规范：遮罩淡入淡出，对话框轻微位移/缩放，内容短淡入；调整挂载时机让退出动画完整执行，遵循减少动态效果偏好。
- 优先级：P2：视觉与反馈优化，可和登录代次修复在同一组件工作中完成。
- 验证方式：检查打开、关闭、Escape、点击遮罩、快速连点、切平台/方式；焦点陷阱、归还及减少动态模式均正常。

### U03 平台和分类切换条样式、层级与窄屏排布需要统一

- 当前状态：2.3.0 已实现，待发布验收。
- 原状态与依据：用户指出；窄屏问题已实测。
- 原审计位置（历史行号）：[web/src/components/ui/tabs.tsx:10-33](K:/MusicForUrl/web/src/components/ui/tabs.tsx)；[web/src/motion/primitives.tsx:77-137](K:/MusicForUrl/web/src/motion/primitives.tsx)；[web/src/views/user.tsx:159-165](K:/MusicForUrl/web/src/views/user.tsx)。
- 原问题描述：本条按截图中的平台、登录方式和“我的音乐”分类条记录。Segmented 与 Tabs 使用两套选中态；320px 下分类标签被拆成“我的歌/单”等两行，首页四平台出现 3+1 排布。
- 影响：切换层级混淆，窄屏阅读和点击节奏不稳定。
- 严重级别：低
- 原修复方向：保留现有蓝色主题：平台选择使用轻量分段控件，内容分类使用单行标签及统一选中指示；登录方式作为次级标签。统一尺寸/圆角/间距，小屏用可横向滚动且不拆字的标签条。
- 优先级：P2：用户明确提出的 UI 修正。
- 验证方式：亮/暗主题、320/375/768/1440px、键盘左右切换逐项验证；文字不拆行、当前项清晰可见，切换位置稳定。

### U07 增加公告悬浮窗与手动查看入口

- 当前状态：2.3.0 已实现，待发布验收。
- 原状态与依据：用户新增需求；2.3.0 已采用新公告首次展示与手动重开的交互，并写入 release-2.3.0 正文。
- 原需求涉及文件：[web/src/components/topbar.tsx](K:/MusicForUrl/web/src/components/topbar.tsx)、[web/src/components/app-shell.tsx](K:/MusicForUrl/web/src/components/app-shell.tsx)，复用 [web/src/components/ui/dialog.tsx](K:/MusicForUrl/web/src/components/ui/dialog.tsx) 与登录弹窗动画规范；已读状态沿用本地存储工具。
- 原问题描述：增加用于发布更新、维护或服务通知的公告悬浮窗，并提供随时重新查看的入口。
- 影响：用户可及时获知影响当前使用的信息，并在关闭后重新查阅。
- 严重级别：低（产品新增）
- 原修复方向：顶栏增加“公告”入口。建议首次遇到未读公告时自动展示，关闭后按公告 ID 在当前浏览器记录已读；同一公告后续通过入口手动查看，新公告再次提示。弹窗展示标题、发布日期、正文和确有用途的操作链接，复用亮/暗主题、开关动画、移动端滚动与键盘关闭。登录弹窗正在操作时延后展示公告，保持当前播放。首版通过 master 中的轻量公告数据维护，复用现有发布流程；有效公告为空时隐藏入口与弹窗。
- 优先级：P2：与 U02 的弹窗动效和公共对话框组件一起交付，减少重复实现。
- 验证方式：验证未读首次展示、关闭后刷新、同 ID 内容重访、新 ID 公告、手动重开和无公告；覆盖登录弹窗同时打开、播放中、长正文、320/375px、亮/暗主题、Escape、焦点归还及减少动态效果。浏览器存储不可用时，当前页面会话内仍避免反复自动展示。

## UI 与可访问性

### U04 首页输入框键盘焦点不可见，空提交无反馈

- 当前状态：2.3.0 已实现，待发布验收。
- 原状态与依据：已确认：浏览器计算样式与操作。
- 原审计位置（历史行号）：[web/src/views/home.tsx:116,224-252](K:/MusicForUrl/web/src/views/home.tsx)；[web/src/index.css:148](K:/MusicForUrl/web/src/index.css)。
- 原问题描述：输入框命中 :focus-visible，但 outline-style 为 none，且无焦点 ring；游客平台空输入点击生成直接返回，页面无提示。
- 影响：键盘用户难以确认当前位置；空提交表现为按钮无响应。
- 严重级别：低
- 原修复方向：给输入容器加 focus-within 样式；空提交显示字段级提示并聚焦输入，服务端错误保留在对应字段/结果附近。
- 优先级：P2：范围小、直接提升表单可用性。
- 验证方式：仅用 Tab/Enter 完成流程；空值、格式错误、网络错误均有明确且可被辅助技术读出的反馈。

## UI 与错误处理

### U05 损坏的播放链接触发未处理异常

- 当前状态：2.3.0 已实现，待发布验收。
- 原状态与依据：已确认：浏览器与解析函数复现。
- 原审计位置（历史行号）：[web/src/lib/api.ts:216-222](K:/MusicForUrl/web/src/lib/api.ts)；[web/src/views/preview.tsx:28-42](K:/MusicForUrl/web/src/views/preview.tsx)。
- 原问题描述：例如 /api/playlist/m3u8/%/123/stream.m3u8，decodeURIComponent 在 try 外抛 URIError。点击打开后浏览器报 URI malformed，界面无 alert。
- 影响：粘贴损坏或截断地址时无可操作反馈。
- 严重级别：低
- 原修复方向：将 URL 构造、匹配与解码统一纳入安全解析，由提交入口显示链接字段错误。
- 优先级：P2：明确的输入边界缺陷。
- 验证方式：覆盖 %、%ZZ、截断 UTF-8 与合法编码 grant；错误有提示，无未处理异常。

## UI 信息层级

### U06 手机导航辨识度与重复标题仍可精简

- 当前状态：2.3.0 已实现，待发布验收。
- 原状态与依据：视觉优化建议；当前呈现已检查。
- 原审计位置（历史行号）：[web/src/components/sidebar.tsx:122-169](K:/MusicForUrl/web/src/components/sidebar.tsx)；[web/src/components/topbar.tsx:21-25](K:/MusicForUrl/web/src/components/topbar.tsx)；[web/src/components/page-header.tsx:16-20](K:/MusicForUrl/web/src/components/page-header.tsx)。
- 原问题描述：手机主导航仅显示图标；顶栏标题与页面大标题重复，页面还添加 ACCOUNTS/PREVIEW/MY MUSIC 等英文眉题。
- 影响：首次使用需要猜图标，重复标题占用首屏空间。
- 严重级别：低
- 原修复方向：手机主导航保留简短可见名称；正文保留唯一主标题，顶栏用轻量位置导航；移除无助于当前操作的重复英文眉题及实现说明。
- 优先级：P2：在关键交互修复后统一处理。
- 验证方式：320/375px 首屏可识别各入口；每页一处主标题，键盘导航和读屏层级正确。

## 性能

### P01 首页字体传输量偏大

- 当前状态：2.3.0 已实现，待发布验收。
- 原状态与依据：已确认：隔离浏览器首次首页的资源计时数据。
- 原审计位置（历史行号）：[web/src/fonts.css:8-10](K:/MusicForUrl/web/src/fonts.css)；[web/src/index.css:139](K:/MusicForUrl/web/src/index.css)。
- 原问题描述：本次首次首页记录 18 个字体请求、1116160 字节传输（约 1.06 MiB）；全部资源传输 1362655 字节，字体约占 82%。这是本次浏览器测量，未做真实弱网设备基准。
- 影响：移动网络首屏下载成本偏高，字体资源也是构建并发压力来源。
- 严重级别：中
- 原修复方向：优先比较系统字体首屏方案与减少字体字重的方案；若保留品牌字体，重新规划常用界面字子集，正文与用户生成内容按需加载。
- 优先级：P2：明确的流量收益，功能修复后实施。
- 验证方式：同条件冷缓存比较字体请求、传输量、LCP 与布局偏移；检查中英文、长歌名与缺字回退。

## 可观测性

### E01 媒体失败未进入自定义 Analytics Engine 事件

- 当前状态：2.3.0 已实现，待发布验收。
- 原状态与依据：已确认：纯函数状态码复现。
- 原审计位置（历史行号）：[cloudflare/src/telemetry.js:34-35,87-90](K:/MusicForUrl/cloudflare/src/telemetry.js)；[cloudflare/src/index.js:398-399,600-603](K:/MusicForUrl/cloudflare/src/index.js)。
- 原问题描述：媒体/分片按路由一律跳过，502 同样被排除；播放事件只在成功后记录。原生 Workers Observability 已于 2.2.0 发布前启用并验证，本条记录当时缺少的自定义 Analytics Engine 失败事件与阶段分类，2.3.0 已补齐。
- 影响：原生日志已可查询请求状态和耗时；按平台/失败阶段分析媒体问题时，自定义聚合仍缺少相应事件。
- 严重级别：中
- 原修复方向：继续跳过高频成功媒体请求，记录受控抽样的失败事件及失败阶段；只用标准化路由，避开签名地址和账号凭据。
- 优先级：P2：核心功能稳定后补齐运维定位能力。
- 验证方式：模拟媒体 502、grant 失效、读取中断和主动取消；错误分类准确，成功事件成本保持。

## 平台扩展需求

### R01 新增 Apple Music

- 当前状态：本轮保留 B 方案评估；测试环境与订阅账号尚未准备，等待受控实测条件。
- 原状态与依据：用户于 2026-11-05 将首批扩展明确收敛为 Apple Music，并已选择 B：继续评估用于 VRChat/AVPro 的全曲直链。GitHub 与接口资料已检查，真实账号、音频处理及外部客户端播放尚待受控实测。
- 接入涉及文件：[cloudflare/src/platforms.js](K:/MusicForUrl/cloudflare/src/platforms.js)；[cloudflare/src/upstream/](K:/MusicForUrl/cloudflare/src/upstream/)；[web/src/lib/platform-data.js](K:/MusicForUrl/web/src/lib/platform-data.js)；[cloudflare/tests/platform-parity.test.js](K:/MusicForUrl/cloudflare/tests/platform-parity.test.js)。
- 原问题描述：当前提供网易云、QQ、酷狗、酷我四个平台；新增目标为 Apple Music 全曲外播。候选音频服务需原生运行环境，现有 Worker 导出链路实际检查 MP3 源；账号、歌单、格式与签名代理需要统一验证。
- 影响：可选音乐来源有限，新增能力必须匹配本项目的外部播放器用途。
- 严重级别：中（产品扩展）
- 原修复方向：优先验证独立 HTTP 音频服务与 Cloudflare 签名代理组合；原生处理放在独立服务，主项目继续仅维护 master，node 冻结。按文末阶段验证账号隔离、歌单与输出格式后再实施平台入口。
- 优先级：P2：先完成全曲外播可行性与资源确认，再安排正式接入。
- 验证方式：公开/私有歌单分页、storefront 地区、用户授权与退出、订阅状态、全曲/试听区分、冷/热首播、连续切歌和失败反馈；使用实际复制地址完成 VRChat/AVPro 全曲播放，并核对过期/撤销及跨账号访问。

## Apple Music 可行性调研（2026-11-05）

- **官方能力**：[MusicKit](https://developer.apple.com/musickit/) 提供目录、用户歌单和浏览器全曲播放；Web 接入需要自有 MusicKit 开发者 token，用户音乐库需要用户授权。[官方认证说明](https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit)。Catalog 返回的 `previews[].url` 是试听资源，全曲由 MusicKit 播放；官方使用约定见 [3.3.6(D)](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/)。
- **Worker 签名参考**：[anthony-liddle/apple-music-developer-token](https://github.com/anthony-liddle/apple-music-developer-token)，MIT，ES256 / jose。签名逻辑可参考；PEM helper 使用 Buffer，当前 Worker 未开 nodejs_compat，适配时应使用现有 WebCrypto 方式。
- **网页播放器参考**：[Musish/Musish](https://github.com/Musish/Musish)，React + MusicKit，主线长期未更新。根 LICENSE 为 AGPL-3.0、package 却标为 MIT，直接迁入前需处理许可证冲突与旧依赖；适合借鉴授权、队列和播放交互。
- **下载引擎参考**：[glomatico/gamdl](https://github.com/glomatico/gamdl)，MIT，Python 与 Rust 原生扩展，需有效订阅和 Cookie，部分格式另需 wrapper / FFmpeg。入口为下载 CLI，需要额外服务提供账号隔离、任务与流式交付。
- **HTTP 外播候选**：[lbr77/apple-music-api](https://github.com/lbr77/apple-music-api)，MIT，提供 `/playback/:id`、受认证保护的缓存文件与 Subsonic 音频接口。依赖 Linux/Android 原生运行环境、FFmpeg/ffprobe、持久账号状态；原生任务先生成缓存文件再返回音频，当前输出以 m4a/ALAC 为主。现有 Worker 的 MP3 Packed Audio 导出链路还需格式/封装和签名代理适配；仓库提示了非标准环境的账号风险。参考 [API 文档](https://github.com/lbr77/apple-music-api/blob/main/API.md)。
- **已选方向**：用户已选择 B，全曲直链用于 VRChat/AVPro；继续验证独立服务路线。官方 MusicKit 与网页播放器资料保留为认证/目录参考。
- **验收覆盖**：已完成官方文档、仓库 README/许可证/依赖与关键 HTTP 实现检查；第三方服务运行、真实 Apple 账号、全曲输出和 VRChat/AVPro 实播待测试环境与账号参与后验证。

## Apple Music B 方案评估计划

### 候选服务的实际缺口

本次进一步检查 `lbr77/apple-music-api` 提交 `3eb3b4a0b43d563ad4abee8513c26f73ea0755ce`。它适合作为独立音频服务的验证起点，正式接入需要处理以下契约：

| 项目 | 已确认事实 | 评估动作 |
| --- | --- | --- |
| 账号 | 一个 daemon 共用一个活跃 session；已有会话时再次登录返回 409，登录/2FA 更新全局会话 | 先用单账号隔离实例验证链路；正式多用户方案评估实例隔离成本或会话改造，保留每个用户的身份与缓存归属 |
| 歌单 | 已查 HTTP 路由只有搜索、艺人、专辑、歌曲等；缺少歌单详情/曲目分页入口，Subsonic 也缺少对应歌单接口 | 单独验证公开与私有歌单的曲目读取和分页，给每次请求保留账号与地区上下文 |
| 音频鉴权 | `/cache` 与 API 共用服务级 Bearer 鉴权 | 上游凭据保存在服务端；对外使用本站限时签名地址，逐次检查账号、歌单与曲目归属，跳转时限制凭据转发目标 |
| 冷请求 | `/playback/{id}` 等待原生下载完成后返回；`redirect=true` 同样等待，现成契约未提供排队任务状态 | 测量冷/热首播和连续切歌；超过现有请求预算时，评估生成阶段的准备状态与缓存预取方式 |
| 格式 | Subsonic 支持列表包含 raw/m4a/mp4/aac/alac/lossless，MP3 被拒绝；普通 playback 的底层 MP3 支持尚未验证 | 优先验证独立服务输出实际 MP3后复用当前 Packed Audio；核对真实格式/码率、长度、HEAD与Range行为 |

源码证据：[账号与登录](https://github.com/lbr77/apple-music-api/blob/3eb3b4a0b43d563ad4abee8513c26f73ea0755ce/crates/apple-music-downloader/src/daemon/http/account.rs#L71-L157)、[路由与鉴权](https://github.com/lbr77/apple-music-api/blob/3eb3b4a0b43d563ad4abee8513c26f73ea0755ce/crates/apple-music-downloader/src/daemon/http/mod.rs#L15-L38)、[播放响应顺序](https://github.com/lbr77/apple-music-api/blob/3eb3b4a0b43d563ad4abee8513c26f73ea0755ce/crates/apple-music-downloader/src/daemon/http/catalog.rs#L294-L363)、[Subsonic 格式检查](https://github.com/lbr77/apple-music-api/blob/3eb3b4a0b43d563ad4abee8513c26f73ea0755ce/crates/apple-music-downloader/src/daemon/subsonic/service.rs#L208-L231)。本项目约束见 [MP3 封装检查](K:/MusicForUrl/cloudflare/src/packed-audio.js)和[现有缓存实现](K:/MusicForUrl/lib/player-cache.js)。

### 验证顺序与完成条件

1. **单曲技术验证**：在隔离环境中由用户自行登录测试账号，验证曲目 ID → 音频准备 → 服务端鉴权读取 → 合适的 MP3 输出。记录冷下载/处理时间、热缓存时间、文件大小和编码，区分全曲与试听。
2. **本站直链验证**：验证签名 URL、过期/撤销、HEAD、媒体完整长度、读取中断与失败反馈。服务级 token 留在服务端；日志与复制链接只包含必要的受控信息。已有其他平台入口继续可用。
3. **歌单与多用户验证**：读取一个短歌单及一个需分页的歌单，核对完整曲目和地区差异；验证账号切换、私有列表、缓存归属与退出后的处理。单账号技术验证完成后，继续满足项目的多账号使用契约。
4. **VRChat/AVPro 验收**：将实际生成的 HTTPS 地址复制到目标播放器，验证完整播放、至少跨越两次切歌、冷/热首播、重试及链接失效；记录客户端、模式、时间和现象。浏览器验证与客户端实播分别留证。
5. **形成实施结论**：汇总可用能力、未通过项、账号/授权条件、主机与缓存成本、需要修改的接口及回归范围。通过后再安排正式开发、版本递增和 Release；候选失败时继续按同一全曲外播目标筛选下一实现。

### 实测依赖与责任

- **用户确认**：隔离测试主机及可执行的安装/运行范围、订阅测试账号的使用与分享授权、VRChat/AVPro 客户端参与方式；账号密码和 2FA 由用户自行操作。
- **开发者完成**：固定候选提交、准备测试清单、核对协议/缓存/账号隔离、记录实际结果并更新实施结论。本轮保留源码评估与文档结果，实测环境和账号尚未准备。
- **恢复实测的条件**：用户确认测试环境和操作范围、账号准备完成。现有四平台、UI、统计和公告已纳入 2.3.0 实现，Apple Music 实测独立续接。
