import * as React from 'react';
import { LoaderCircle, Pause, Play, Repeat, Repeat1, Search, Shuffle, SkipBack, SkipForward } from 'lucide-react';
import { cn, formatBitrate, formatDuration } from '@/lib/utils';
import { usePlayer } from '@/stores/player';
import { usePlayback } from '@/stores/playback';
import { useCapabilities } from '@/hooks/use-capabilities';
import { CoverArt } from '@/components/playlist-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/tabs';
import type { QualityId } from '@/lib/types';

export function PlayerTransport({ compact = false }: { compact?: boolean }) {
  const { playlist, source, status, shuffle, repeat, toggleShuffle, cycleRepeat, next, prev, canPrevious, canNext } = usePlayer();
  const busy = usePlayback(state => state.busy);
  const toggle = usePlayback(state => state.toggle);
  const RepeatIcon = repeat === 'one' ? Repeat1 : Repeat;
  const repeatLabel = repeat === 'off' ? '循环关闭' : repeat === 'all' ? '列表循环' : '单曲循环';
  return <div className={cn('player-transport', compact && 'is-compact')} role="group" aria-label="播放控制">
    {!compact && <button className="player-icon player-mode" aria-label="随机播放" aria-pressed={shuffle} title="随机播放" onClick={toggleShuffle} disabled={!playlist || playlist.tracks.length < 2}><Shuffle /></button>}
    <button className="player-icon player-skip" aria-label="上一首" title="上一首" onClick={() => void prev()} disabled={!canPrevious}><SkipBack className="fill-current" /></button>
    <button className="player-icon player-play" aria-label={status === 'playing' ? '暂停' : '播放'} title={status === 'playing' ? '暂停' : '播放'} disabled={!source || status === 'loading'} onClick={toggle}>
      {(status === 'loading' || busy) ? <LoaderCircle className="animate-spin" /> : status === 'playing' ? <Pause className="fill-current" /> : <Play className="fill-current" />}
    </button>
    <button className="player-icon player-skip" aria-label="下一首" title="下一首" onClick={() => void next()} disabled={!canNext}><SkipForward className="fill-current" /></button>
    {!compact && <button className="player-icon player-mode" aria-label={`${repeatLabel}，点击切换`} aria-pressed={repeat !== 'off'} title={repeatLabel} disabled={!playlist} onClick={cycleRepeat}><RepeatIcon /></button>}
  </div>;
}

export function PlayerProgress({ compact = false }: { compact?: boolean }) {
  const { time, duration, buffered, seek } = usePlayback();
  const source = usePlayer(state => state.source);
  return <div className={cn('player-progress', compact && 'is-compact')}>
    <div className="player-seek" style={{ '--played': `${duration ? Math.min(100, time / duration * 100) : 0}%`, '--buffered': `${duration ? Math.min(100, buffered / duration * 100) : 0}%` } as React.CSSProperties}>
      <span aria-hidden="true" className="player-seek-track" />
      <input type="range" min={0} max={duration || 0} step={0.1} value={Math.min(time, duration || 0)} disabled={!source || !duration} aria-label="播放进度" aria-valuetext={`${formatDuration(time)} / ${formatDuration(duration)}`} onChange={event => seek(Number(event.target.value))} />
    </div>
    <div className="player-time"><span>{formatDuration(time)}</span><span>{duration ? `−${formatDuration(Math.max(0, duration - time))}` : '0:00'}</span></div>
  </div>;
}

export function PlayerQuality() {
  const quality = usePlayer(state => state.quality);
  const source = usePlayer(state => state.source);
  const setQuality = usePlayer(state => state.setQuality);
  const { data } = useCapabilities();
  const [container, setContainer] = React.useState<HTMLElement | undefined>();
  const labels: Record<QualityId, string> = { low: '标准', medium: '较高', high: '高品质', lossless: '无损' };
  const options = data?.qualities ?? [{ id: quality, label: labels[quality], format: source?.format.toUpperCase() ?? 'MP3', bitrate: null, enabled: true, reason: '' }];
  const selected = options.find(option => option.id === quality);
  return <div className="player-quality">
    <Select value={quality} onValueChange={value => void setQuality(value as QualityId)} onOpenChange={open => {
      if (open) setContainer(document.fullscreenElement instanceof HTMLElement ? document.fullscreenElement : undefined);
    }}>
      <SelectTrigger className="player-quality-trigger" aria-label="音质" title="选择音质"><SelectValue>{selected?.label ?? labels[quality]}</SelectValue></SelectTrigger>
      <SelectContent container={container} side="top" align="end" sideOffset={10} collisionPadding={12} className="player-quality-menu" aria-label="音质选项">
        {source && <div className="player-quality-source"><span>当前音源</span><strong>{source.format.toUpperCase()}{source.bitrate ? ` · ${formatBitrate(source.bitrate)}` : ''}</strong></div>}
        {options.map(option => <SelectItem key={option.id} value={option.id} textValue={option.label} disabled={!option.enabled} title={!option.enabled ? option.reason : undefined} className="player-quality-option">
          <span className="player-quality-option-text"><strong>{option.label}</strong><span>{option.enabled ? [option.format, formatBitrate(option.bitrate)].filter(Boolean).join(' · ') : '当前不可用'}</span></span>
        </SelectItem>)}
      </SelectContent>
    </Select>
  </div>;
}

