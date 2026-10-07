# 音质与播放限制

## 可选档位

| 档位 | 网易云请求 | QQ 音乐请求 | Cloudflare | 自有服务器 |
| --- | --- | --- | --- | --- |
| 标准 | MP3，128 kbps | M500 MP3，通常 128 kbps | 支持 | 支持 |
| 较高 | MP3，192 kbps | M800 MP3，通常 320 kbps | 支持 | 支持 |
| 高品质 | MP3，320 kbps / exhigh | M800 MP3，通常 320 kbps | 支持 | 支持 |
| 无损 | lossless FLAC | F000 FLAC | 禁用；旧配置映射高品质 MP3 | 支持，取决于浏览器解码和账号权限 |

档位代表请求意图，实际值以播放区域的格式和码率为准。平台可能返回较低码率、试听片段或空地址；不会把 MP3 改名为 FLAC。

## 降级策略

共享 `lib/player-policy.js` 从所选档位向下尝试。Cloudflare 过滤非 MP3 音源。高档位仅有试听时继续寻找较低档位的完整音源；所有可用音源都是试听时，明确显示“试听片段”。全部失败返回不可播放提示。

网易云独立付费、VIP、地区版权与登录态会影响可获取的音源。平台返回登录过期时提示重新登录；不会用旧缓存跳过已撤销的会话。降级会显示原因及实际格式。自有服务器上的 FLAC 若浏览器无法解码，播放器再尝试高品质 MP3。

切换音质会保留当前进度与播放 / 暂停状态。网络失败只刷新音源重试一次，避免循环请求。

## 两种播放链路

- 网页歌单预览：`/api/player/*`，逐首原生媒体播放，支持 Range 拖动与实际音质反馈。
- Cloudflare 导出的 M3U8：MP3 Packed Audio，每首歌一个完整片段，带 ID3 时间戳。不运行 FFmpeg，不提供视频或无损 HLS。
- 自有服务器旧 HLS / MP4 输出：需要 FFmpeg；属于独立转码链路，网页音质选择不会更改已经生成的转码文件。

## VRChat / 台 K

Cloudflare 轻量 M3U8 是音频 HLS，不包含视频画面。2026-10-07，PC 台 K 房间用户实测确认同一链接切换到 AVPro 后可以播放；其他世界与 Quest / 安卓需分别验证。

1. 在房间播放器中选择 **AVPro**，部分播放器标为 **Stream / 流媒体**。
2. 粘贴本站生成的 `stream.m3u8` 完整直链，再开始播放。
3. 若出现 `Requested format is not available`，先检查是否仍在视频模式；该错误表示解析器没有选到符合播放器要求的格式。不同后端的筛选条件可能不同，音频 HLS 可被视频模式过滤。

只有视频模式的房间，需要世界作者增加 AVPro，或使用自有服务器部署的真实 HLS / MP4 视频输出。Cloudflare 轻量模式不运行 FFmpeg；修改后缀、MIME 或清单标签不会增加真实视频轨道。两种后端的区别见 [VRChat 官方播放器说明](https://creators.vrchat.com/worlds/udon/video-players/)。

播放还需要房间允许媒体域名、观众启用对应的 URL 设置。第三方 `?url=` 页面不能保证转发本站音源。参考 [VRChat 官方允许域名说明](https://creators.vrchat.com/worlds/udon/video-players/www-whitelist/)。
