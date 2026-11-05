import * as React from 'react';
import { ListMusic, Pause, Play, SkipBack, SkipForward, SlidersHorizontal, X } from 'lucide-react';
import { cn, formatBitrate, formatDuration } from '@/lib/utils';
import type { QualityOption } from '@/lib/types';
import { Badge } from '@/components/ui/card';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/tabs';
import { CoverArt } from '@/components/playlist-card';
import { VolumeControl } from '@/components/volume-control';
import { useCapabilities } from '@/hooks/use-capabilities';
import { usePlayer } from '@/stores/player';
import { effectiveVolume, useVolume } from '@/stores/volume';

export function MiniPlayer() {
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const attachAudio = React.useCallback((audio: HTMLAudioElement | null) => {
    audioRef.current = audio;
    if (audio) audio.volume = effectiveVolume(useVolume.getState());
  }, []);
  const playlist = usePlayer(state => state.playlist);
  const index = usePlayer(state => state.index);
  const source = usePlayer(state => state.source);
  const status = usePlayer(state => state.status);
  const message = usePlayer(state => state.message);
  const errorCode = usePlayer(state => state.errorCode);
  const quality = usePlayer(state => state.quality);
  const autoplay = usePlayer(state => state.autoplay);
  const generation = usePlayer(state => state.generation);
  const next = usePlayer(state => state.next);
  const prev = usePlayer(state => state.prev);
  const playIndex = usePlayer(state => state.playIndex);
  const setQuality = usePlayer(state => state.setQuality);
  const retry = usePlayer(state => state.retry);
  const markPlaying = usePlayer(state => state.markPlaying);
  const markPaused = usePlayer(state => state.markPaused);
  const fail = usePlayer(state => state.fail);
  const clear = usePlayer(state => state.clear);
  const volume = useVolume(state => state.volume);
  const muted = useVolume(state => state.muted);
  const { data: capabilities } = useCapabilities();

  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [queueOpen, setQueueOpen] = React.useState(false);
  const [progress, setProgress] = React.useState({ time: 0, duration: 0 });
  const positionRef = React.useRef(0);
  const retriedRef = React.useRef(false);
  const trackRef = React.useRef('');

  const track = playlist?.tracks[index] ?? null;
  const trackKey = `${playlist?.platform ?? ''}:${playlist?.id ?? ''}:${index}`;

  React.useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!source) { audio.pause(); audio.removeAttribute('src'); audio.load(); return; }
    // 同一首歌重新解析（切换音质、出错重试）时保留进度，切歌则从头播放
    const sameTrack = trackRef.current === trackKey;
    trackRef.current = trackKey;
    if (!sameTrack) {
      retriedRef.current = false;
      positionRef.current = 0;
      setProgress({ time: 0, duration: 0 });
    }
    audio.src = source.mediaUrl;
    const restorePosition = () => { if (sameTrack) audio.currentTime = positionRef.current; };
    audio.addEventListener('loadedmetadata', restorePosition, { once: true });
    if (autoplay) {
      void audio.play().catch(() => {
        // 浏览器可能拦截自动播放，此时交给用户手动点击
        if (usePlayer.getState().generation === generation && usePlayer.getState().source === source) {
          usePlayer.setState({ status: 'paused' });
        }
      });
    }
    return () => { audio.removeEventListener('loadedmetadata', restorePosition); };
  }, [source, autoplay, trackKey, generation]);

  // 音量是全局的：播放器重新挂载、切歌、切路由之后都要回到同一档
  React.useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.volume = effectiveVolume({ volume, muted });
  }, [volume, muted, source?.mediaUrl, generation]);

  const paused = status !== 'playing';
  // 跳转由 store 里的定时器负责，这里只提示用户
  const willSkip = status === 'error' && errorCode === 'unavailable'
    && !!playlist && index + 1 < playlist.tracks.length;

  if (!playlist || !track) return null;

  function handleError() {
    if (!source || usePlayer.getState().generation !== generation) return;
    if (!retriedRef.current) {
      retriedRef.current = true;
      void retry();
      return;
    }
    fail('无法播放这首歌曲，请重试或切换音质', generation);
  }


  return (
    <div className="max-h-[50dvh] shrink-0 overflow-y-auto overscroll-contain border-t border-border bg-card shadow-[0_-14px_34px_-26px_rgb(20_70_105/60%)]">
      <audio
        key={generation}
        ref={attachAudio}
        onPlay={() => markPlaying(generation)}
        onPause={() => markPaused(generation)}
        onEnded={() => { if (usePlayer.getState().generation === generation) void next(); }}
        onError={handleError}
        onTimeUpdate={event => {
          if (!source || usePlayer.getState().generation !== generation) return;
          positionRef.current = event.currentTarget.currentTime;
          setProgress({ time: event.currentTarget.currentTime, duration: Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0 });
        }}
        preload="metadata"
      />

      <div className="grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex sm:flex-wrap md:px-6">
        <CoverArt src={track.cover || playlist.cover} seed={track.id} className="size-11 shrink-0 rounded-lg" />

        <div className="min-w-0 flex-1 sm:max-w-[13rem]">
          <p className="truncate text-[13.5px] font-medium">{track.name}</p>
          <p className="truncate text-[11.5px] text-muted-foreground">
            {track.artist || playlist.name}
            {source ? ` · ${source.format.toUpperCase()} ${formatBitrate(source.bitrate)}` : ''}
          </p>
        </div>

        <div className="col-span-3 row-start-2 flex shrink-0 items-center justify-self-center gap-1.5 sm:order-none">
          <button
            type="button"
            onClick={() => void prev()}
            disabled={index === 0}
            aria-label="上一首"
            className="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          >
            <SkipBack className="size-[18px]" />
          </button>
          <button
            type="button"
            aria-label={paused ? '播放' : '暂停'}
            disabled={!source || status === 'loading'}
            onClick={() => {
              const audio = audioRef.current;
              if (!audio) return;
              if (audio.paused) void audio.play().catch((error: unknown) => {
                const current = usePlayer.getState();
                if (audioRef.current !== audio || current.generation !== generation || current.source !== source) return;
                if (error instanceof DOMException && error.name === 'AbortError') return;
                fail(error instanceof DOMException && error.name === 'NotAllowedError'
                  ? '播放被浏览器阻止，请再次点击播放' : '播放失败，请重试', generation);
              });
              else audio.pause();
            }}
            className="grid size-10 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_10px_20px_-10px_var(--primary)] transition-transform hover:scale-105"
          >
            {paused ? <Play className="size-[18px] fill-current" /> : <Pause className="size-[18px] fill-current" />}
          </button>
          <button
            type="button"
            onClick={() => void next()}
            disabled={index + 1 >= playlist.tracks.length}
            aria-label="下一首"
            className="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          >
            <SkipForward className="size-[18px]" />
          </button>
        </div>

        <div className="col-span-3 row-start-3 flex min-w-0 basis-full items-center gap-3 sm:order-last lg:order-none lg:basis-auto lg:flex-1">
          <span className="text-[11.5px] tabular-nums text-muted-foreground">{formatDuration(progress.time)}</span>
          <input
            type="range"
            aria-label="播放进度"
            aria-valuetext={`${formatDuration(progress.time)} / ${formatDuration(progress.duration)}`}
            min={0}
            max={progress.duration || 0}
            step={1}
            value={Math.min(progress.time, progress.duration || 0)}
            disabled={!source || !progress.duration}
            onChange={event => {
              const time = Number(event.target.value);
              if (audioRef.current) audioRef.current.currentTime = time;
              positionRef.current = time;
              setProgress(current => ({ ...current, time }));
            }}
            className="h-5 min-w-0 flex-1 cursor-pointer accent-primary"
          />
          <span className="text-[11.5px] tabular-nums text-muted-foreground">{formatDuration(progress.duration)}</span>
        </div>

        <div className="col-start-3 row-start-1 ml-auto flex shrink-0 items-center gap-1 sm:order-none sm:gap-1.5">
          <VolumeControl className="hidden xl:flex" />
          <Select value={quality} onValueChange={value => void setQuality(value as QualityOption['id'])}>
            <SelectTrigger className="hidden h-8 w-[8.5rem] lg:flex" aria-label="音质">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(capabilities?.qualities ?? []).map(option => (
                <SelectItem key={option.id} value={option.id} disabled={!option.enabled}>
                  {option.label} {option.format}
                  {option.enabled ? '' : '（不可用）'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            onClick={() => setSettingsOpen(value => !value)}
            aria-label="播放设置"
            aria-expanded={settingsOpen}
            className={cn('grid size-9 place-items-center rounded-lg text-muted-foreground hover:text-foreground xl:hidden', settingsOpen && 'bg-accent text-accent-foreground')}
          >
            <SlidersHorizontal className="size-[18px]" />
          </button>
          <button
            type="button"
            onClick={() => setQueueOpen(value => !value)}
            aria-label="播放队列"
            aria-expanded={queueOpen}
            className={cn(
              'grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:text-foreground',
              queueOpen && 'bg-accent text-accent-foreground',
            )}
          >
            <ListMusic className="size-[18px]" />
          </button>
          <button
            type="button"
            onClick={clear}
            aria-label="关闭播放器"
            className="grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-[18px]" />
          </button>
        </div>
      </div>

      {settingsOpen && (
        <div role="group" aria-label="播放设置" className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-2 xl:hidden">
          <VolumeControl className="w-36" />
          <Select value={quality} onValueChange={value => void setQuality(value as QualityOption['id'])}>
            <SelectTrigger className="h-9 w-36 lg:hidden" aria-label="音质"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(capabilities?.qualities ?? []).map(option => (
                <SelectItem key={option.id} value={option.id} disabled={!option.enabled}>
                  {option.label} {option.format}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {(message || status === 'error' || source?.trial) && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2.5 md:px-6" role="status">
          {source?.trial && <Badge variant="outline">试听片段</Badge>}
          {message && (
            <p className={cn('text-[11.5px]', status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
              {message}
            </p>
          )}
          {status === 'error' && <button type="button" className="text-xs font-medium text-primary underline" onClick={() => { retriedRef.current = false; void retry(); }}>重试</button>}
          {willSkip && <span className="text-[11.5px] text-muted-foreground">即将跳到下一首…</span>}
        </div>
      )}

      {queueOpen && (
        <ul className="max-h-[25dvh] overflow-y-auto border-t border-border p-2">
          {playlist.tracks.map((item, position) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => void playIndex(position)}
                aria-current={position === index}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] transition-colors',
                  position === index ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                )}
              >
                <span className="w-6 shrink-0 text-[11.5px] tabular-nums text-muted-foreground">{position + 1}</span>
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
                  {formatDuration(item.duration)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
