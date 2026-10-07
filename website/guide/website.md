# 官网自动发布

官网仅发布到 **GitHub Pages**：`https://znc15.github.io/MusicForUrl/`。播放器继续使用自己的运行域名，官网不保存音乐账号 Cookie、数据库或播放音频。

## 构建结构

- `website/`：VitePress 官网、使用和部署指南。
- `website/scripts/sync-docs.mjs`：构建前读取根 README、Node / Docker、Cloudflare 与动画说明，生成文档页面并转换相对链接。
- `.github/workflows/website.yml`：文档或官网提交后安装锁定依赖、构建、上传 artifact，再部署 Pages；PR 只构建。
- `.vitepress/config.mjs`：项目子路径 `/MusicForUrl/`、本地搜索、导航与主题。

## 首次开启 Pages

仓库管理员在 Settings → Pages，将 Source 设为 **GitHub Actions**。部署使用 `github-pages` environment；开发阶段允许 `codex/cloudflare-serverless` 分支部署，合入后由 `master` 更新。工作流不包含 Cloudflare 密钥，也不依赖付费托管。

GitHub Pages 首次启用需要仓库设置权限；工作流的 `GITHUB_TOKEN` 不负责自动启用 Pages。参考 [VitePress 部署指南](https://vitepress.dev/guide/deploy)与 [GitHub Pages 建站说明](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)。

## 本地预览

```sh
cd website
npm ci
npm run build
npm run preview
```

生成文档、构建输出与复制图片均不提交，源文档只维护在仓库中。官网明暗切换使用 GSAP 320ms 淡入，响应系统减少动态效果。
