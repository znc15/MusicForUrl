# 更新记录

## 2.2.0 — 2026-11-05

### Cloudflare 维护版本

- `master` 作为 Cloudflare Workers + D1 的持续维护分支，React 静态资源与 API 一起部署；传统 Node.js / Docker 版本保留在冻结的 `node` 分支。
- 统一根目录开发、测试和构建命令，保留 Pages Functions 兼容入口，更新部署指南。

### 登录、播放与界面修复

- 加固 QQ 扫码认证链，QQ / 酷狗 / 酷我改用受支持的登录入口，四个平台分别保存登录令牌。
- 按平台和账号隔离私人查询缓存，切换账号时清理旧列表；修复播放器异步请求竞争与收藏分页删除后的页码回退。
- 改善小屏输入、常驻播放器、音量与音质设置、键盘进度操作、错误重试和空状态。
- 统一等价接口限流，补充上游请求超时与响应体预算，完善降级模式和音源刷新并发控制。

### 数据、部署与日志

- 统一 D1 迁移入口，升级四平台账号结构并保留原账号、歌单、收藏和播放记录；修复远端迁移命令输出解析。
- 修复 Cloudflare 自动构建与部署配置，限制构建文件并发，解决构建环境的 `EMFILE` 错误。
- 启用 Workers Observability 持久化日志与查询参数脱敏，移除 QQ 音源失败日志中的原始播放凭据；请求采样率为 100%，Traces 保持关闭。
- 更新相关依赖，并为后续发布增加版本及锁文件一致性检查。

### 升级

- Cloudflare 部署使用 `master`，运行方式见 [部署指南](cloudflare/README.md)。旧 D1 升级前先备份，再执行 `npm --prefix cloudflare run db:migrate -- --remote`，继续沿用原有 `ENCRYPTION_KEY`。
- 已完成 `0004-unified-platform-schema` 的数据库无需再次变更；重复运行迁移会报告已应用。
- HLS 播放链接的短期签名位于 URL 路径，仍可能保存在日志中，请限制日志查看权限。

更早版本见 [v2.1.1 Release](https://github.com/znc15/MusicForUrl/releases/tag/v2.1.1)。