export function PlayerFeedback() {
  const { message, status, source, retry, errorCode, orderIndex, order } = usePlayer();
  if (!message && status !== 'error' && !source?.trial) return null;
  return <div className="player-feedback" role={status === 'error' ? 'alert' : 'status'}>
    {source?.trial && <span className="player-trial">试听片段</span>}{message && <span>{message}</span>}
    {status === 'error' && <button onClick={() => void retry()}>重试</button>}
    {errorCode === 'unavailable' && orderIndex + 1 < order.length && <span>即将播放下一首</span>}
  </div>;
}

export function PlayerQueue({ compact = false }: { compact?: boolean }) {
  const playlist = usePlayer(state => state.playlist);
  const index = usePlayer(state => state.index);
  const order = usePlayer(state => state.order);
  const orderIndex = usePlayer(state => state.orderIndex);
  const status = usePlayer(state => state.status);
  const playIndex = usePlayer(state => state.playIndex);
  const [query, setQuery] = React.useState('');
  const [limit, setLimit] = React.useState(100);
  const [locate, setLocate] = React.useState(0);
  const activeRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => { setQuery(''); setLimit(100); }, [playlist?.id, playlist?.platform]);
  React.useEffect(() => { setLimit(value => Math.max(value, orderIndex + 25)); }, [orderIndex]);
  React.useEffect(() => {
    const row = activeRef.current;
    const list = row?.closest('ol');
    if (!locate || !row || !list) return;
    const itemRect = row.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    list.scrollTop += itemRect.top - listRect.top - (list.clientHeight - itemRect.height) / 2;
  }, [locate]);
  const results = React.useMemo(() => order.map(position => ({ track: playlist?.tracks[position], position }))
    .filter(item => item.track && `${item.track.name} ${item.track.artist}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [playlist, order, query]);
  if (!playlist) return null;
  return <section className={cn('player-queue', compact && 'is-compact')} aria-label="播放队列">
    <header className="player-queue-heading"><div><h2>播放队列</h2><p>{playlist.name}</p></div><span>{orderIndex + 1} / {playlist.tracks.length}</span></header>
    {!compact && <div className="player-queue-tools"><label className="player-search"><Search size={16} /><input aria-label="搜索队列" placeholder="搜索歌曲或歌手" value={query} onChange={event => { setQuery(event.target.value); setLimit(100); }} /></label><button className="player-locate" onClick={() => { setQuery(''); setLimit(value => Math.max(value, orderIndex + 1)); setLocate(value => value + 1); }}>当前</button></div>}
    <ol className="player-queue-list">{results.slice(0, limit).map(({ track, position }, number) => track && <li key={`${position}:${track.id}`}>
      <button ref={position === index ? activeRef : undefined} className="player-queue-song" onClick={() => void playIndex(position)} aria-current={position === index ? 'true' : undefined} aria-label={`播放 ${track.name}`}>
        <span className="player-queue-number">{position === index && status === 'playing' ? <span className="player-equalizer" aria-label="正在播放"><i /><i /><i /></span> : number + 1}</span>
        <CoverArt src={track.cover || playlist.cover} seed={track.id} className="player-queue-cover" />
        <span className="player-queue-meta"><strong>{track.name}</strong><span>{track.artist || '未知歌手'}</span></span><span className="player-queue-duration">{track.duration > 0 ? formatDuration(track.duration) : '—'}</span>
      </button></li>)}
      {!results.length && <li className="player-queue-empty">没有找到相关歌曲</li>}
      {results.length > limit && <li><button className="player-load-more" onClick={() => setLimit(value => value + 100)}>显示更多歌曲</button></li>}
    </ol>
  </section>;
}
