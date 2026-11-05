# 平台与账号模型

这份文档说明「支持哪些平台、支持到什么程度、账号与数据怎么归属」。它是 `cloudflare/src/platforms.js`（后端注册表）与 `web/src/lib/platform-data.js`（前端能力表）的说明，两边由 `cloudflare/tests/platform-parity.test.js` 锁定一致。

## 能力矩阵

| 平台 | 路径前缀 | 鉴权头 | 账号接入 | 歌单解析 | 音源播放 |
| --- | --- | --- | --- | --- | --- |
| 网易云音乐 | `/api` | `x-token` | 扫码 / 验证码 / 密码 / Cookie | 支持 | 支持 |
| QQ 音乐 | `/api/qq` | `x-qq-token` | 扫码 | 支持 | 支持 |
| 酷狗音乐 | `/api/kugou` | `x-kugou-token` | 扫码（仅账号身份） | 支持 | 支持（受版权限制） |
| 酷我音乐 | `/api/kuwo` | `x-kuwo-token` | 账号密码 / 手机短信（仅账号身份） | 受上游风控影响 | 支持 |

> **兼容性红线**：`/api/...` 必须继续等于网易云、`/api/qq/...` 必须继续等于 QQ 音乐。线上 VRChat 房间与播放器里已经签发的 M3U8 链接就是这个形状，改前缀等于全部失效。`cloudflare/tests/platforms.test.js` 的第一条测试锁定了这一点。

## 账号接入

`account: true` 表示这个平台有登录入口：服务端保存加密 Cookie，并把账号身份挂到 `users` 行上。

手动 Cookie 登录仅开放给网易云。QQ 音乐与酷狗通过服务端持有的二维码确认结果建立会话，酷我通过密码/短信成功结果建立会话；这三个平台的手动 Cookie 请求返回 405。QQ 用户资料查询只补充展示信息，扫码身份需与服务端换回 Cookie 的账号一致。

`library: true` 才表示有「我的音乐」——用户歌单、收藏、播放记录。两者不是同一件事：**酷狗与酷我都可以登录，但个人歌单与收藏尚未接入**（`account: true, library: false`）。

`guestPlayback: true` 表示**未登录也能解析与播放**；登录只是补充账号身份，不是播放的前置条件。

只有游客能力（`account: false`）的平台：

- 不需要登录即可解析公开歌单并生成播放链接。
- 没有 `users` 行，因此**没有个人歌单、收藏与播放记录**；`/api/<platform>/playlist/user`、`/favorites`、`/history/*` 一律返回 403 并附带原因；`/auth/*` 返回 501（`/auth/status` 除外，它返回 `{logged:false, supported:false}`）。
- 播放链接是**无状态令牌**：载荷里 `u = 0`、`h = 'guest'`，只验 HMAC 不查库。这同时省掉了每个音频分片请求的一次 D1 读取。代价是没有「退出登录即撤销」——链接有效期内一直可用，与匿名分享链接等价。未登录的酷狗 / 酷我同样走这条路径。
- 游客有效播放写入 `playback_events`，`user_id` 为 NULL；同一原子写入更新永久累计，参与全站 30 天排行。游客去重使用服务密钥、Cloudflare 地址和 User-Agent 的哈希，不创建账号记录；`play_stats` 继续仅保存已登录账号的个人历史。界面统计从 D1 读取。

### 酷狗的上游接口

| 用途 | 接口 | 备注 |
| --- | --- | --- |
| 歌单元数据 | `m.kugou.com/plist/list/{id}?json=true` | **忽略 page / pagesize，永远只返回前 10 首**，因此只用来取名称与封面 |
| 歌单曲目 | `mobiles.kugou.com/api/v3/special/song?specialid={id}&page=N&pagesize=30` | 真正可用的分页接口 |
| 音源 | `m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash={hash}` | 付费曲目返回 `error: "需要付费"` 且没有 URL |

歌曲 ID 是**复合**的：`基础hash[-320hash[-sqhash]]`。M3U8 只带一个 ID，把三档 hash 一起编码进去，播放时才能按音质选择档位；缺失的档位直接省略。同一首歌在不同分页里可能带着不同的档位（有时只有基础 hash），所以去重按**基础 hash** 做，并把档位取并集。

