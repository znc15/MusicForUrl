# Cloudflare 免自管服务器版

本指南随 `codex/cloudflare` 维护。Node.js / Docker 代码保存在 `codex/nodejs-frozen`，运行方式见[冻结基线 f3830c4 的原始文档](https://github.com/znc15/MusicForUrl/blob/f3830c4/README.node-docker.md)。

当前主域名：[https://music.nyasakura.com/](https://music.nyasakura.com/)；根域名 [https://nyasakura.com/](https://nyasakura.com/) 与原 `workers.dev` 地址 [https://music-for-url.miaofile.workers.dev/](https://music-for-url.miaofile.workers.dev/) 暂时保留为回退。配置中的 D1 ID 和 `routes` 属于这个站点；在其他 Cloudflare 账号部署时，需要创建自己的 D1 并替换 ID，删除现有 `routes` 或改成自己的域名。先使用 `workers.dev` 地址即可，无需复制本站 SaaS/DNS 配置。

`music.nyasakura.com` 通过 Cloudflare for SaaS 自定义主机名进入 `music.nyasakura.com/*` Worker Route。根域名仍为 Worker Custom Domain；配置显式保留 `workers_dev` 地址。已启用免费的 Smart Placement 试运行，它会根据流量决定 API Worker 的执行位置；静态资源仍由靠近访客的边缘节点提供。Smart Placement 需要一段时间和来自不同位置的请求才能给出优化结果，不能把启用本身当作速度提升。

### 域名、证书和优选入口

`nyasakura.com` 仍托管在 Cloudflare。2026-10-05 控制台中 SaaS 回退源 `fallback-music.nyasakura.com`、自定义主机名 `music.nyasakura.com` 和其证书均显示“有效”。Worker Route 仍由 `wrangler.jsonc` 管理。DNS 记录如下：

| 名称 | 类型与目标 | 代理状态 | 用途 |
| --- | --- | --- | --- |
| `music` | CNAME `cdn-music.nyasakura.com` | 仅 DNS | 公开入口 |
| `cdn-music` | CNAME `cf-cname.xingpingcn.top` | 仅 DNS | 优选入口中转 |
| `fallback-music` | AAAA `100::` | 已代理 | SaaS 回退源，由 Worker Route 接管请求 |
| `_cf-custom-hostname.music` | TXT，使用控制台给出的主机名预验证值 | 仅 DNS | SaaS 主机名所有权验证 |
| `_acme-challenge.music` | CNAME `music.nyasakura.com.68fddbf02cc9e6ae.dcv.cloudflare.com` | 仅 DNS | Cloudflare DCV 委派，自动处理证书续期 |

`cf-cname.xingpingcn.top` 是第三方维护的 DNS 优选目标。它在切换时能从国内公共 DNS 解析到 Cloudflare IP，且 `music` 的主页、API、M3U8 与音频地址均通过了实际请求验证；**没有从中国电信、联通、移动用户线路测得加速幅度**。该目标的解析或维护状态可能变化，应定期检查。更换 Cloudflare 账号时，也要在新账号控制台重新取得 DCV 委派目标。

若优选入口出现 403、证书错误或播放失败，可先把 `music` 记录改回 CNAME `2f1343c8-5c9f-40dd-9784-3a0c2afe34e1.cfargotunnel.com` 并开启代理；这是切换前的 Fnos Tunnel 记录。保留 `music.nyasakura.com/*` Worker Route 即可继续由 Worker 响应。回滚后检查 `/api/health`、登录状态、M3U8 和音频请求，再排查 SaaS/DNS。不要改动其他 Tunnel 记录。

这个版本用 **Cloudflare Workers Static Assets + Worker API + D1** 运行 MusicForUrl。网页源码位于 `web/`，构建到 `web/dist`；登录、歌单解析、签名链接、收藏和播放记录由 Worker 处理，账号 Cookie 经 AES-GCM 加密后存入 D1。无需 VPS、Docker 或常驻 Node 进程。

Cloudflare 目前建议新项目使用 Workers Static Assets；若你习惯 Pages，可把它理解为同类的静态资源加边缘函数部署方式。[Cloudflare 官方说明](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/#use-workers-static-assets-for-new-projects)

## 功能边界

| 功能 | Cloudflare 版 |
| --- | --- |
| 网易云、QQ 音乐、酷狗扫码或 Cookie 登录 | 保留；网易云还支持手机验证码和密码登录；酷狗只有扫码；酷我支持账号密码 / 手机短信 |
| 用户歌单、链接解析、收藏、最近播放 | 保留，数据写入 D1 |
| 轻量 M3U8 | 保留，MP3 分片通过本站流式提供，并添加 Packed Audio 的 ID3 时间戳 |
| VIP 歌曲 | 取决于登录账号的真实权限和平台接口返回值 |
| HLS 视频转码、MP4、随机背景视频 | 不提供；Workers 无法运行原来的 FFmpeg 子进程 |
| 站点访问密码和 HLS 缓存管理 | 不提供；账号接口仍需登录令牌 |

轻量 M3U8 使用 [RFC 8216 第 3.4 节](https://www.rfc-editor.org/rfc/rfc8216.html#section-3.4)的 MP3 Packed Audio 分片。分片添加 `com.apple.streaming.transportStreamTimestamp` ID3 PRIV 时间戳，并通过同一站点域名流式输出。每首歌之间保留 `EXT-X-DISCONTINUITY`，媒体时间戳从零开始；此模式不进行音频转码或生成视频画面。分片为完整歌曲文件，不提供字节范围分片，普通 `Range` 请求返回完整的 200 响应；HEAD 只读取少量源数据并返回正确的完整长度。流式代理会使音频数据经过 Worker。

VRChat / 台 K 播放轻量音频 M3U8 时优先选择 **AVPro / Stream / 流媒体** 模式，并粘贴生成的 `stream.m3u8` 直链。2026-10-07 的 PC 台 K 用户实测确认切换 AVPro 后可以播放；其他世界与 Quest / 安卓仍需实际验证。若出现 `Requested format is not available`，先检查模式；视频模式可能过滤掉音频 HLS。只有视频模式的房间需要世界作者增加 AVPro，或改用自有服务器的真实视频输出；修改文件后缀或 MIME 不会生成视频轨道。参见 [VRChat 官方播放器说明](https://creators.vrchat.com/worlds/udon/video-players/)。

公开／群组公开房间还要求世界作者将媒体域名加入 `Video Player Allowed Domains`，并由用户启用 `Allow Untrusted URLs`，见 [VRChat 官方域名规则](https://creators.vrchat.com/worlds/udon/video-players/www-whitelist/)。把自有链接放入第三方 `?url=` 参数，不代表该服务支持解析它，也不保证最终媒体域名被允许。生成的播放链接默认有效 **24 小时**，最长可配为 48 小时；退出登录会立即撤销已生成链接。

网易云播放地址优先使用新版 `song_url_v1` 接口；若未返回可播放地址，会回退到原码率接口。`MUSIC_QUALITY=medium` 保留原有 192 kbps 接口，因为新版没有对应的 192 kbps 档位。

Cloudflare 仅支持 `MUSIC_QUALITY=low/medium/high` 的 MP3 音质。旧配置 `lossless` 自动映射为 `high`，网易云使用 `exhigh`（回退接口为 320 kbps），QQ 音乐使用 `M800...mp3`；不会请求 FLAC。QQ 音质显式使用 Worker 配置。

### 登录认证与请求体限制

网易云登录令牌仅从 `x-token` 请求头读取，QQ 音乐仅从 `x-qq-token`、酷狗仅从 `x-kugou-token` 读取；URL 查询参数 `token` / `qqtoken` 不参与登录认证或退出登录。退出接口保留 JSON 请求体中的显式令牌兼容方式。播放链接仍使用独立的签名令牌。

JSON 请求体按实际读取字节限制为 65,536 字节，不依赖 `Content-Length`。流式或分块请求超过上限会被取消并返回 HTTP 413。

### 播放历史与保留

- HLS 音频分片完整读取后才计入；HEAD、传输失败和主动取消不计入。直链模式在成功返回音频地址时计入。这些记录不代表已经完整收听。
- 同一账号、歌单和歌曲在 5 分钟内的重复请求合并为一条；每个账号每分钟最多新增 12 条，超过时仍可播放。
- 记录以 `(用户, 歌单, 歌曲)` 聚合存入 `play_stats`：**一次计入的播放只写一行**，重复播放累加 `play_count` 并刷新 `last_played_at_ms`，不再追加事件行。去重与每分钟限额由 INSERT 的 WHERE 守卫判断，被拒的播放不产生任何写入。
- 保留策略按 `last_played_at_ms` 判断，保留 30 天。最近播放和热门歌曲统计只读取 30 天内的记录。每天 UTC 03:17 的 Cron 全站清理过期记录，同时清理 `playlists`、`song_sources`、`rate_limits` 与 `qr_sessions`。

这样做的原因：旧实现每次播放执行 3 条语句，其中裁剪语句会扫描 1,000–2,000 行，一次 30 首歌的播放约消耗 **45,000 行读取**，对免费版每天 500 万行只够约 110 次播放。改为聚合后每次播放约 450 行读取、30 行写入。

**升级顺序（重要）**：`npm run db:remote`（建表，幂等）→ `npm run db:backfill`（把旧 `play_logs` 聚合成 `play_stats`，**必须在部署新版 Worker 之前执行一次**）→ `npm run db:migrate:stats`（给 `play_stats` 加 `duration_ms` 并建 `site_stats`，**同样必须在部署前执行**，否则 `recordPlayback` 会因为缺列整条失败）→ `npm run db:migrate:qr`（重建 `qr_sessions`，去掉只允许 netease/qq 的 CHECK，**必须在酷狗扫码登录上线前执行**）→ `npm run deploy`。`play_logs` 暂时保留以便回填，观察一个版本后可删除。`schema.sql` 可重复执行，不清空账号、歌单或收藏；新库直接用它即可，不需要跑迁移。

### 站点统计

「关于」页的数字来自 `site_stats`，写入路径刻意分两类：

- **实时累加**：`parsedSongs`（每次解析到歌单时按曲目数累加）与 `generatedLinks`（每次签发播放链接累加）。旧版前端的 `/parse` + `/url` 与新前端的 `/generate` 都会计数，批量写入一次，不进入播放路径。这两个计数器从 2.1.0 开始计数：更早的请求没有留下可精确重建的记录，因此不做估算回填。
- **聚合派生**：累计播放、总播放时长、收录曲目、歌单数与使用人数，从 `play_stats` 与 `users` 汇总。这是一次全表扫描，因此只在 Cron（每天 UTC 03:17，在清理之后）与惰性刷新时执行。

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `STATS_REFRESH_MINUTES` | 派生统计的最小刷新间隔；调大可以降低扫描成本，代价是数字变旧 | `60` |

游客播放（酷我，以及未登录的酷狗）没有 `users` 行，播放不写 `play_stats`，但会写入 Analytics Engine，因此仍计入匿名汇总。播放记录、收藏与歌单缓存的账号归属规则见 [平台与账号模型](PLATFORMS.md#多账号与数据归属)。

### 配额、降级与可观测性

免费版的关键上限：Worker 请求 **10 万/天**、CPU **10 ms/次调用**、D1 行读取 500 万/天、行写入 10 万/天（**超额直接报错**，自 2026-09-01 起）、R2 Class A 100 万/月。静态资源请求由 assets 层直接返回，**不要放宽 `run_worker_first: ["/api/*"]`**，否则静态资源会开始计费。

一次 30 首歌的播放约消耗 31 次 Worker 请求与 30 次 D1 写入，因此免费版的实际上限约 **3,200 次播放/天**，请求数、D1 写入与 AE 数据点同时卡在这个数量级。

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `DEGRADE_MODE` | `normal` / `links-only` / `shed` | `normal` |
| `AUDIO_CACHE_FILL_RATE` | R2 缓存填充抽样比例，额度吃紧时降低 | `1` |
| `RESOLVE_CACHE` | `cache_api` 或 `d1`；无 Cache API 时自动回退 | `cache_api` |
| `PLAYLIST_TRACK_CAP` | 单歌单解析上限，防止超大歌单 JSON 超出 10 ms CPU | `1000` |
| `GUEST_PLAYLIST_MAX_PAGES` | 游客平台（酷狗）歌单最多拉取多少页，每页 30 首 | `16` |
| `KUWO_COOKIE` | 酷我歌单接口被风控拒绝时，贴一份浏览器 Cookie 绕过引导 | 空 |
| `REQUEST_TELEMETRY_SAMPLE` | 控制面请求遥测抽样比例 | `10` |
| `STATS_REFRESH_MINUTES` | 站点统计派生指标的最小刷新间隔 | `60` |
| `DEPLOY_VERSION` | 写入遥测的版本标记 | 空 |

降级优先级是刻意的：额度是硬上限，一旦耗尽所有人都播不了，所以余量优先留给已经在看的人。`links-only` 通过 `/api/player/capabilities` 的 `degraded` 字段让前端隐藏站内播放器（每首歌 2 次请求降到 1 次）；`shed` 只让 `/playlist/parse`、`/playlist/url`、`/playlist/generate` 返回 503 与 `Retry-After`，**已签发的 M3U8 链接继续可用**。

遥测写入 Analytics Engine 的 `mfu_playback`（每次计入的播放一个数据点）与 `mfu_requests`（控制面请求，默认 1/10 抽样，媒体与分片请求不记）。**AE 不承载正确性**：绑定缺失、写入失败或超额都只影响分析数据，UI 读取一律走 D1。在 Dashboard 关注 Requests/day、CPU p50/p99、D1 Rows read/written 与 **R2 Class A**（冷播放每次歌单产生 30 次填充写入，未加护栏时月度额度会在月初被打满）。

`/api/health` 返回 `{ status, degradeMode, version, features }`，可接入外部免费探活监控。建议同时为请求数、错误率、D1 读写与 R2 Class A 配置 Dashboard 通知。

### 音源解析缓存

音源地址只活 90 秒，放进 D1 会让每次解析都产生一次写入。改为写入 Cache API（键为 `https://resolve.mfu.internal/<sha256>`，**必须是绝对 URL**，裸哈希会被 Cache API 拒绝），命中时零 D1 读写。缓存键只到账号维度：`token_hash` 会在重新登录或退出时轮换，把它写进键里会让整个缓存失效。没有 Cache API 的环境（例如 `node --test`）自动回退到 `song_sources` 表。

## 工作台界面

Cloudflare 版前端位于仓库根目录的 `web/`：**React + Vite + Tailwind + shadcn/ui**，构建产物 `web/dist` 由 Worker 的 `assets` 绑定提供。静态资源请求由 assets 层直接返回、不计入 Worker 请求数，因此前端体积不影响免费额度，只影响首屏速度。视图按路由分包，`hls.js` 只在预览页真正打开 HLS 源时才按需加载。

左侧导航统一提供链接生成、我的音乐、媒体预览、账号管理和关于页面；收起时底部只保留一个跟随当前平台的账号头像、外观与音量入口和展开按钮。窄屏显示紧凑导航；页面、列表、分段控件与弹窗由 `motion`（framer-motion）控制，并响应系统的减少动态效果设置，详见[动画说明](ANIMATION.md)。界面延续天蓝与白色调色板与亮暗主题，但改用实色卡片、1px 边框与 2px 小圆角，不再使用玻璃拟态。

字体使用 **HarmonyOS Sans SC**，字库由 `cn-font-split` 按 `unicode-range` 切成多个 woff2 子集（只引入 400 / 500 / 600 三档），浏览器按页面实际用字下载，并带 `font-display: swap` 避免首屏空白。构建脚本用 `cross-env` 强制 `NODE_ENV=production`，避免误打开发版 React；首页直接进入主包，其余路由、播放条与登录弹窗按需加载，依赖拆成 react、radix、sonner、icons 等长缓存块。

`web/public/_headers` 负责静态资源的缓存策略：`/assets/*`（带内容哈希）永久缓存，其余路径（HTML 与 SPA 回退）为 `max-age=0, must-revalidate` 并额外带 **`no-transform`**——最后一个指令让 Cloudflare 边缘不改写 HTML，从而不会自动注入 Web Analytics 的 `beacon.min.js`（本站统计走自己的 Analytics Engine，不需要它）。注意 `_headers` 的规则按文件顺序应用，后面的规则会覆盖同名头，所以通配规则写在最前、具体路径写在最后，否则两个 `max-age` 会被逗号拼成无效值。

账号管理连接两个平台的现有登录状态，每个平台保留一个当前登录账号。可以重新登录以切换账号、选择常用平台、退出登录，并保存本机名称和备注。名称和备注以平台及账号 ID 为键保存到浏览器；不会修改音乐平台资料，也不跨设备同步。新前端保留了旧版全部 `localStorage` 键（`token`、`qqToken`、`theme`、`generatorPlatform`、`personalPlatformTab`、`mfu:player-quality`、`mfu:account:<platform>:<userId>`），因此升级不会让已登录用户掉线。

预览支持 HTTPS 媒体直链和本地视频／音频文件，以及粘贴本站生成的 `stream.m3u8` 链接。本站歌单由页面底部的常驻播放器控制，切换路由不会中断播放。本地文件使用 Object URL，不会上传。

**回滚**：保留前一次可用的 Cloudflare 部署版本，需要恢复时回滚该 Worker 版本及其静态资源。数据库迁移与 Secret 变更单独核对；冻结的 Node.js 分支使用独立运行方式。

## 本地验证

建议使用 Node.js 24+（仓库测试使用 Node 24）。以下命令从仓库根目录运行：

```powershell
npm --prefix web ci
npm --prefix cloudflare ci
Copy-Item cloudflare/.dev.vars.example cloudflare/.dev.vars
```

把 `cloudflare/.dev.vars` 中的 `ENCRYPTION_KEY` 改为独立生成的至少 32 字符随机密钥。占位值会被程序拒绝。然后运行：

```powershell
npm --prefix cloudflare run db:local
npm run dev
npm test
npm run check
npm run build
```

本地开发默认使用 Wrangler 的本地 D1 数据，不会修改远端数据库。生产密钥的本机备份为 Git 忽略的 `.dev.vars.production`；请将它备份到你自己的安全位置，避免丢失后无法解密已保存的账号 Cookie。

## 首次部署

本站已完成首次部署。完成上面的前端与 Worker 依赖安装后，以下步骤适用于新的 Cloudflare 账号，命令均在 `cloudflare/` 目录执行：

1. 登录 Wrangler：`npx wrangler login`。
2. 创建 D1：`npx wrangler d1 create music-for-url`。把返回的 `database_id` 填进 `wrangler.jsonc`，保留 `DB` 绑定名。
3. 删除 `wrangler.jsonc` 中本站的 `routes`，保留 `workers_dev: true`；如需自定义域名，使用自己账号下的域名配置。
4. 初始化远端表：`npm run db:remote`。
5. 从 `.dev.vars.example` 复制出 Git 忽略的 `.dev.vars.production`，将 `ENCRYPTION_KEY` 改为独立的至少 32 字符随机密钥，并安全备份。
6. 执行 `npm run build:assets`，再用 `npx wrangler deploy --secrets-file .dev.vars.production` 同时发布 Worker 与密钥。这里直接调用 Wrangler，需要先手动构建静态依赖。以后代码更新使用 `npm run deploy` 即可自动构建并保留已有密钥。

可在 Cloudflare 的 Worker 设置中添加 `TOKEN_TTL_HOURS`、`PLAYBACK_TOKEN_TTL_SECONDS`、`CACHE_TTL`、`MUSIC_QUALITY` 等可选变量。密钥应设置为 **Secret**，不要写入 `wrangler.jsonc` 或 Git。

## 私有 R2 缓存

`AUDIO_CACHE` 绑定指向私有桶，`AUDIO_CACHE_ENABLED=true` 启用；当前站点使用专用 `music-for-url-private-cache`。在其他账号部署时先创建桶并更换绑定；不启用则删除绑定并设 `false`。

```sh
npx wrangler r2 bucket create music-for-url-private-cache
npx wrangler r2 bucket lifecycle add music-for-url-private-cache expire-audio --prefix audio/v2/ --expire-days 1
npx wrangler r2 bucket lifecycle add music-for-url-private-cache expire-cover --prefix cover/v2/ --expire-days 2
```

音频逻辑缓存 1 小时、封面 24 小时，生命周期分别 1 天 / 2 天。音频键包括账号、会话、实际音质、格式与试听状态；读取先验证签名、歌单归属和当前音源，再读缓存。退出撤销旧链接。仅缓存完整音频（最多 16 MiB）与封面（最多 2 MiB），单 isolate 同时填充一个对象。Range 首次请求可能另行下载完整对象；错误、大文件和未知长度回退代理。

网页歌单使用 `/api/player/*` 原生逐首播放，返回实际格式、码率和降级提示，支持 Range。导出 M3U8 保持 Packed Audio，不能对添加 ID3 的完整片段使用原音频字节范围。二者复用缓存。R2 不公开，响应 `private, no-store`，`x-mfu-cache` 用于检查命中。

部署前执行 `npm run db:remote` 添加 `song_sources`，其音源有效期最多 90 秒，Cron 清理过期项。选型和费用见[技术对比](../website/guide/architecture.md)。

## Pages 兼容部署与官网

Pages Functions 入口在仓库根目录 `functions/[[path]].js`，配置为 `cloudflare/wrangler.pages.jsonc`，静态产物统一使用 `web/dist`。从仓库根目录部署，以便 Wrangler 同时发现 `functions/`。设置 D1 / R2 和 Secret，定时清理另配维护 Worker；推荐 Workers Static Assets。步骤见[部署指南](../website/guide/deployment.md)。

官网在 [GitHub Pages](https://znc15.github.io/MusicForUrl/) 发布，构建前自动同步项目 README、Cloudflare 和动画说明三份文档。冻结版 Node.js / Docker 文档使用基线提交链接，不生成副本。`.github/workflows/website.yml` 在维护分支推送后自动构建和发布。

## 迁移说明

从冻结的 Express/SQLite 版本迁移时，需要重新登录，收藏和历史从新数据库开始；如需保留旧数据，应另行准备受控导入。Cloudflare 分支保留 `cloudflare/src/`、`cloudflare/schema.sql`、`lib/player-*.js` 策略 / API / 代理、`lib/qqmusic.js`、`web/` 和 Pages 兼容入口 `functions/`。

网易云、QQ 音乐、酷狗与酷我的接口并非 Cloudflare 平台服务，可能随上游接口或风控变化而失效。部署后应分别用真实账号验证扫码、歌单解析、音频地址和播放器行为；酷狗扫码登录的签名算法也随 Web 前端发版变化，失效时先看 `kugou-login.js`。
