# R2 与 Cloudflare 技术选型

本文按项目的私有音乐账号、原始音源格式和轻量部署目标选择。价格查询于 2026-10-06，后续以官方账单规则为准。

| 方案 | 音频存储 / 分发特点 | 优点 | 代价与适合场景 |
| --- | --- | --- | --- |
| Workers + D1 + 私有 R2 | Worker 鉴权，R2 存原始字节，D1 存账号和短期音源元数据 | 无常驻服务器，Range、账号隔离、退出撤销 | Worker / D1 / R2 操作计费；无 FFmpeg；本项目推荐 |
| Pages + Functions + R2 | 静态发布与函数入口，绑定 D1 / R2 | 适合已有 Pages 流程，复用项目 API | 单独配置绑定与 Secret；每日维护另配 Worker Cron |
| R2 公开自定义域名 + CDN | 公开对象通过自定义域名进入 CDN | 适合可公开、自有版权的资源 | 公共缓存会改变私有账号媒体的鉴权模型，本项目未采用 |
| Cloudflare CDN / Cache API | 缓存边缘响应，不是持久对象仓库 | 适合静态 JS、CSS、官网与公共封面 | 私有音乐不能简单按 URL 公共缓存；Cache API 命中范围与淘汰需评估 |
| Cloudflare Stream | 托管视频编码、HLS / DASH 分发 | 若未来需要自有视频和自适应码率可减少转码维护 | 以视频存储和播放分钟计费，不是本项目原始 MP3 / FLAC 私有缓存的首选 |
| Node.js + SQLite + 磁盘 | 服务器直接代理，可运行 FFmpeg | 原生库、无损、转码能力完整 | 维护进程、磁盘、证书和带宽，适合需要视频输出的部署 |
| Navidrome | 自托管个人音乐库，Subsonic API，多用户与转码 | 成熟的自有音乐文件管理 | 面向本地音乐库，不替代网易云 / QQ 授权音源；需要服务器 |

以上选型是基于官方能力的项目判断。[Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)、[Pages 绑定](https://developers.cloudflare.com/pages/functions/bindings/)、[R2 公共桶与缓存](https://developers.cloudflare.com/r2/buckets/public-buckets/)、[Stream 概述与定价](https://developers.cloudflare.com/stream/pricing/)、[Navidrome 源码](https://github.com/navidrome/navidrome)。

## R2 成本与边界

Standard 标准存储为 $0.015 / GB·月，A 类操作 $4.50 / 百万次，B 类 $0.36 / 百万次，R2 出站流量免费；标准层免费额度包括 10 GB·月、100 万 A 类与 1,000 万 B 类操作。Worker 请求与 D1 等费用另算，免费出站不代表全链路免费。短期高频缓存建议 Standard，避免 Infrequent Access 的检索费用和最短存储周期。来源：[R2 官方定价](https://developers.cloudflare.com/r2/pricing/)。

Stream 的视频存储容量按 $5 / 1,000 分钟·月购买，播放分发 $1 / 1,000 分钟。若需要视频画面和托管编码可另行评估；本轮不引入该服务。来源：[Stream 官方定价](https://developers.cloudflare.com/stream/pricing/)。

## 本项目建议

继续使用 Workers Static Assets + D1，增加私有 R2 热缓存。静态官网独立由 GitHub Pages 发布。保留 Node.js 部署供需要无损和 FFmpeg 的用户使用。

音频响应设置 `private, no-store`，不开放 R2 公共域名；每次媒体读取均检查账号与歌曲权限。缓存目的为短期减少重复回源，不能扩大音乐平台授予的播放权利。稳定性与速度由真实线路测量决定，优选 DNS 和 Smart Placement 不应替代播放链路验证。
