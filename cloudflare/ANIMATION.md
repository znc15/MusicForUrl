# 界面动画

本文对应 **2.4.0** 的 React + Vite 前端。页面和弹窗使用 CSS 关键帧，列表与分段指示器使用 `motion`；播放器材质、封面状态和播放指示位于 `web/src/player.css`。公共入口为 `web/src/motion/primitives.tsx`、`web/src/index.css` 和 `web/src/components/ui/dialog.tsx`。

```tsx
// web/src/main.tsx
<MotionConfig reducedMotion="user">
  <LazyMotion features={domMax} strict>
```

`domMax` 支持分段控件的布局动画；组件使用 `m.*` 配合 `LazyMotion`。传统 GSAP 前端保留在 `node` 分支，历史实现见[冻结基线](https://github.com/znc15/MusicForUrl/blob/f3830c4/public/js/motion.js)。

## 修改位置与触发条件

| 位置 | 触发条件 | 当前实现 |
| --- | --- | --- |
| `motion/primitives.tsx` → `PageTransition` | 页面切换、浏览器前进/后退 | 路由 key 变化后重新挂载，执行 CSS `page-enter`；旧视图立即卸载，新视图进入。首页在主包，其余视图按路由加载，`Suspense` 显示骨架 |
| `components/sidebar.tsx` → 桌面侧栏 | 点击展开/收起 | `--rail-width` 驱动宽度过渡；文字按展开状态挂载/卸载 |
| `components/sidebar.tsx` → 手机导航 | 视口小于 768px、切换页面 | 顶部五列导航，图标下显示“生成 / 音乐 / 播放 / 账号 / 关于”；激活项切换颜色，保持点击位置稳定，播放器路径仍为 `/preview` |
| `motion/primitives.tsx` → `Segmented` | 首页和登录弹窗切换平台 | `layoutId` 共享选中块移动；每个实例用 `useId` 隔离。选项单行排列，宽度不足时横向滚动 |
| `components/ui/tabs.tsx` | 切换登录方式或“我的音乐”分类 | Radix 管理 Tab 状态；选中项显示主色下边线。标签不拆行，容器横向滚动；新面板使用 `dialog-content-enter` |
| `motion/primitives.tsx` → `ListReveal` / `ListItem` | 歌单、收藏、最近播放列表挂载 | 行项目淡入并向上归位，逐项错峰 |
| `components/ui/dialog.tsx` | 登录、公告、歌单详情打开/关闭 | Radix 的 `data-state` 触发项目 CSS；遮罩淡入淡出，面板轻微位移与缩放 |
| `components/login-dialog.tsx` | 切换平台或登录方式 | 平台内容按 `key={active}` 重新挂载；外层和 Tab 面板均使用短进入动画，旧内容直接替换 |
| `components/account-menu.tsx` | 点击顶栏账号入口 | 菜单直接挂载/卸载；箭头随状态旋转。点击外部或 Escape 关闭 |
| `components/volume-control.tsx` | 点击、拖动、键盘调节或静音 | 填充宽度和滑块位置即时更新；滑块圆点在悬停、聚焦或拖动时淡入 |
| `views/preview.tsx`、`player.css` | 进入播放器、播放/暂停、全屏 | 桌面左侧封面和控制、右侧搜索队列；手机单列。播放状态驱动封面内边距变化，队列当前项显示播放指示条；全屏复用当前页面 |
| `components/player-controls.tsx` | 调节进度、切歌、随机/循环、搜索队列 | 共用 transport、progress、queue 组件；进度与缓冲即时更新，控制按钮提供按压反馈 |
| `components/mini-player.tsx` | 歌单播放时切换到其他页面、展开队列 | 玻璃播放条与大播放器共用状态，点击封面回到 `/preview`；大播放器页面隐藏迷你条 |
| `components/playback-engine.tsx` | 音源变化、媒体事件、系统媒体控制 | 常驻引擎管理当前歌单唯一 audio；视觉组件仅发送控制动作，路由切换保持播放 |
| `components/media-stage.tsx`、`components/media-stage.css` | 打开外部直链或本地媒体 | 音频使用定制控件，视频显示原生 controls；读取和缓冲显示状态，失败可重试 |
| `stores/theme.ts` | 选择亮色、深色或跟随系统 | 更新 `documentElement.dataset.theme`，由 CSS 变量立即切换调色板 |

表内路径均相对于 `web/src/`。

## 实装参数

页面与弹窗 CSS 时长写在 `index.css`，播放相关参数写在 `player.css` 和 `components/media-stage.css`；Motion 的列表与指示器时长读取 `primitives.tsx` 的 `DURATION`。下表只列正在使用的参数。

| 动画 | 进入或变化 | 退出 | 延迟/错峰 | 位移/缩放 | 缓动 |
| --- | --- | --- | --- | --- | --- |
| 页面进入 | 280ms | — | — | y：12px → 0 | `cubic-bezier(0.22, 0.61, 0.36, 1)` |
| 列表行进入 | 220ms | — | 相邻行 25ms | y：8px → 0，opacity：0 → 1 | `[0.22, 0.61, 0.36, 1]` |
| 分段选中块 | 260ms | — | — | `layoutId` 匹配位置与尺寸 | `[0.4, 0, 0.2, 1]` |
| 桌面侧栏宽度 | 250ms | 250ms | — | 76px ↔ 252px | `cubic-bezier(0.4, 0, 0.2, 1)` |
| 弹窗遮罩 | 180ms | 140ms | — | opacity：0 ↔ 1 | 进入 `ease-out`，退出 `ease-in` |
| 弹窗面板 | 180ms | 140ms | — | 进入 y：8px → 0、scale：0.98 → 1；退出 y：0 → 5px、scale：1 → 0.985 | 进入 `cubic-bezier(.22, .61, .36, 1)`，退出 `ease-in` |
| 登录内容 / Tab 面板 | 140ms | — | — | y：3px → 0，opacity：0 → 1 | `ease-out` |
| 音量位置与填充 | 即时 | — | — | 跟随有效音量 | — |
| 歌单封面播放状态 | 400ms | 400ms | — | 内边距 12px ↔ 0，外框尺寸保持 | `cubic-bezier(.2, .65, .3, 1)` |
| 播放器图标按钮 | 180ms | 180ms | — | 按压 scale：1 → 0.94；悬停背景与颜色过渡 | CSS 默认 `ease` |
| 队列行背景 | 150ms | 150ms | — | 悬停与当前项背景 | CSS 默认 `ease` |
| 队列播放指示条 | 每轮 900ms，往返循环 | 随播放状态移除 | 三列延迟 0 / -500 / -200ms | scaleY：0.3 ↔ 1 | `ease-in-out` |
| 外部媒体缓冲图标 | 每轮 1s，循环 | 状态结束后移除 | — | 旋转 360° | `linear` |
| 主题调色板 | 即时 | — | — | CSS 变量切换 | — |

## 播放界面的材质与生命周期

### 左右布局与玻璃层

`/preview` 的导航名称为“播放器”。桌面左侧呈现封面、歌曲、进度和控制，右侧呈现可搜索队列；小于 768px 时改为单列，队列保留独立滚动区域。空状态显示打开链接、本地文件和歌单入口。

`player-ambience` 将真实封面静态模糊 70px、放大 1.2 倍并降低透明度，再叠加深色渐变；缺少封面时使用品牌渐变。玻璃按钮使用 18–20px backdrop blur，队列、打开面板和迷你条使用 24px。背景色随当前封面更新，未添加持续漂移动画。设计参考 [Apple Music 网页播放器](https://support.apple.com/en-gb/guide/music-web/apdm333a63ec/web)与 [Apple 材质指南](https://developer.apple.com/design/human-interface-guidelines/materials)。

播放时封面内边距从 12px 收到 0，暂停时恢复；队列播放指示条仅表达当前播放状态。缓冲进度、时间与音量跟随媒体数据更新，操作目标保持固定布局。

### 大播放器与迷你条共用引擎

`AppShell` 的 `PlayerSlot` 为当前歌单挂载 `PlaybackEngine` 和迷你条。引擎管理音频元素、当前来源、进度、缓冲、播放意图与媒体错误；大播放器和迷你条通过 `usePlayback` 发出播放、暂停、定位动作，通过 `usePlayer` 切歌、切音质和改变随机/循环模式。

切换路由只改变可见控制界面；`/preview` 显示大播放器，其他页面显示迷你条。全屏调用当前播放器容器的 Fullscreen API，沿用现有引擎。媒体代次变化时元素可重建，初始化会同步有效音量；同曲换源恢复已有位置。支持 Media Session 的浏览器接收曲目/封面信息，并连接系统播放、暂停、切歌及定位动作。

### 外部直链与本地文件

打开外部媒体时先清空歌单播放器，再由当前页面的 `MediaStage` 管理独立媒体元素。它按媒体元数据区分音频与视频：音频显示定制进度、播放和音量控件，视频显示原生 controls。音量仍复用全局偏好；HLS 按需加载 hls.js，支持原生 HLS 的浏览器可使用原生播放。

切源、重试和卸载会结束原媒体的事件订阅与 HLS 实例；本地 Object URL 在切换或离页时回收。外部音频的缓冲图标采用 CSS 旋转，错误和重试反馈直接显示在媒体区域。

## 弹窗挂载、内容切换与焦点

### 公共 Dialog

`DialogContent` 给遮罩和面板分别添加 `.dialog-overlay`、`.dialog-surface`。它们在 `data-state="open"` 与 `"closed"` 时执行对应关键帧；关闭阶段设置 `pointer-events: none`。面板最大高度为 `calc(100dvh - 2rem)`，长内容在面板内滚动。

调用方保持 Dialog 组件挂载，用 `open` 控制状态，让 Radix 的内容生命周期等待 CSS 退出动画结束。不要在关闭时立即用外层条件删除整个组件。

Radix 负责模态焦点管理、Escape、遮罩关闭与 ARIA。公共组件在打开时记录原焦点；关闭时优先归还仍存在的原元素，缺少可用原元素时尝试公告入口。若另一个 Dialog 已打开，则保留新弹窗的焦点。

### 登录弹窗

`AppShell` 用 `loginMounted` 在第一次打开后持续挂载懒加载的 `LoginDialog`，后续关闭只改变 `open`。平台内容按 `active` key 切换；登录方式使用公共 `TabsContent` 的 140ms 进入动画。

表单还按登录代次 `epoch` 挂载。关闭、换平台或换方式后，旧异步响应的有效性由登录状态与任务取消逻辑处理，退出动画期间也沿用这套检查。

### 公告和歌单详情

- `AnnouncementDialog` 与登录复用同一个 `DialogContent`。应用挂载 800ms 后检查未读公告；排队公告在登录关闭且等待 220ms 后展示。手动公告入口直接请求打开；登录优先，公告在登录操作结束后恢复。无有效公告时隐藏入口和组件。
- `components/playlist-details.tsx` 的详情面板同样使用公共 Dialog，关闭通过 `open` 状态完成。卡片主入口打开详情，独立播放按钮保留；详情中的生成、复制与播放反馈沿用当前面板，未增加另一套弹窗动画。
- 公告、登录和详情共享遮罩、面板尺寸、滚动方式、退出动画与焦点归还逻辑。

## 键盘与减少动态效果

- `Segmented` 使用 `radiogroup` / `radio`、`aria-checked` 和 roving tab index；方向键循环切换，Home/End 跳到首尾，并聚焦目标项。
- Tabs 使用 Radix 的键盘行为和焦点状态；窄屏保持单行标签，横向浏览时文字完整。
- 本站歌单在 `/preview` 播放时，页面空白区域支持 Space 播放/暂停、← / → 定位前后 5 秒、M 静音、F 全屏。处理器跳过输入、搜索、可编辑文本、按钮、链接、滑块和 radio；弹窗打开、Ctrl/Alt/Meta 修饰键或重复按键时保持原行为。外部媒体使用自身定制或原生控件。
- Motion 层通过 `<MotionConfig reducedMotion="user">` 跟随系统偏好。CSS 层同时响应 `prefers-reduced-motion: reduce` 和旧版保存的 `[data-motion="reduced"]`，将动画与过渡时长设为 **0.001ms**。旧 `data-motion` 标记作用于 CSS；Motion 的系统偏好由 `MotionConfig` 处理。
- 页面进入使用 CSS，结束帧保持可见；减少动态效果下快速完成同一生命周期。Dialog 的开关、键盘关闭与焦点归还继续按状态执行。
- 播放器另在 `prefers-reduced-motion` 下关闭播放指示条、外部媒体缓冲图标和封面/按钮过渡；音量数值即时生效。
- `prefers-reduced-transparency` 下，队列、打开面板与玻璃按钮使用实色背景并移除背景模糊；播放按钮同样移除模糊。不支持 backdrop-filter 时，队列与打开面板使用高不透明度背景。

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
  {items.map(item => <ListItem key={item.id}>{item.name}</ListItem>)}
</ListReveal>
```

弹窗复用公共组件，并始终保留外层实例：

```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent aria-describedby={undefined}>
    <DialogHeader><DialogTitle>歌单详情</DialogTitle></DialogHeader>
    {children}
  </DialogContent>
</Dialog>
```

## 本地构建入口

```sh
npm --prefix web ci
npm --prefix cloudflare ci
npm run check
npm run build:worker
```

前端产物位于 `web/dist`，由 Worker 的 `assets` 绑定提供；`build:worker` 包含前端构建与 Worker dry-run。发布步骤见 [Cloudflare 部署说明](README.md)。
