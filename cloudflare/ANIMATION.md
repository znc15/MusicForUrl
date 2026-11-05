# 界面动画

本文对应 **2.3.0** 的 React + Vite 前端。页面和弹窗使用 CSS 关键帧，列表与分段指示器使用 `motion`。公共入口为 `web/src/motion/primitives.tsx`、`web/src/index.css` 和 `web/src/components/ui/dialog.tsx`。

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
| `components/sidebar.tsx` → 手机导航 | 视口小于 768px、切换页面 | 顶部五列导航，图标下显示“生成 / 音乐 / 预览 / 账号 / 关于”；激活项切换颜色，保持点击位置稳定 |
| `motion/primitives.tsx` → `Segmented` | 首页和登录弹窗切换平台 | `layoutId` 共享选中块移动；每个实例用 `useId` 隔离。选项单行排列，宽度不足时横向滚动 |
| `components/ui/tabs.tsx` | 切换登录方式或“我的音乐”分类 | Radix 管理 Tab 状态；选中项显示主色下边线。标签不拆行，容器横向滚动；新面板使用 `dialog-content-enter` |
| `motion/primitives.tsx` → `ListReveal` / `ListItem` | 歌单、收藏、最近播放列表挂载 | 行项目淡入并向上归位，逐项错峰 |
| `components/ui/dialog.tsx` | 登录、公告、歌单详情打开/关闭 | Radix 的 `data-state` 触发项目 CSS；遮罩淡入淡出，面板轻微位移与缩放 |
| `components/login-dialog.tsx` | 切换平台或登录方式 | 平台内容按 `key={active}` 重新挂载；外层和 Tab 面板均使用短进入动画，旧内容直接替换 |
| `components/account-menu.tsx` | 点击顶栏账号入口 | 菜单直接挂载/卸载；箭头随状态旋转。点击外部或 Escape 关闭 |
| `components/volume-control.tsx` | 点击、拖动、键盘调节或静音 | 填充宽度和滑块位置即时更新；滑块圆点在悬停、聚焦或拖动时淡入 |
| `components/mini-player.tsx` | 播放状态变化、切歌、展开队列 | 状态驱动内容和按钮，播放控件保持稳定位置 |
| `stores/theme.ts` | 选择亮色、深色或跟随系统 | 更新 `documentElement.dataset.theme`，由 CSS 变量立即切换调色板 |

表内路径均相对于 `web/src/`。

## 实装参数

CSS 时长直接写在 `index.css`；Motion 的列表与指示器时长读取 `primitives.tsx` 的 `DURATION`。下表只列正在使用的参数。

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
| 主题调色板 | 即时 | — | — | CSS 变量切换 | — |

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
- Motion 层通过 `<MotionConfig reducedMotion="user">` 跟随系统偏好。CSS 层同时响应 `prefers-reduced-motion: reduce` 和旧版保存的 `[data-motion="reduced"]`，将动画与过渡时长设为 **0.001ms**。旧 `data-motion` 标记作用于 CSS；Motion 的系统偏好由 `MotionConfig` 处理。
- 页面进入使用 CSS，结束帧保持可见；减少动态效果下快速完成同一生命周期。Dialog 的开关、键盘关闭与焦点归还继续按状态执行。
- 音量数值即时生效，播放控件保持稳定位置；辅助淡入和颜色过渡遵循上述 CSS 设置。

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
