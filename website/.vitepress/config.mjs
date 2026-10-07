import { defineConfig } from 'vitepress';

export default defineConfig({
  lang: 'zh-CN',
  title: 'MusicForUrl',
  description: '连接音乐账号，选择音质，把歌单变成播放链接。',
  base: '/MusicForUrl/',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['meta', { name: 'theme-color', content: '#87ceeb' }],
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/MusicForUrl/brand.svg' }],
  ],
  themeConfig: {
    logo: '/brand.svg',
    siteTitle: 'MusicForUrl',
    nav: [
      { text: '使用指南', link: '/guide/start' },
      { text: '部署', link: '/guide/deployment' },
      { text: '技术选型', link: '/guide/architecture' },
      { text: '打开播放器 ↗', link: 'https://music.nyasakura.com/' },
    ],
    sidebar: [
      { text: '开始使用', items: [
        { text: '快速开始', link: '/guide/start' }, { text: '音质与播放限制', link: '/guide/quality' },
        { text: '加载、封面与缓存', link: '/guide/performance' },
      ] },
      { text: '部署与技术', items: [
        { text: '两种部署方式', link: '/guide/deployment' },
        { text: 'R2 与 Cloudflare 选型', link: '/guide/architecture' },
        { text: '官网自动发布', link: '/guide/website' },
      ] },
      { text: '仓库同步文档', items: [
        { text: '项目 README', link: '/generated/readme' },
        { text: 'Cloudflare 部署记录', link: '/generated/cloudflare' },
        { text: '自有服务器与 Docker', link: '/generated/server' },
        { text: '统一动画配置', link: '/generated/animation' },
      ] },
    ],
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/znc15/MusicForUrl' }],
    editLink: { pattern: 'https://github.com/znc15/MusicForUrl/edit/master/website/:path', text: '在 GitHub 编辑此页' },
    footer: { message: 'MusicForUrl · MIT License', copyright: '项目文档从仓库构建，随提交自动发布。' },
    outline: { label: '本页目录', level: [2, 3] },
    docFooter: { prev: '上一页', next: '下一页' },
    darkModeSwitchLabel: '主题切换',
    lastUpdated: { text: '最近更新' },
  },
});
