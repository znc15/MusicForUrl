import * as React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from '@/components/sidebar';
import { Topbar } from '@/components/topbar';
import { PageTransition } from '@/motion/primitives';
import { Skeleton } from '@/components/ui/input';
import { usePlayer } from '@/stores/player';
import { useUi } from '@/stores/ui';
import { activeAnnouncement } from '@/lib/announcements';
import { routeFromPath } from '@/lib/routes';

// 播放条只有真正打开歌单后才出现，连同它的 Radix Select 一起按需加载
const MiniPlayer = React.lazy(() => import('@/components/mini-player').then(module => ({ default: module.MiniPlayer })));
const PlaybackEngine = React.lazy(() => import('@/components/playback-engine').then(module => ({ default: module.PlaybackEngine })));
// 登录弹窗只在点击后出现，没必要和首屏一起下载
const AnnouncementDialog = React.lazy(() => import('@/components/announcement-dialog').then(module => ({ default: module.AnnouncementDialog })));
const LoginDialog = React.lazy(() => import('@/components/login-dialog').then(module => ({ default: module.LoginDialog })));

function PlayerSlot() {
  const hasPlaylist = usePlayer(state => !!state.playlist);
  if (!hasPlaylist) return null;
  return (
    <React.Suspense fallback={null}>
      <PlaybackEngine />
      <MiniPlayer />
    </React.Suspense>
  );
}

/**
 * 应用外壳。四块区域的层级是固定的：
 *
 *   ┌──────────┬────────────────────────────┐
 *   │ 侧栏      │ 顶栏（账号 / 音量 / 主题）   │
 *   │ 导航      ├────────────────────────────┤
 *   │ 账号      │ 内容区（唯一滚动容器）       │
 *   │ 外观      ├────────────────────────────┤
 *   │          │ 播放条（常驻，跨路由不中断）  │
 *   └──────────┴────────────────────────────┘
 */
export function AppShell() {
  const location = useLocation();
  const view = routeFromPath(location.pathname);
  const setSidebar = useUi(state => state.setSidebar);
  const loginOpen = useUi(state => state.loginOpen);
  const [loginMounted, setLoginMounted] = React.useState(loginOpen);
  React.useEffect(() => { if (loginOpen) setLoginMounted(true); }, [loginOpen]);
  React.useEffect(() => {
    const timer = window.setTimeout(() => useUi.getState().queueAnnouncement(), 800);
    return () => window.clearTimeout(timer);
  }, []);

  // 窄屏没有展开侧栏的余地，进入时强制收起，避免从桌面缩小窗口后留下半截侧栏
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia('(max-width: 767px)');
    const sync = () => { if (query.matches) setSidebar(true); };
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, [setSidebar]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden md:flex-row">
      <Sidebar />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar />

        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-8 md:py-7">
          <PageTransition viewKey={view}>
            <React.Suspense fallback={<Skeleton className="h-64 w-full" />}>
              <Outlet />
            </React.Suspense>
          </PageTransition>
        </main>

        <PlayerSlot />
      </div>

      {loginMounted && (
        <React.Suspense fallback={null}>
          <LoginDialog />
        </React.Suspense>
      )}
      {activeAnnouncement() && <React.Suspense fallback={null}><AnnouncementDialog /></React.Suspense>}
    </div>
  );
}
