# MusicForUrl

[![License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/znc15/MusicForUrl/blob/master/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-3c873a)](https://nodejs.org/)
[![Cloudflare Workers](https://img.shields.io/badge/cloudflare-workers%20%2B%20d1-f38020)](https://developers.cloudflare.com/workers/)

把网易云音乐、QQ 音乐、酷狗与酷我的歌单转换成轻量音频 M3U8 直链，自带账号管理、收藏、播放记录和站内播放器。前端 React + Vite，后端使用 **Cloudflare Workers / Pages Functions + D1**，可选私有 R2 音频缓存。

## 维护分支

- **`master`**：后续功能、修复与文档的维护入口，本页命令适用于此分支。
- **`node`**：Node.js / Docker 冻结版本，保留拆分基线 `f3830c4` 的原始代码与运行说明。需要自有服务器部署时，使用[冻结版部署文档](https://github.com/znc15/MusicForUrl/blob/f3830c4/README.node-docker.md)。

- 在线使用：<https://music.nyasakura.com/>
- 文档站：<https://znc15.github.io/MusicForUrl/>
- 版本发布：[GitHub Releases](https://github.com/znc15/MusicForUrl/releases) · [更新记录](CHANGELOG.md)

![MusicForUrl 工作台与媒体预览](.github/assets/workspace-preview.jpg)

## 功能

- **歌单直链**：四个平台的歌单生成签名 M3U8，可复制、可站内预览。
- **多账号**：同一平台记住多个账号，歌单缓存、收藏与播放记录按账号严格隔离。
- **站内播放器**：逐首播放、音质切换、自动续播、封面队列与单一音量控制。
- **音质回退**：标准 / 较高 / 高品质 MP3 逐级尝试。
- **VRChat / 台 K**：链接默认有效 24 小时（最长 48 小时），房间播放器需切到 **AVPro / Stream** 模式。
- **界面**：可收起侧边栏、亮 / 暗 / 跟随系统主题、motion 过渡并尊重「减少动态效果」。

## 平台支持

| 平台 | 登录方式 | 歌单解析 | 音源播放 |
| --- | --- | --- | --- |
| 网易云音乐 | 扫码 / 验证码 / 密码 / Cookie | 支持 | 支持 |
| QQ 音乐 | 扫码 | 支持 | 支持 |
| 酷狗音乐 | 扫码 | 支持 | 支持 |
| 酷我音乐 | 密码 / 手机短信 | 支持 | 支持 |

酷狗与酷我的登录只用于识别账号身份，歌单和音源仍走公开接口：登录不提升音质，付费曲目无法播放，也暂未接入个人歌单、收藏与播放记录。未登录同样可以生成播放链接。

能力矩阵由 `cloudflare/src/platforms.js` 与 `web/src/lib/platform-data.js` 定义并由测试锁定，上游接口与扩展方式见[平台说明](cloudflare/PLATFORMS.md)。

## 快速开始

需要 Node.js 24+ 与 npm。以下命令从 `master` 工作副本根目录执行，分别安装前端与 Worker 依赖：

```powershell
npm --prefix web ci
npm --prefix cloudflare ci
Copy-Item cloudflare/.dev.vars.example cloudflare/.dev.vars
```

将 `cloudflare/.dev.vars` 中的 `ENCRYPTION_KEY` 换成至少 32 字符的随机密钥，占位值会被拒绝：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

```powershell
npm --prefix cloudflare run db:local
npm run dev
```

`npm run dev` 会先构建 `web/` 再以本地 D1 启动 Wrangler。根目录 `npm test` 运行基础模块、Cloudflare、数据库迁移与前端状态机回归；`npm run check` 检查前端类型，`npm run build` 生成 `web/dist`。

## 部署

推荐由同一个 Worker 发布 `web/dist` 静态资源与 API。完成上述依赖安装后：

```powershell
cd cloudflare
npx wrangler login
npx wrangler d1 create music-for-url   # 把 database_id 写入 wrangler.jsonc
# 先处理 routes 和可选 R2 绑定，见下文
npm run db:remote
Copy-Item .dev.vars.example .dev.vars.production
# 将 ENCRYPTION_KEY 改为独立的至少 32 字符随机密钥并安全备份
npm run build:assets                    # 直接调用 Wrangler 需要先构建静态资源
npx wrangler deploy --secrets-file .dev.vars.production
npm run deploy                          # 后续更新
```

首次部署前务必删除或替换 `wrangler.jsonc` 中属于在线站点的 `routes`。默认配置包含 R2：不需要缓存时，删除整个 `r2_buckets` 配置并将 `vars.AUDIO_CACHE_ENABLED` 设为 `"false"`；需要时先创建自己的私有桶并更新桶名（保留 `AUDIO_CACHE` 绑定名），见[私有 R2 缓存](cloudflare/README.md#私有-r2-缓存)。仅设置 `false` 仍要求绑定的桶存在。升级顺序、环境变量与自定义域名见[部署文档](cloudflare/README.md)。

现有 **Cloudflare Pages** 项目接入新 UI：保持仓库根目录，构建命令 `npm --prefix cloudflare ci && npm --prefix web ci && npm run build:pages`，输出 `web/dist`，并保留根 `functions/` 与原 D1 / Secret。先按[Pages 升级检查表](website/guide/deployment.md#现有-pages-项目接入-react)确认旧库结构，再执行有备份的统一迁移。

## 文档

| 文档 | 内容 |
| --- | --- |
| [cloudflare/README.md](cloudflare/README.md) | Worker 实现、R2 音频缓存、D1 表结构与站点记录 |
| [cloudflare/PLATFORMS.md](cloudflare/PLATFORMS.md) | 四个平台的上游接口、风控与扩展方式 |
| [cloudflare/ANIMATION.md](cloudflare/ANIMATION.md) | 动画时长、参数与复用示例 |
| [website/guide](website/guide/start.md) | 使用指南、音质限制、性能、部署与选型 |
| [冻结版部署文档](https://github.com/znc15/MusicForUrl/blob/f3830c4/README.node-docker.md) | Node.js / Docker 的原始运行说明 |
| [Issues](https://github.com/znc15/MusicForUrl/issues) | 问题反馈 |

## 项目结构

```text
web/          Cloudflare 版前端（React + Vite + Tailwind + shadcn/ui）
cloudflare/   Worker API、平台适配、D1 结构与回归测试
lib/          Worker 使用的播放器策略、媒体代理与 QQ 音乐适配
functions/    Pages Functions 兼容入口
website/      VitePress 文档站
```

## License

[MIT](LICENSE)
