// 路由表与旧版 public/js/workspace.js:14-19 保持一致，URL 面不变。
export type ViewName = 'home' | 'user' | 'preview' | 'accounts' | 'about';

export const VIEW_TITLES: Record<ViewName, string> = {
  home: '链接生成',
  user: '我的音乐',
  preview: '播放器',
  accounts: '账号管理',
  about: '关于',
};

export function routeFromPath(pathname: string): ViewName {
  const path = String(pathname || '/').replace(/\.html$/, '');
  if (path === '/user') return 'user';
  if (path === '/accounts') return 'accounts';
  if (path === '/preview') return 'preview';
  if (path === '/about') return 'about';
  return 'home';
}

export function viewPath(view: ViewName): string {
  return view === 'home' ? '/' : `/${view}`;
}

export const NAV_ORDER: ViewName[] = ['home', 'user', 'preview', 'accounts', 'about'];
