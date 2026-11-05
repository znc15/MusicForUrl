# 界面动画

Cloudflare 版前端是 **React + Vite**，动画由 **`motion`（framer-motion）** 承担，入口为 `web/src/motion/primitives.tsx` 与 `web/src/main.tsx` 的 `LazyMotion`。旧的 GSAP 前端保存在 `node` 分支，历史实现见[冻结基线](https://github.com/znc15/MusicForUrl/blob/f3830c4/public/js/motion.js)。

```tsx
// web/src/main.tsx
<MotionConfig reducedMotion="user">
  <LazyMotion features={domMax} strict>
```

`domMax` 提供布局动画，分段控件的 `layoutId` 滑块依赖它；`strict` 保证组件里不会误用会拉入全量包的 `motion.*`，只能用 `m.*`。

## 修改位置与触发条件

| 位置 | 触发条件 | 实现 |
| --- | --- | --- |
| `web/src/motion/primitives.tsx` → `PageTransition` | 五个视图互相切换、浏览器前进/后退 | 按路由 key 重新挂载，进入动画由 `web/src/index.css` 的 `page-enter` 关键帧提供；只做进入不做退出。`App.tsx` 按路由分包，切换时由 `Suspense` 兜底 |
| `web/src/components/sidebar.tsx` → 导航项 | 切换工作台页面 | 用 `NavLink` 的激活态直接切换背景色，不再需要测量位置的滑块 |
| `web/src/components/sidebar.tsx` → 展开/收起 | 点击底部账号头像旁的开关 | 纯 CSS `width` 过渡（250ms `cubic-bezier(0.4,0,0.2,1)`），宽度由 `--rail-width` 驱动；文字标签不参与动画，直接按状态挂载/卸载，避免收起过程中出现半截文字 |
| `web/src/components/volume-control.tsx`（只在播放条） | 点击或拖动轨道、方向键、静音 | 填充宽度与滑块位置随音量即时更新，不做补间——音量是连续量，动画只会让手感发黏；滑块圆点在 hover / 聚焦 / 拖动时淡入 |
| `web/src/motion/primitives.tsx` → `Segmented` | 切换音乐平台、登录平台 | `layoutId` 共享元素过渡取代旧版手写测量 `offsetLeft/offsetWidth` 的做法；每个实例用 `useId` 隔离 |
| `web/src/views/user.tsx` → 我的歌单 / 我的收藏 / 最近播放 / 最常播放 | 切换内容 Tab | Radix `Tabs` 负责状态与无障碍，面板内容按需渲染 |
| `web/src/motion/primitives.tsx` → `ListReveal` / `ListItem` | 歌单、收藏、最近播放列表渲染 | 容器 `staggerChildren`，行以 `y=8px` 错峰进入 |
| `web/src/components/login-dialog.tsx` | 打开、关闭按钮、Escape、点击遮罩 | Radix `Dialog` 提供焦点陷阱、背景 `inert` 与 ARIA，`DialogContent` 负责进出场 |
| `web/src/components/account-menu.tsx` | 点击顶栏账号入口 | 面板直接挂载，不做位移；点击外部或 Escape 关闭，避免焦点管理复杂化 |
| `web/src/components/mini-player.tsx` | 切歌、切换音质、播放/暂停、展开队列；曲目自然结束或整首不可播时自动下一首 | 状态变化驱动，不使用位移动画，避免影响播放控件可用性 |
| `web/src/stores/theme.ts` | 点击亮色 / 深色开关，或在侧栏选择跟随系统 | 直接切换 `documentElement.dataset.theme`；调色板差异由 CSS 变量承担，不再逐帧插值 |

## 实装参数

除页面进入外，所有时长均以秒配置在 `DURATION`。页面进入是 CSS 关键帧，280ms 与缓动写在 `web/src/index.css` 的 `.page-enter`。文本不做模糊、旋转或大幅缩放。

| 动画 | 进入 | 退出 | 延迟/错峰 | 位移/缩放 | 缓动 |
| --- | --- | --- | --- | --- | --- |
| 页面 | 280ms | — | — | 进入 y=12px，无退出动画 | `[0.22, 0.61, 0.36, 1]` |
| 列表 | 220ms | 100ms | 每行间隔 25ms | 进入 y=8px | 同上 |
| 分段滑块 | 260ms | — | — | `layoutId` 自动匹配位置与尺寸 | `[0.4, 0, 0.2, 1]` |
| 侧栏宽度 | 250ms | 250ms | — | 76px ↔ 252px | `[0.4, 0, 0.2, 1]` |
| 音量填充 | 即时 | — | — | — | — |
| 弹窗 | Radix 默认 | Radix 默认 | — | — | — |
| 亮暗主题 | 即时切换 | 同步 | — | 颜色由 CSS 变量过渡 | — |

与原实现的差异：主题切换从「GSAP 逐帧插值 17 个调色板变量、360ms」改为**直接切换 CSS 变量**。原因是新界面使用实色表面而非玻璃，逐帧插值不再有视觉收益，而即时切换在低端设备上更省电、也不会在切换过程中出现中间色。`DURATION.theme` 仍保留供将来需要过渡时使用。

## 复用示例

```tsx
import { Segmented, ListReveal, ListItem } from '@/motion/primitives';

<Segmented
  ariaLabel="音乐平台"
  value={platform}
  onChange={setPlatform}
  options={[{ value: 'netease', label: '网易云音乐' }, { value: 'qq', label: 'QQ 音乐' }]}
/>

<ListReveal className="flex flex-col gap-2">
  {items.map(item => <ListItem key={item.id}>{/* ... */}</ListItem>)}
</ListReveal>
```

## 生命周期与无障碍

- `<MotionConfig reducedMotion="user">` 跟随系统的减少动态效果设置；`web/src/index.css` 另外尊重旧前端写入的 `documentElement.dataset.motion` 标志，并保留 `prefers-reduced-motion` 兜底。
- Radix 组件自带焦点陷阱、Escape 关闭、背景 `inert` 与 ARIA 角色，旧版手写的键盘循环不再需要。
- 页面切换时旧视图立即卸载，新视图靠 CSS 关键帧进入，不依赖 JS 逐帧推进：rAF 被节流（后台标签页、窗口遮挡）或系统要求减少动态效果时，页面不会停在 opacity 0 或半透明状态。`Suspense` 在分包加载期间显示骨架。
- 列表使用 `staleTime: 30s` 的查询缓存，翻页与切 Tab 不会重复请求，因此列表动画不会与网络抖动耦合。
- 播放控件不参与位移或缩放动画，避免误触与可点击区域漂移。

## 依赖与部署

前端在 `web/` 目录独立构建，产物 `web/dist` 由 Worker 的 `assets` 绑定提供：

```sh
npm --prefix web ci
npm --prefix cloudflare ci
npm run build
npm --prefix cloudflare run deploy   # predeploy 会自动先构建 web
```

`hls.js` 由 npm 引入并**按需动态加载**（约 185 kB gzip），只在预览页真正打开 HLS 源时才下载，不进首屏。Cloudflare 分支直接使用前端锁定依赖构建，旧版 vendor 同步脚本随 Node.js 分支冻结。

参考：[Motion 文档](https://motion.dev/docs/react)、[Radix Dialog](https://www.radix-ui.com/primitives/docs/components/dialog)。
