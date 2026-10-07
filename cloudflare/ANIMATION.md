# 界面动画

原生 HTML / JavaScript SPA 使用 **GSAP 3.15.0**。动画入口为 `public/js/motion.js` 的 `window.MfuMotion`，业务代码只调用统一方法。库从本站 `/js/vendor/gsap-3.15.0.min.js` 加载。

## 修改位置与触发条件

| 位置 | 触发条件 | 实现 |
| --- | --- | --- |
| `public/js/main.js` → `renderView` | 首次加载、链接生成/我的音乐/视频预览/账号管理/关于切换、浏览器前进/后退 | `MfuMotion.page` 使用 GSAP Timeline 先退出旧页面，再挂载新页面并分层进入；路由序号丢弃过期请求 |
| `public/includes/header.html` → `.sidebar-nav` | 切换工作台页面 | 复用 `syncIndicator` 与同一套 GSAP 缓动配置，让导航选中块跟随入口位置与尺寸 |
| `public/views/home.html` → `.platform-tabs` | 切换网易云/QQ 音乐 | `data-motion-tabs` 声明可复用滑块；`syncIndicator` 用 `gsap.to` 平滑更新 x、y、width、height |
| `public/views/user.html` → 平台/我的歌单/我的收藏/最近播放 | 切换平台或内容 Tab | `select` 将选中块与内容面板协同切换；淡出旧面板，按方向平移并淡入新面板，同时跟随内容高度变化 |
| `public/js/main.js` → 六组列表加载/渲染、`renderPagination` | 首次加载、翻页、收藏和最近播放列表更新 | `loading` 保留现有列表并暂时禁用操作；`listContent` 淡出、替换、错峰进入；`pagination` 保留选中块并动画更新位置 |
| `public/includes/footer.html` → 登录弹窗 | 打开、关闭按钮、Escape、点击遮罩 | `modal` 用一条 Timeline 控制遮罩和玻璃窗口；退出完成后解除背景 inert 并恢复焦点 |
| `public/includes/footer.html` → 登录平台和登录方式 | 切换扫码、验证码、密码、Cookie 或平台 | 同一套 `select` 和滑块控制器；隐藏内容 inert，不参与键盘焦点循环 |
| `.list-item`、`.url-option` | 支持悬浮的鼠标进入/离开 | 文档事件委托调用 `gsap.to`：上浮 2px，渐入玻璃高光；触屏关闭悬浮效果 |
| 按钮、返回按钮、主题图标 | 指针按下/松开、Enter/Space | 事件委托统一缩放反馈，取消或窗口失焦时恢复 |
| `#resultSection`、`#toast` | 生成成功、平台切换、提示更新/超时 | `reveal` / `hide` / `toast` 控制淡入淡出与短距离位移；重复提示替换旧计时器 |

截图中的个人中心同时调整为紧凑玻璃列表：独立圆角行、统一封面和操作按钮尺寸、玻璃胶囊 Tab 与分页。保持天蓝与白色，说明文字不额外加入界面。

## 实装参数

所有时长均以秒配置。文本不做模糊、旋转或大幅缩放。

| 动画 | 进入 | 退出 | 延迟/错峰 | 位移/缩放 | GSAP 缓动 |
| --- | --- | --- | --- | --- | --- |
| 页面 | 280ms | 120ms | 区块相隔 40ms | 进入 y=12px，退出 y=-6px | `power2.out` / `power1.in` |
| Tab 内容面板 | 240ms | 120ms | 新面板延迟 40ms，与退出重叠 | 横向 10px；高度同步 | `power2.out` / `power1.in` |
| Tab/分页滑块 | 260ms | — | 0 | 匹配按钮位置和尺寸 | `power3.inOut` |
| 歌单列表 | 220ms | 100ms | 每行间隔 25ms | 进入 y=8px，退出 y=-4px | `power2.out` / `power1.in` |
| 弹窗 | 280ms | 180ms | 遮罩同步 | y=16px，scale=0.98→1 | `power3.out` / `power2.in` |
| 卡片悬浮 | 180ms | 180ms | 0 | 上浮 2px，高光渐变 | `power2.out` |
| 按钮 | 按下 90ms | 松开 160ms | 0 | scale=0.97→1 | `power2.out` |
| 提示 | 200ms | 150ms | 停留 3 秒 | y=10px→0 | `power2.out` |

## 复用示例

```html
<div class="tabs" data-motion-tabs role="group" aria-label="内容">
  <button class="tab-btn active" aria-pressed="true">我的歌单</button>
  <button class="tab-btn" aria-pressed="false">我的收藏</button>
</div>
<div class="motion-panels">
  <div class="tab-content active">歌单内容</div>
  <div class="tab-content">收藏内容</div>
</div>
```

```js
MfuMotion.select(buttons, panels, selectedIndex);
MfuMotion.listContent(list, renderedHtml);

// motion.js 中的核心滑块实现；参数均来自 CONFIG。
gsap.to(marker, {
  x: active.offsetLeft,
  y: active.offsetTop,
  width: active.offsetWidth,
  height: active.offsetHeight,
  duration: CONFIG.indicator.duration, // 0.26
  ease: CONFIG.indicator.ease,         // power3.inOut
  overwrite: true
});
```

## 生命周期与无障碍

- `gsap.matchMedia` 动态响应 `prefers-reduced-motion`；减少动态效果时直接呈现终态，取消位移、缩放和旋转，保留操作与焦点行为。
- 新操作中断同一容器的旧 Timeline，旧 Promise 会结束，避免快速切换留下半透明内容或固定高度。
- `ResizeObserver` 校准滑块；移除的组件断开 Observer，取消所属动画与加载旋转。
- 请求期间保留列表高度、暂时禁用列表和分页；完成后恢复操作。过期路由请求不会替换当前页面。
- 弹窗持续保持焦点循环、背景 inert 和 Escape 关闭；关闭完成后才恢复背景操作。
- 加载动画也由 GSAP 管理；移除了原有 CSS keyframes 和交互 transition。
- GSAP 文件加载失败时，动画模块执行即时切换，核心操作仍可使用。

## 依赖与部署

在 `cloudflare/` 中执行：

```sh
npm ci
npm run build:assets
npm run dev
npm run deploy
```

`predev` 与 `predeploy` 自动调用 `scripts/sync-motion.mjs`，从锁定的 npm 包同步本地压缩文件，并保留上游许可声明。静态文件随项目提交，原有 Node 部署也可直接加载。

参考：[GSAP 安装](https://gsap.com/docs/v3/Installation/)、[GSAP matchMedia](https://gsap.com/docs/v3/GSAP/gsap.matchMedia()/)。
