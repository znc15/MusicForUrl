import * as React from 'react';
import { toast } from 'sonner';
import { FolderOpen, MonitorPlay, X } from 'lucide-react';
import { parseStreamUrl } from '@/lib/api';
import { validateMediaUrl } from '@/lib/workspace-rules';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MediaStage } from '@/components/media-stage';
import { CoverArt } from '@/components/playlist-card';
import { PageHeader } from '@/components/page-header';
import { usePlayer } from '@/stores/player';

export function PreviewView() {
  const [input, setInput] = React.useState('');
  const [source, setSource] = React.useState<{ url: string; isHls: boolean; local: boolean } | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const playlist = usePlayer(state => state.playlist);
  const playerStatus = usePlayer(state => state.status);
  const playerMessage = usePlayer(state => state.message);
  const clearPlayer = usePlayer(state => state.clear);
  const openPlaylist = usePlayer(state => state.open);

  // 本地文件只通过 Object URL 预览，不上传；离开时释放
  React.useEffect(() => () => {
    if (source?.local) URL.revokeObjectURL(source.url);
  }, [source]);

  async function open(event: React.FormEvent) {
    event.preventDefault();
    const value = input.trim();
    if (!value) return;

    const stream = parseStreamUrl(value);
    if (stream) {
      setSource(null);
      if (await openPlaylist(stream.platform, stream.playlistId, stream.grant)) toast.success('歌单已载入');
      else if (usePlayer.getState().status === 'error') toast.error(usePlayer.getState().message);
      return;
    }

    try {
      const url = validateMediaUrl(value);
      const parsed = new URL(url);
      clearPlayer();
      setSource({ url, isHls: /\.m3u8$/i.test(parsed.pathname), local: false });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '链接无效');
    }
  }

  function openFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    clearPlayer();
    setSource({ url: URL.createObjectURL(file), isHls: /\.m3u8$/i.test(file.name), local: true });
    setInput(file.name);
  }

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5">
      <PageHeader
        eyebrow="Preview"
        title="媒体预览"
        description="粘贴本站生成的 stream.m3u8 链接、HTTPS 媒体直链，或选择本地文件。本地文件不会上传。"
      />

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-card)]">
        <form className="flex flex-col gap-2.5 sm:flex-row" onSubmit={open}>
          <Input
            value={input}
            onChange={event => setInput(event.target.value)}
            placeholder="粘贴播放链接或媒体直链"
            aria-label="媒体链接"
            autoComplete="off"
            spellCheck={false}
            className="h-11 min-h-11 flex-1"
          />
          <Button type="submit" disabled={playerStatus === 'loading'} className="h-11 px-6"><MonitorPlay />{playerStatus === 'loading' ? '加载中…' : '打开'}</Button>
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept="audio/*,video/*,.m3u8" className="hidden" onChange={openFile} />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <FolderOpen />选择本地文件
          </Button>
          {source && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (source.local) URL.revokeObjectURL(source.url);
                setSource(null);
                setInput('');
              }}
            >
              <X />清除
            </Button>
          )}
        </div>
      </section>

      {playerStatus === 'error' && !playlist && <p role="alert" className="text-sm text-destructive">{playerMessage}</p>}

      {source && <MediaStage src={source.url} isHls={source.isHls} />}

      {playlist && (
        <section className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-card)]">
          <CoverArt src={playlist.cover} seed={playlist.id} className="size-14 shrink-0 rounded-lg" />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold">{playlist.name}</p>
            <p className="text-[12.5px] text-muted-foreground">
              {playlist.tracks.length} 首 · 使用页面底部播放器控制
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
