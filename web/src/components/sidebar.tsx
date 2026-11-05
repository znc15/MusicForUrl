import * as React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  CircleUserRound, Info, Library, Link2, MonitorPlay, PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import { cn, imageSrc } from '@/lib/utils';
import { NAV_ORDER, VIEW_TITLES, viewPath, type ViewName } from '@/lib/routes';
import { platformInfo, platformShort } from '@/lib/platforms';
import type { Platform } from '@/lib/types';
import { ThemeChoice } from '@/components/theme-toggle';
import { useAuth } from '@/stores/auth';
import { useUi } from '@/stores/ui';

const ICONS: Record<ViewName, typeof Link2> = {
  home: Link2,
  user: Library,
  preview: MonitorPlay,
  accounts: CircleUserRound,
  about: Info,
};

const MOBILE_LABELS: Record<ViewName, string> = { home: '生成', user: '音乐', preview: '播放', accounts: '账号', about: '关于' };

const EXPANDED_WIDTH = 252;
const COLLAPSED_WIDTH = 76;

/**
 * 底部唯一的账号头像。它跟着「我的音乐」当前选中的平台走，只代表那个平台
 * 当前生效的账号；其它平台与其它账号都在顶栏的账号菜单和账号管理页里。
 */
function AccountAvatar({ platform, expanded }: { platform: Platform; expanded: boolean }) {
  const user = useAuth(state => state.users[platform]);
  const openLogin = useUi(state => state.openLogin);
  const info = platformInfo(platform);

  if (!user) {
    return (
      <button
        type="button"
        onClick={() => openLogin(platform)}
        title={`登录${info.label}`}
        className={cn(
          'flex items-center rounded-lg transition-colors hover:bg-white/8',
          expanded ? 'min-w-0 flex-1 gap-2.5 px-2 py-1.5 text-left' : 'size-11 justify-center',
        )}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-full border border-dashed border-white/25 text-rail-foreground">
          <CircleUserRound className="size-4" />
        </span>
        {expanded && (
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-rail-foreground">
            登录{info.short}
          </span>
        )}
      </button>
    );
  }

  return (
    <NavLink
      to="/accounts"
      title={`${user.nickname || '已登录'} · ${info.label} · ID ${user.userId}`}
      className={({ isActive }) => cn(
        'flex items-center rounded-lg transition-colors',
        expanded ? 'min-w-0 flex-1 gap-2.5 px-2 py-1.5' : 'size-11 justify-center',
        isActive
          ? 'bg-rail-active text-rail-active-foreground'
          : 'text-rail-foreground hover:bg-white/8 hover:text-rail-active-foreground',
      )}
    >
      <span className="relative shrink-0">
        <img
          src={imageSrc(user.avatar)}
          alt=""
          className="size-9 rounded-full border border-white/20 object-cover"
          onError={event => { event.currentTarget.src = '/placeholder.svg'; }}
        />
        <span
          aria-hidden="true"
          className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-rail bg-success"
        />
      </span>
      {expanded && (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-rail-active-foreground">
            {user.nickname || '已登录'}
          </span>
          <span className="block truncate text-[11px] text-rail-foreground">
            {platformShort(platform)} · ID {user.userId}
          </span>
        </span>
      )}
    </NavLink>
  );
}

/**
 * 侧边栏。
 *
 * 层级自上而下：品牌 → 主导航 → 外观 → 账号头像与收起开关。收起时只留图标、
 * 唯一的账号头像与开关。账号头像跟随「我的音乐」当前平台，其它账号在顶栏的
 * 账号菜单里；音量只在底部播放条。展开状态写在本机，默认收起。
 *
 * 窄屏（< md）没有展开空间，此时它退化成顶部图标条，账号与外观入口交给顶栏——
 * 与其做一个半成品的抽屉，不如让每个断点只有一套明确的交互。
 */