酷狗登录走 Web 扫码接口（`cloudflare/src/upstream/kugou-login.js`）：

| 用途 | 接口 | 关键参数 |
| --- | --- | --- |
| 生成二维码 | `login-user.kugou.com/v2/qrcode` | `appid=1001`、`plat=4`、`srcappid=2919`、`qrcode_txt`、`mid`、`clienttime`、`signature` |
| 轮询状态 | `login-user.kugou.com/v2/get_userinfo_qrcode` | `appid=1005`、`qrcode=<key>`，`data.status`：0 过期 / 1 等待 / 2 已扫待确认 / 4 确认并返回 `token`+`userid` |

签名是 `md5(salt + 按 key 排序的 k=v 串 + body + salt)`，salt 为 `NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt`；Workers 的 WebCrypto 不支持 MD5，因此仓库里带了一个纯 JS 实现（`src/upstream/md5.js`）。确认成功后只保存 `token` 与 `userid`，用户资料接口要求 RSA PKCS#1 v1.5，Worker 里没有实现。

**登录不会提升音源**：移动端 `getSongInfo` 完全忽略登录态，要让会员/付费曲目可播得走 `/v5/url` 或 `/v6/priv_url`，而它们要求先做设备注册（AES-CBC + RSA PKCS#1 v1.5）。因此付费曲目仍然返回统一的版权/VIP 提示。

### 酷我的登录

酷我没有扫码接口，站点的登录弹窗只有账号密码、手机短信与第三方 OAuth（OAuth 回调 Cookie 落在 `.kuwo.cn`，服务端接不了）。实现见 `cloudflare/src/upstream/kuwo-login.js`：

| 步骤 | 接口 | 说明 |
| --- | --- | --- |
| 图形验证码 | `GET https://www.kuwo.cn/api/common/captcha/getcode` | 返回 `{ img: PNG data URL, token }`，同时下发 `Hm_Iuvt_*` 匿名 Cookie，token 与它绑定 |
| 账号密码 | `POST https://wapi.kuwo.cn/api/www/login/loginByKw` | body：`{ userIp, uname, password, verifyCode, verifyCodeToken }` |
| 发送短信 | `POST https://www.kuwo.cn/api/sms/mobileLoginCode` | body：`{ verifyCode, verifyCodeToken, mobile, userIp }`，成功返回 `tm` |
| 短信登录 | `POST https://wapi.kuwo.cn/api/www/login/loginByMobile` | body：`{ mobile, verifyCode, smsCode, tm }` |

登录成功的响应直接在 JSON 里返回 `data.cookies`（`userid` / `uname3` / `pic3` / `sid` 等），服务端据此生成账号资料并加密存储；密码与图形验证码只用于这一次请求，不落库。图形验证码字母**区分大小写**。

### 酷我的上游接口

| 用途 | 接口 | 备注 |
| --- | --- | --- |
| 歌单 | `www.kuwo.cn/api/www/playlist/playListInfo` | 带风控：必须同时带 Cookie 与匹配的 `csrf` 头，数据中心 IP 常被直接拒绝 |
| 音源 | `antiserver.kuwo.cn/anti.s?type=convert_url&rid=MUSIC_{id}&format=mp3&br={br}` | 无需登录，支持 128 / 192 / 320 kbps 三档 |

歌单接口会先请求一次 `https://www.kuwo.cn/` 拿 Cookie，再从 `Hm_Iuvt_*` / `kw_token` 里取 csrf 值。仍然被拒时返回可操作的提示。运维可以用 `KUWO_COOKIE` 变量直接贴一份浏览器 Cookie 绕过引导：

```
npx wrangler secret put KUWO_COOKIE   # 内容形如 "kw_token=xxx; Hm_Iuvt_xxx=yyy"
```

## 多账号与数据归属

### 服务端

数据归属只有一条规则，且由 schema 保证：

```
users(id, platform, platform_user_id, ...)   UNIQUE (platform, platform_user_id)
  ↑
  ├── playlists    PRIMARY KEY (user_id, playlist_id)
  ├── favorites    PRIMARY KEY (user_id, playlist_id)
  └── play_stats   PRIMARY KEY (user_id, playlist_id, song_id)
```

