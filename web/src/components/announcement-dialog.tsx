import * as React from 'react';
import { activeAnnouncement } from '@/lib/announcements';
import { useUi } from '@/stores/ui';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';

export function AnnouncementDialog() {
  const item = activeAnnouncement();
  const open = useUi(state => state.announcementOpen);
  const pending = useUi(state => state.announcementPending);
  const loginOpen = useUi(state => state.loginOpen);
  const showAnnouncement = useUi(state => state.showAnnouncement);
  const closeAnnouncement = useUi(state => state.closeAnnouncement);
  const [fullscreen, setFullscreen] = React.useState(() => !!document.fullscreenElement);

  React.useEffect(() => {
    const sync = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  React.useEffect(() => {
    if (!pending || loginOpen || fullscreen) return;
    // Let the preceding dialog finish returning focus before opening another.
    const timer = window.setTimeout(showAnnouncement, 220);
    return () => window.clearTimeout(timer);
  }, [pending, loginOpen, fullscreen, showAnnouncement]);

  if (!item) return null;
  return (
    <Dialog open={open && !loginOpen} onOpenChange={next => { if (!next) closeAnnouncement(); }}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{item.title}</DialogTitle>
          <time dateTime={item.date} className="text-xs text-muted-foreground">{item.date}</time>
        </DialogHeader>
        <div className="space-y-3 text-sm leading-relaxed">
          {item.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
        </div>
        <div className="mt-5 flex justify-end">
          <Button onClick={closeAnnouncement}>知道了</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