export function Sidebar() {
  const collapsed = useUi(state => state.sidebarCollapsed);
  const toggleSidebar = useUi(state => state.toggleSidebar);
  const personalPlatform = useUi(state => state.personalPlatform);
  const location = useLocation();
  const expanded = !collapsed;

  // 窄屏下始终按收起渲染，避免布局在断点处抖动
  const [wide, setWide] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia('(min-width: 768px)');
    const sync = () => setWide(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  const showExpanded = wide && expanded;

  const itemClass = (active: boolean) => cn(
    'flex items-center rounded-lg transition-colors',
    !wide ? 'min-h-12 flex-col justify-center gap-1 text-[11px]' : showExpanded ? 'h-9 gap-2.5 px-2.5 text-[13.5px]' : 'size-11 justify-center',
    active
      ? 'bg-rail-active text-rail-active-foreground'
      : 'text-rail-foreground hover:bg-white/8 hover:text-rail-active-foreground',
  );

  return (
    <nav
      aria-label="主导航"
      aria-expanded={wide ? expanded : undefined}
      style={{ '--rail-width': `${showExpanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH}px` } as React.CSSProperties}
      className={cn(
        'flex shrink-0 items-center gap-1 bg-rail px-2 py-1.5',
        'md:h-full md:flex-col md:gap-1 md:px-3 md:py-4',
        showExpanded ? 'md:items-stretch' : 'md:items-center',
        'md:w-[var(--rail-width)] md:transition-[width] md:duration-[250ms] md:ease-[cubic-bezier(0.4,0,0.2,1)]',
      )}
    >
      {/* 品牌独占顶部；收起与展开的切换放在底部，和账号入口待在一起 */}
      <div className={cn('hidden items-center md:flex', showExpanded ? 'gap-2.5 md:mb-3' : 'md:mb-2 md:justify-center')}>
        <NavLink to="/" aria-label="MusicForUrl 首页" className="flex items-center gap-2.5 md:min-w-0">
          <img src="/brand.svg" alt="" className="size-7 shrink-0" />
          {showExpanded && (
            <span className="truncate text-[14px] font-semibold text-rail-active-foreground">MusicForUrl</span>
          )}
        </NavLink>
      </div>

      <ul id="main-navigation" className="grid w-full grid-cols-5 gap-1 md:flex md:flex-col md:gap-1">
        {NAV_ORDER.map(view => {
          const Icon = ICONS[view];
          const active = location.pathname.replace(/\.html$/, '') === viewPath(view);
          return (
            <li key={view} className="min-w-0">
              <NavLink
                to={viewPath(view)}
                end={view === 'home'}
                title={showExpanded ? undefined : VIEW_TITLES[view]}
                aria-label={VIEW_TITLES[view]}
                aria-current={active ? 'page' : undefined}
                className={itemClass(active)}
              >
                <Icon className="size-[18px] shrink-0" />
                {!wide ? <span className="whitespace-nowrap">{MOBILE_LABELS[view]}</span> : showExpanded && <span className="truncate">{VIEW_TITLES[view]}</span>}
              </NavLink>
            </li>
          );
        })}
      </ul>

      <div className="hidden md:mt-auto md:flex md:flex-col md:gap-2">
        {showExpanded && (
          <div className="rounded-lg border border-white/10 p-2.5">
            <p className="pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-rail-foreground/70">
              外观
            </p>
            <ThemeChoice tone="rail" />
          </div>
        )}

        <div
          className={cn(
            'border-t border-white/10 pt-3',
            showExpanded ? 'flex items-center gap-2' : 'flex flex-col items-center gap-2',
          )}
        >
          <AccountAvatar platform={personalPlatform} expanded={showExpanded} />
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={expanded ? '收起侧边栏' : '展开侧边栏'}
            aria-controls="main-navigation"
            title={expanded ? '收起侧边栏' : '展开侧边栏'}
            className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.06] text-rail-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] transition-colors hover:border-white/20 hover:bg-white/12 hover:text-rail-active-foreground md:grid"
          >
            {expanded ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
          </button>
        </div>
      </div>
    </nav>
  );
}
