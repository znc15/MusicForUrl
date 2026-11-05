import * as React from 'react';
import { Copy, Play, RefreshCw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { GeneratedLink, Platform, PlaylistSummary } from '@/lib/types';
import { formatDateTime } from '@/lib/utils';
import { partialPlaylistMessage, playlistCountLabel } from '@/lib/playlist-presentation';
import { platformLabel } from '@/lib/platforms';
import { useAuth } from '@/stores/auth';
import { usePlayer } from '@/stores/player';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CoverArt } from '@/components/playlist-card';

export function PlaylistLinkActions({ result, platform, onPlay, onRetry, children }: {
  result: GeneratedLink; platform: Platform; onPlay: () => void; onRetry: () => void; children?: React.ReactNode;
}) {
  const field = React.useRef<HTMLInputElement>(null);
  const partial = partialPlaylistMessage(result.playlist);
  async function copy() {
    if (result.expiresAt && result.expiresAt <= Date.now()) {
      toast.error('播放地址已过期，请重新获取', { action: { label: '重新获取', onClick: onRetry } });
      return;
    }
    try {
      await navigator.clipboard.writeText(result.url);
      toast.success('播放地址已复制');
    } catch {
      field.current?.focus(); field.current?.select();
      toast.error('自动复制失败，已选中地址，请手动复制');
    }
  }
  return (
    <div className="min-w-0 space-y-3">
      <p className="text-[13px] text-muted-foreground">
        {platformLabel(platform)} · {playlistCountLabel(result.playlist)}
        {result.expiresAt ? ` · ${formatDateTime(new Date(result.expiresAt).toISOString())} 到期` : ''}
      </p>
      {partial && <p role="status" className="text-sm text-foreground">{partial}</p>}
      <input ref={field} readOnly value={result.url} aria-label="播放地址" onFocus={event => event.currentTarget.select()}
        className="h-10 w-full min-w-0 rounded-lg border border-border bg-muted/50 px-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void copy()}><Copy />复制播放地址</Button>
        <Button variant="outline" onClick={onPlay}><Play />播放</Button>
        {partial && <Button variant="ghost" onClick={onRetry}><RefreshCw />重新获取</Button>}
        {children}
      </div>
    </div>
  );
}

export function usePlaylistDetails(platform: Platform) {
  const token = useAuth(state => state.tokens[platform]);
  const [selection, setSelection] = React.useState<{ item: PlaylistSummary; platform: Platform; token: string } | null>(null);
  const [open, setOpen] = React.useState(false);
  const item = selection?.platform === platform && selection.token === token ? selection.item : null;
  return {
    openDetails(next: PlaylistSummary) { setSelection({ item: next, platform, token }); setOpen(true); },
    details: <PlaylistDetails item={item} platform={platform} token={token} open={open && !!item} onOpenChange={setOpen} />,
  };
}

function PlaylistDetails({ item, platform, token, open, onOpenChange }: {
  item: PlaylistSummary | null; platform: Platform; token: string; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [attempt, retry] = React.useReducer(value => value + 1, 0);
  const [state, setState] = React.useState<{ scope: string; result?: GeneratedLink; error?: string } | null>(null);
  const [playing, setPlaying] = React.useState(false);
  const scope = JSON.stringify([platform, token, item?.id, attempt]);
  const current = state?.scope === scope ? state : null;
  const selectionRef = React.useRef({ scope, open });
  selectionRef.current = { scope, open };
  React.useEffect(() => {
    if (!open || !item) return;
    const controller = new AbortController();
    setState(null); setPlaying(false);
    void api.generate(platform, item.id, { token, signal: controller.signal }).then(result => {
      if (!controller.signal.aborted && useAuth.getState().tokens[platform] === token) setState({ scope, result });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ scope, error: error instanceof Error ? error.message : '获取失败，请重试' });
    });
    return () => controller.abort();
  }, [open, scope, platform, token, item?.id]);

  async function play() {
    if (!item || playing) return;
    setPlaying(true);
    const played = await usePlayer.getState().open(platform, item.id);
    if (selectionRef.current.scope !== scope || !selectionRef.current.open) return;
    setPlaying(false);
    if (played) { onOpenChange(false); navigate('/preview'); }
    else if (usePlayer.getState().status === 'error') toast.error(usePlayer.getState().message);
  }
  const playlist = current?.result?.playlist ?? item;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{playlist?.name || '歌单详情'}</DialogTitle>
        </DialogHeader>
        {playlist && <CoverArt src={playlist.cover} seed={playlist.id} className="mb-4 size-24 rounded-lg" />}
        {!current && <p role="status" className="py-6 text-sm text-muted-foreground">正在获取歌单与播放地址…</p>}
        {current?.error && <div className="space-y-3"><p role="alert" className="text-sm text-destructive">{current.error}</p><Button variant="outline" onClick={retry}>重试</Button></div>}
        {current?.result && <PlaylistLinkActions result={current.result} platform={platform} onPlay={() => void play()} onRetry={retry} />}
        {playing && <p role="status" className="mt-3 text-sm text-muted-foreground">正在准备播放…</p>}
      </DialogContent>
    </Dialog>
  );
}
