import * as React from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, LogIn, LogOut, Settings2, ShieldCheck, UserRoundPlus } from 'lucide-react';
import { cn, imageSrc } from '@/lib/utils';
import { ACCOUNT_PLATFORMS, platformInfo } from '@/lib/platforms';
import type { Platform } from '@/lib/types';
import { Badge } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/stores/auth';
import { useUi } from '@/stores/ui';

/** 已登录平台的账号摘要：头像 + 昵称 + 账号标识 + 登录状态。 */
function AccountRow({ platform, onNavigate }: { platform: Platform; onNavigate: () => void }) {
  const user = useAuth(state => state.users[platform]);
  const token = useAuth(state => state.tokens[platform]);
  const openLogin = useUi(state => state.openLogin);
  const logout = useAuth(state => state.logout);
  const info = platformInfo(platform);

  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      {user ? (
        <img
          src={imageSrc(user.avatar)}
          alt=""
          className="size-9 shrink-0 rounded-full border border-border object-cover"
          onError={event => { event.currentTarget.src = '/placeholder.svg'; }}
        />
      ) : (
        <span className="grid size-9 shrink-0 place-items-center rounded-full border border-dashed border-border text-muted-foreground">
          <UserRoundPlus className="size-4" />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">
          {user ? (user.nickname || '未命名账号') : `未登录${info.short}`}
        </p>
        <p className="truncate text-[11.5px] text-muted-foreground">
          {user
            ? `${info.label} · ID ${user.userId}${user.vipType ? ` · VIP ${user.vipType}` : ''}`
            : info.label}
        </p>
      </div>

      {user ? (
        <div className="flex shrink-0 items-center gap-1">
          <Badge variant={token ? 'success' : 'outline'} className="gap-1">
            <ShieldCheck className="size-3" />{token ? '已登录' : '失效'}
          </Badge>
          <button
            type="button"
            aria-label={`退出${info.label}`}
            title="退出登录"
            onClick={async () => { await logout(platform); onNavigate(); }}
            className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <LogOut className="size-3.5" />
          </button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => { openLogin(platform); onNavigate(); }}
        >
          <LogIn />登录
        </Button>
      )}
    </div>
  );
}

/**
 * 顶栏的账号入口。收起态显示叠加头像与昵称，点开是一份逐平台的账号清单，
 * 包含头像、昵称、账号标识与登录状态——这正是「账号区域」需要展示的最小集合。
 */
export function AccountMenu() {
  const users = useAuth(state => state.users);
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  const signedIn = ACCOUNT_PLATFORMS.filter(item => users[item.id]);
  const primary = signedIn[0] ?? null;

  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="账号"
        className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 text-[13px] transition-colors hover:bg-accent"
      >
        {signedIn.length ? (
          <span className="flex shrink-0 items-center">
            {signedIn.map((item, index) => (
              <img
                key={item.id}
                src={imageSrc(users[item.id]?.avatar)}
                alt=""
                style={{ marginLeft: index ? -8 : 0, zIndex: signedIn.length - index }}
                className="relative size-6 rounded-full border border-card object-cover"
                onError={event => { event.currentTarget.src = '/placeholder.svg'; }}
              />
            ))}
          </span>
        ) : (
          <span className="grid size-6 place-items-center rounded-full border border-dashed border-border text-muted-foreground">
            <UserRoundPlus className="size-3.5" />
          </span>
        )}
        <span className="max-w-[8rem] truncate text-center font-medium">
          {primary ? (users[primary.id]?.nickname || '已登录') : '登录音乐账号'}
        </span>
        {signedIn.length > 1 && (
          <span className="text-[11.5px] text-muted-foreground">+{signedIn.length - 1}</span>
        )}
        <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="账号"
          className="absolute right-0 top-full z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] max-h-[calc(100dvh-8rem)] overflow-y-auto overscroll-contain rounded-lg border border-border bg-popover shadow-lg"
        >
          <div className="divide-y divide-border">
            {ACCOUNT_PLATFORMS.map(item => (
              <AccountRow key={item.id} platform={item.id} onNavigate={() => setOpen(false)} />
            ))}
          </div>
          <div className="border-t border-border bg-muted/40 px-3 py-2">
            <Link
              to="/accounts"
              onClick={() => setOpen(false)}
              className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-primary hover:underline"
            >
              <Settings2 className="size-3.5" />管理账号
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
