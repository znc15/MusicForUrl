# Cloudflare 免自管服务器版

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

这个版本用 **Cloudflare Workers Static Assets + Worker API + D1** 运行 MusicForUrl。网页仍在仓库的 `public/`；登录、歌单解析、签名链接、收藏和播放记录由 Worker 处理，账号 Cookie 经 AES-GCM 加密后存入 D1。无需 VPS、Docker 或常驻 Node 进程。

Cloudflare 目前建议新项目使用 Workers Static Assets；若你习惯 Pages，可把它理解为同类的静态资源加边缘函数部署方式。[Cloudflare 官方说明](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/#use-workers-static-assets-for-new-projects)

## 功能边界

| 功能 | Cloudflare 版 |
| --- | --- |
| 网易云、QQ 音乐扫码或 Cookie 登录 | 保留；网易云还支持手机验证码和密码登录 |
| 用户歌单、链接解析、收藏、最近播放 | 保留，数据写入 D1 |
| 轻量 M3U8 | 保留，MP3 分片通过本站流式提供，并添加 Packed Audio 的 ID3 时间戳 |
| VIP 歌曲 | 取决于登录账号的真实权限和平台接口返回值 |
| HLS 视频转码、MP4、随机背景视频 | 不提供；Workers 无法运行原来的 FFmpeg 子进程 |
| 站点访问密码和 HLS 缓存管理 | 不提供；账号接口仍需登录令牌 |

轻量 M3U8 使用 [RFC 8216 第 3.4 节](https://www.rfc-editor.org/rfc/rfc8216.html#section-3.4)的 MP3 Packed Audio 分片。分片添加 `com.apple.streaming.transportStreamTimestamp` ID3 PRIV 时间戳，并通过同一站点域名流式输出。每首歌之间保留 `EXT-X-DISCONTINUITY`，媒体时间戳从零开始；此模式不进行音频转码或生成视频画面。分片为完整歌曲文件，不提供字节范围分片，普通 `Range` 请求返回完整的 200 响应；HEAD 只读取少量源数据并返回正确的完整长度。流式代理会使音频数据经过 Worker。

VRChat 的具体播放能力仍取决于播放器后端。公开／群组公开房间还要求世界作者将媒体域名加入 `Video Player Allowed Domains`，并由用户启用 `Allow Untrusted URLs`，见 [VRChat 官方域名规则](https://creators.vrchat.com/worlds/udon/video-players/www-whitelist/)。把自有链接放入第三方 `?url=` 参数，不代表该服务支持解析它，也不保证最终媒体域名被允许。生成的播放链接默认有效 **24 小时**，最长可配为 48 小时；退出登录会立即撤销已生成链接。

网易云播放地址优先使用新版 `song_url_v1` 接口；若未返回可播放地址，会回退到原码率接口。`MUSIC_QUALITY=medium` 保留原有 192 kbps 接口，因为新版没有对应的 192 kbps 档位。

Cloudflare 仅支持 `MUSIC_QUALITY=low/medium/high` 的 MP3 音质。旧配置 `lossless` 自动映射为 `high`，网易云使用 `exhigh`（回退接口为 320 kbps），QQ 音乐使用 `M800...mp3`；不会请求 FLAC。QQ 音质显式使用 Worker 配置，原 Node.js 服务仍可使用自身的无损设置。

### 登录认证与请求体限制

网易云登录令牌仅从 `x-token` 请求头读取，QQ 音乐仅从 `x-qq-token` 读取；URL 查询参数 `token` / `qqtoken` 不参与登录认证或退出登录。退出接口保留 JSON 请求体中的显式令牌兼容方式。播放链接仍使用独立的签名令牌。

JSON 请求体按实际读取字节限制为 65,536 字节，不依赖 `Content-Length`。流式或分块请求超过上限会被取消并返回 HTTP 413。

### 播放历史与保留

- HLS 音频分片完整读取后才计入；HEAD、传输失败和主动取消不计入。直链模式在成功返回音频地址时计入。这些记录不代表已经完整收听。
- 同一账号、歌单和歌曲在 5 分钟内的重复请求合并为一条；每个账号每分钟最多新增 12 条，超过时仍可播放。
- 每个账号保留最近 30 天、最多 1,000 条。写入时使用 D1 batch 事务，去重和限额判断在 INSERT 中执行；同时清理该账号过期和超量记录。
- 最近播放和热门歌曲统计只读取 30 天内保留的记录。每天 UTC 03:17 的 Cron 全站清理过期记录，包括近期未播放的账号。

现有部署升级时先运行 `npm run db:remote` 添加日志索引，再运行 `npm run deploy` 发布新代码和 Cron。`schema.sql` 可重复执行，不清空账号、歌单或收藏。D1 事务和定时任务参考 [D1 batch 文档](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)与 [Cron Triggers 文档](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。

## 工作台界面

左侧导航统一提供链接生成、我的音乐、视频预览、账号管理和关于页面。窄屏显示紧凑导航；页面、面板与导航指示器继续由 GSAP 统一控制，并响应系统的减少动态效果设置。

账号管理连接两个平台的现有登录状态，每个平台保留一个当前登录账号。可以重新登录以切换账号、选择常用平台、退出登录，并保存本机名称和备注。名称和备注以平台及账号 ID 为键保存到浏览器；不会修改音乐平台资料，也不跨设备同步。

预览支持 HTTPS 媒体直链和本地视频／音频文件。M3U8 优先使用同站点打包的 Hls.js，不支持 MediaSource 的浏览器回退到原生 HLS；生成结果提供预览入口。外部 HLS 源需要允许跨域请求；本地文件使用 Object URL，不会上传，离开预览页时销毁播放器并释放资源。关于页面的版本信息从构建生成的 `app-meta.json` 读取。

## 本地验证

建议使用 Node.js 24+（仓库测试使用 Node 24）。以下命令在 `cloudflare/` 目录运行：

```powershell
npm ci
Copy-Item .dev.vars.example .dev.vars
```

把 `.dev.vars` 中的 `ENCRYPTION_KEY` 改为独立生成的至少 32 字符随机密钥。占位值会被程序拒绝。然后运行：

```powershell
npm run db:local
npm run dev
npm test
```

本地开发默认使用 Wrangler 的本地 D1 数据，不会修改远端数据库。生产密钥的本机备份为 Git 忽略的 `.dev.vars.production`；请将它备份到你自己的安全位置，避免丢失后无法解密已保存的账号 Cookie。

## 首次部署

本站已完成首次部署。以下步骤适用于新的 Cloudflare 账号，命令均在 `cloudflare/` 目录执行：

1. 安装锁定依赖：`npm ci`，并登录 Wrangler：`npx wrangler login`。
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

## 双部署与官网

Node.js 版本共用播放器 API、音质策略与流代理，以 SQLite / 可选磁盘缓存运行，支持浏览器可解码的 FLAC，旧 FFmpeg 输出保留。两种环境的认证签名和加密数据不能直接互换。

Pages Functions 入口在根目录 `functions/[[path]].js`，配置为 `wrangler.pages.jsonc`。必须设置 D1 / R2 和 Secret，定时清理另配维护 Worker；推荐 Workers Static Assets。步骤见[部署指南](../website/guide/deployment.md)。

官网仅在 [GitHub Pages](https://znc15.github.io/MusicForUrl/) 发布，构建前自动同步仓库四份文档，`.github/workflows/website.yml` 自动构建和发布。

## 迁移说明

旧版 Express/SQLite 数据不会自动导入 D1，需要重新登录，收藏和历史从新数据库开始。`server.js`、`routes/` 与 `deploy/` 继续支持自有服务器。Cloudflare 使用 `cloudflare/src/`、`cloudflare/schema.sql`、共享 `lib/player-*.js` 策略 / API / 代理、`lib/qqmusic.js` 与 `public/`。

网易云与 QQ 音乐接口并非 Cloudflare 平台服务，可能随上游接口或风控变化而失效。部署后应分别用真实账号验证扫码、歌单解析、音频地址和播放器行为。
