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

## 迁移说明

旧版 Express/SQLite 数据不会自动导入 D1。此前使用本地版的用户需要重新登录，收藏和历史记录从新的 D1 开始。原来的 `server.js`、`routes/` 与 `deploy/` 暂时保留，方便对照和回退；Cloudflare 部署只使用 `cloudflare/src/`、`cloudflare/schema.sql`、`lib/qqmusic.js` 与 `public/`。

网易云与 QQ 音乐接口并非 Cloudflare 平台服务，可能随上游接口或风控变化而失效。部署后应分别用真实账号验证扫码、歌单解析、音频地址和播放器行为。
