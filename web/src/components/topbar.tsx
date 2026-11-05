import { Bell } from 'lucide-react';
import { AccountMenu } from '@/components/account-menu';
import { ThemeToggle } from '@/components/theme-toggle';
import { activeAnnouncement } from '@/lib/announcements';
import { useUi } from '@/stores/ui';

export function Topbar() {
  const showAnnouncement = useUi(state => state.showAnnouncement);
  const unread = useUi(state => state.announcementUnread);
  return (
    <header className="relative flex h-[62px] shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-3 sm:px-4 md:px-8">
      <span className="hidden text-sm font-semibold text-muted-foreground sm:block">MusicForUrl</span>
      <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
        {activeAnnouncement() && (
          <button type="button" data-announcement-trigger aria-label={unread ? '公告，有新内容' : '公告'}
            onClick={showAnnouncement}
            className="relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            <Bell className="size-4" /><span>公告</span>
            {unread && <span aria-hidden="true" className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary" />}
          </button>
        )}
        <AccountMenu />
        <div className="shrink-0"><ThemeToggle /></div>
      </div>
    </header>
  );
}
