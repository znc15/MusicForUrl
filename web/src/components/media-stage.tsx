import * as React from 'react';
import { LoaderCircle, Music2, Pause, Play, RotateCcw } from 'lucide-react';
import { cn, formatDuration } from '@/lib/utils';
import { effectiveVolume, useVolume } from '@/stores/volume';
import { VolumeControl } from '@/components/volume-control';
import './media-stage.css';

interface MediaStageProps {
  src: string;
  isHls: boolean;
  className?: string;
  title?: string;
}

/** External media keeps its own element; the playlist engine is cleared by the caller. */
export function MediaStage(props: MediaStageProps) {
  return <MediaSession key={`${props.isHls}:${props.src}`} {...props} />;
}

function MediaSession({ src, isHls, className, title = '媒体播放' }: MediaStageProps) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const activeRef = React.useRef(false);
  const attemptRef = React.useRef(0);
  const [attempt, setAttempt] = React.useState(0);
  const [error, setError] = React.useState('');
  const [kind, setKind] = React.useState<'loading' | 'audio' | 'video'>('loading');
  const [paused, setPaused] = React.useState(true);
  const [busy, setBusy] = React.useState(true);
  const [position, setPosition] = React.useState({ time: 0, duration: 0, live: false });
  const volume = useVolume(state => state.volume);
  const muted = useVolume(state => state.muted);

  const attachVideo = React.useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video;
    if (video) video.volume = effectiveVolume(useVolume.getState());
  }, []);

  React.useEffect(() => {
    const video = videoRef.current;
    if (video) video.volume = effectiveVolume({ volume, muted });
  }, [volume, muted]);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    activeRef.current = true;
    const run = ++attemptRef.current;
    let cancelled = false;
    let hls: import('hls.js').default | null = null;
    let recovered = false;
    const current = () => !cancelled && activeRef.current && attemptRef.current === run;
    const fail = (message: string) => {
      if (!current()) return;
      setError(message);
      setBusy(false);
      setPaused(true);
      video.pause();
    };
    const updatePosition = () => {
      if (!current()) return;
      setPosition({
        time: Number.isFinite(video.currentTime) ? video.currentTime : 0,
        duration: Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0,
        live: video.duration === Infinity,
      });
    };
    const metadata = () => {
      if (!current()) return;
      setKind(video.videoWidth > 0 ? 'video' : 'audio');
      setBusy(false);
      updatePosition();
    };
    const play = () => { if (current()) { setPaused(false); setError(''); setBusy(video.readyState < 3); } };
    const pause = () => { if (current()) { setPaused(true); setBusy(false); } };
    const waiting = () => { if (current()) setBusy(true); };
    const ready = () => { if (current()) { setBusy(false); setError(''); } };
    const mediaError = () => fail('这个媒体暂时无法播放，请重试或更换链接');
    const events: [string, EventListener][] = [
      ['loadedmetadata', metadata], ['resize', metadata], ['durationchange', updatePosition],
      ['timeupdate', updatePosition], ['play', play], ['playing', ready], ['pause', pause],
      ['ended', pause], ['waiting', waiting], ['canplay', ready], ['error', mediaError],
    ];
    events.forEach(([name, handler]) => video.addEventListener(name, handler));
    setError(''); setBusy(true); setPaused(true); setKind('loading');
    setPosition({ time: 0, duration: 0, live: false });

    async function attach() {
      if (!isHls) { video!.src = src; return; }
      const { default: Hls } = await import('hls.js');
      if (!current()) return;
      if (!Hls.isSupported()) {
        if (video!.canPlayType('application/vnd.apple.mpegurl')) video!.src = src;
        else fail('当前浏览器不支持这个 HLS 源，请换用其他浏览器');
        return;
      }
      hls = new Hls({ maxBufferLength: 20, maxMaxBufferLength: 40, backBufferLength: 30, debug: false });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!current() || !data.fatal) return;
        if (!recovered && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          recovered = true;
          hls?.recoverMediaError();
          return;
        }
        hls?.stopLoad();
        fail('HLS 加载失败，请重试或检查链接的跨域访问设置');
      });
      hls.loadSource(src);
      hls.attachMedia(video!);
    }
    void attach().catch(() => fail('播放组件加载失败，请重试'));

    return () => {
      cancelled = true;
      activeRef.current = false;
      events.forEach(([name, handler]) => video.removeEventListener(name, handler));
      hls?.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [src, isHls, attempt]);

  async function toggle() {
    const video = videoRef.current;
    if (!video || !activeRef.current) return;
    if (!video.paused) { video.pause(); return; }
    const run = attemptRef.current;
    if (video.ended) video.currentTime = 0;
    try { await video.play(); }
    catch (cause) {
      if (!activeRef.current || run !== attemptRef.current || video !== videoRef.current) return;
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setBusy(false);
      setPaused(true);
      setError(cause instanceof DOMException && cause.name === 'NotAllowedError'
        ? '请再次点击播放' : '播放失败，请重试');
    }
  }

  function seek(time: number) {
    const video = videoRef.current;
    if (!video || !position.duration || !Number.isFinite(time)) return;
    const next = Math.max(0, Math.min(position.duration, time));
    video.currentTime = next;
    setPosition(value => ({ ...value, time: next }));
  }

  const progress = position.duration ? Math.min(100, position.time / position.duration * 100) : 0;
  return (
    <section className={cn('mfu-media-stage', className)} aria-label={title}>
      <video ref={attachVideo} controls={kind === 'video'} playsInline preload="metadata"
        aria-label={title} className={cn('mfu-media-video', kind !== 'video' && 'mfu-media-video-hidden')} />

      {kind !== 'video' && (
        <div className="mfu-media-art" aria-hidden="true">
          <div className="mfu-media-record"><Music2 strokeWidth={1.2} /></div>
        </div>
      )}

      <div className="mfu-media-caption"><h2 title={title}>{title}</h2></div>

      {kind !== 'video' && (
        <div className="mfu-media-controls">
          <input type="range" aria-label="媒体播放进度" aria-valuetext={`${formatDuration(position.time)} / ${formatDuration(position.duration)}`}
            min={0} max={position.duration || 0} step={0.1} value={Math.min(position.time, position.duration)}
            disabled={!position.duration || !!error} onChange={event => seek(Number(event.target.value))}
            className="mfu-media-progress" style={{ '--media-progress': `${progress}%` } as React.CSSProperties} />
          <div className="mfu-media-times"><span>{formatDuration(position.time)}</span><span>{position.live ? '直播' : formatDuration(position.duration)}</span></div>
          <div className="mfu-media-transport">
            <button type="button" aria-label={paused ? '播放媒体' : '暂停媒体'} onClick={() => void toggle()}
              disabled={kind === 'loading'} className="mfu-media-play">
              {busy ? <LoaderCircle className="mfu-media-spinner" /> : paused ? <Play className="mfu-media-filled" /> : <Pause className="mfu-media-filled" />}
            </button>
          </div>
          <VolumeControl className="mfu-media-volume" />
        </div>
      )}

      {busy && !error && <p role="status" className="mfu-media-status">{kind === 'loading' ? '正在读取媒体…' : '缓冲中…'}</p>}
      {error && <div className="mfu-media-error" role="alert"><p>{error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}><RotateCcw />重试</button></div>}
    </section>
  );
}