- `users.id` 唯一对应一个 `(platform, platform_user_id)`，也就是一个真实账号。
- 所有个人数据的主键第一列都是 `user_id`，因此**换账号就是换一份数据**，不存在串号。
- 网易云与 QQ 音乐即使账号 ID 相同也是两条不同的 `users` 行，跨平台不会混合。
- 播放令牌绑定 `(platform, user_id, playlist_id, token_hash)`：**退出登录会立即撤销已签发的链接**；切换账号不会影响另一个账号已签发的链接。

### 浏览器

| 键 | 作用 |
| --- | --- |
| `token` / `qqToken` / `kugouToken` / `kuwoToken` | 四个平台各自的当前活动令牌；网易与 QQ 沿用原键 |
| `mfu:accounts` | 新增的登记表：本机登录过的账号（平台、账号 ID、昵称、头像、令牌），最多 8 个，最近的排在最前 |
| `mfu:account:<platform>:<userId>` | 本机备注（名称、备注），不跨设备同步 |

每个平台的请求使用对应活动令牌；`mfu:accounts` 保存可切换的本机账号。同一账号重新登录后，登记表更新为新的服务端令牌。私人查询键包含平台、账号 ID 与数据类别，切换或退出时取消旧请求并移除旧查询缓存。

旧共享 `token` 仅在匹配酷狗/酷我的明确登记项时迁入该平台的新键，保留其他账号的未活动状态；身份仍由服务端刷新验证。

### 汇总口径

「关于」页的统计是**全站汇总**，不区分账号也不含个人信息：

| 指标 | 来源 | 更新方式 |
| --- | --- | --- |
| 累计解析歌曲 | `site_stats.parsedSongs` | 每次解析歌单时按曲目数累加（实时） |
| 生成链接 | `site_stats.generatedLinks` | 每次签发播放链接累加（实时） |
| 累计有效播放请求 / 估算播放时长 | `playback_totals`；包含游客，按 player/hls/redirect 分类 | 有效事件与触发器原子更新，长期保留；起算点由 `startedAt` 返回 |
| 30 天曲目 / 歌单数 | `playback_events` 按平台与 ID 去重 | cron 与惰性刷新，`STATS_REFRESH_MINUTES` 默认 60 分钟 |
| 已登录账号 | `users` 行数，跨平台分别计数 | 同上 |

缺失指标以 NULL 和 `unknown` 表示，刷新失败保留可用旧快照并设置 `stale`；首次无可用快照返回 503。未知曲目时长另记覆盖数，旧缓存的默认时长也按未知处理。旧历史原样保留，新累计和精确排行从 0005 迁移时起算。

全站 `/api/stats/top` 按事件时间查询 30 天排行，含游客，边缘缓存 5 分钟并合并冷请求；个人 `/history/top` 独立按登录账号查询。两者均返回周期与起算信息。事件按 30 天清理，永久累计保持。完整口径和升级步骤见 [Cloudflare 指南](README.md#站点统计)。

## 新增一个平台要改什么

1. **`cloudflare/src/platforms.js`**：加一项——路径前缀、鉴权头、`account` / `library` / `playback` / `guestPlayback`、歌曲与歌单 ID 的正则、音频与封面域名白名单。
2. **`cloudflare/src/upstream/<name>.js`**：实现 `getPlaylistDetail(playlistId, cookie, env)` 与 `getSongResource(songId, cookie, env)`，返回结构照抄现有适配器；有登录能力的平台再导出 `createQRCode()`、`checkQRCode(key)`、`checkLoginStatus(cookie)`。
3. **`cloudflare/src/playlists.js`**：`adapter()` 加一个分支；`PLAYLIST_URL_RULES` 与 `PLAYLIST_QUERY_KEYS` 加该平台的链接形状。
4. **`web/src/lib/platform-data.js`**：加同名的一项，`label` / `account` / `library` / `playback` 必须与后端一致，否则 parity 测试会红。
5. 跑 `npm test`（根目录与 `cloudflare/` 各一次）。路由、校验、遥测、音源白名单、前端入口都会跟着注册表走，不需要再改别处。
