# MusicForUrl

将音乐歌单转换为可在视频播放器中播放的 M3U8 链接，支持多用户登录、VIP 歌曲播放。

服务器进行加密存储Cookie，防止用户信息泄露。

生成链接时提供三种输出：
- **轻量 M3U8（直链列表，优先推荐）**：几乎不转码/不落盘，服务器压力更小；大部分 VRChat 播放器可用，但不会显示视频画面（仅音频），兼容性仍取决于播放器实现。
- **视频轻量 M3U8（随机背景图）**：仍走 HLS 分片链路，但背景图按播放链接随机并固定；图片 API 异常会自动回退歌单封面。
- **HLS（转码分片）**：兼容性更稳，但会消耗较多 CPU/磁盘（需要 FFmpeg）；当轻量模式无法播放时再切换。

## 快速开始

### 本地运行

```bash
npm install
cp env.example .env
# 生产环境必须设置 ENCRYPTION_KEY
npm start
```

默认端口 `3000`，可通过 `PORT` 修改。

### Docker 部署

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

按机器规格选择（需要资源限制生效时加 `--compatibility`）：

```bash
docker compose -f deploy/docker-compose.1c1g.yml --compatibility up -d --build
docker compose -f deploy/docker-compose.2c4g.yml --compatibility up -d --build
docker compose -f deploy/docker-compose.4c4g.yml --compatibility up -d --build
docker compose -f deploy/docker-compose.8c8g.yml --compatibility up -d --build
```

说明：
- 以上 compose 默认使用 **named volume** 存储数据；Linux 如需落盘宿主机，可改为 `../data:/app/data`。
- 端口以 compose 里的 `ports` 为准（默认 `3000:3000`）。

## 配置

完整可复制模板见 `env.example`。下面只列出项目实际使用到的主要配置项。

### 基础

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 服务端口 | `3000` |
| `NODE_ENV` | 环境标识 | `development` |
| `ENCRYPTION_KEY` | Cookie 加密密钥（生产环境必填，建议 32 位字符串） | - |
| `SITE_PASSWORD` | 站点访问密码（可选） | - |
| `ADMIN_PASSWORD` | 管理接口密码（可选，用于 `/api/hls/cache/*`） | - |
| `HLS_ADMIN_ENABLED` | 是否启用 HLS 管理接口（`1/true` 开启；默认关闭；需同时设置 `ADMIN_PASSWORD`） | - |
| `CACHE_TTL` | 歌单缓存时间（秒） | `86400` |
| `TOKEN_TTL_HOURS` | 登录 token 有效期（小时） | `168` |

### 反向代理

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `BASE_URL` | 公网访问地址（用于生成 m3u8 中的 URL） | - |
| `TRUST_PROXY` | 信任的代理层数或 IP/子网（不要设为 `true`） | `loopback` |

### 限流（每分钟）

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `RATE_LIMIT_GLOBAL` | 全局 API 限流 | `200` |
| `RATE_LIMIT_AUTH` | 认证接口限流 | `10` |
| `RATE_LIMIT_PARSE` | 歌单解析限流 | `30` |
| `RATE_LIMIT_HLS_STREAM` | `stream.m3u8` 限流 | `60` |
| `RATE_LIMIT_HLS_SEGMENT` | `.ts` 分片限流 | `600` |

### HLS / FFmpeg

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `HLS_MAX_CONCURRENT_JOBS` | 最大并发转码任务数 | `2` |
| `HLS_MAX_QUEUE` | 最大等待队列长度（超出返回 503） | `10` |
| `HLS_DOWNLOAD_TIMEOUT` | 音频/封面下载超时（毫秒） | `60000` |
| `HLS_DOWNLOAD_MAX_SIZE` | 下载最大字节数 | `104857600` |
| `HLS_FFMPEG_TIMEOUT` | FFmpeg 超时（毫秒） | `180000` |
| `HLS_FFMPEG_THREADS` | 单个 FFmpeg 进程线程数（0=自动；弱服务器建议 1~2） | `0` |
| `HLS_SEGMENT_DURATION` | HLS 分片时长（秒） | `10` |
| `HLS_AUTO_PRELOAD_COUNT` | 自动预加载前 N 首歌 | `1` |
| `LOG_HLS_VERBOSE` | 输出详细 HLS 日志（`1/true` 开启） | `0` |
| `PRELOAD_BASE_URL` | “生成链接”时后台预加载调用的 baseUrl（默认 `http://127.0.0.1:$PORT`） | - |

### TS 分片缓存

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `HLS_CACHE_MAX_SIZE` | 缓存最大容量（字节，优先级高于 GB） | - |
| `HLS_CACHE_MAX_SIZE_GB` | 缓存最大容量（GB） | `5` |
| `HLS_CACHE_MAX_AGE_HOURS` | 缓存最大保留时间（小时） | `24` |
| `HLS_CACHE_CLEANUP_INTERVAL_MINUTES` | 定时清理间隔（分钟） | `60` |
| `HLS_CACHE_CLEANUP_TARGET_RATIO` | 超限清理到 `maxSize * ratio` 以下 | `0.8` |

### 下载安全

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `HLS_DOWNLOAD_ALLOW_HOSTS` | 额外允许下载的 host 正则（逗号分隔） | - |

### 音质

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `MUSIC_QUALITY` | `low/medium/high/lossless` | `low` |
| `MUSIC_BITRATE` | 直接指定码率（bps，优先级低于 `MUSIC_QUALITY` 预设） | - |

### 视频轻量随机背景图

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `LITE_VIDEO_BG_API_URL` | 视频轻量随机背景图 API（支持 302/JSON/纯文本 URL） | `https://api.miaomc.cn/image/get` |
| `LITE_VIDEO_BG_API_TIMEOUT_MS` | 背景图 API 超时（毫秒） | `8000` |

### 封面视频

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `COVER_WIDTH` | 输出宽度 | `1920` |
| `COVER_HEIGHT` | 输出高度 | `1080` |
| `COVER_FPS` | 帧率（静态封面建议 1~5，可显著降压） | `5` | 
| `DEFAULT_COVER_URL` | 默认封面 URL | 内置默认值 |

### Docker 构建参数（可选）

当无法访问 Docker Hub 或需要加速构建时可用：

| 参数 | 说明 | 示例 |
|---|---|---|
| `NODE_IMAGE` | 基础镜像 | `node:20-alpine` |
| `ALPINE_REPO_MIRROR` | Alpine 仓库镜像（不带协议） | `mirrors.aliyun.com/alpine` |
| `NPM_REGISTRY` | npm registry | `https://registry.npmmirror.com` |

## License

MIT
