import * as React from 'react';
import { usePlayer } from '@/stores/player';
import { bindPlaybackController, usePlayback } from '@/stores/playback';
import { effectiveVolume, useVolume } from '@/stores/volume';

function setSessionPosition(session: MediaSession | undefined, value?: MediaPositionState) {
  if (!session?.setPositionState) return;
  try { session.setPositionState(value); } catch { /* Position reporting is optional on older media-session implementations. */ }
}

/** Mounted once by AppShell; full-size and compact players only render controls. */
export function PlaybackEngine() {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const positionRef = React.useRef(0);
  const retriedRef = React.useRef(false);
  const trackRef = React.useRef('');
  const playlist = usePlayer(state => state.playlist);
  const index = usePlayer(state => state.index);
  const source = usePlayer(state => state.source);
  const autoplay = usePlayer(state => state.autoplay);
  const generation = usePlayer(state => state.generation);
  const restartKey = usePlayer(state => state.restartKey);
  const retryKey = usePlayer(state => state.retryKey);
  const status = usePlayer(state => state.status);
  const volume = useVolume(state => state.volume);
  const muted = useVolume(state => state.muted);
  const track = playlist?.tracks[index];
  const trackKey = `${playlist?.platform}:${playlist?.id}:${index}:${restartKey}`;
  const session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;

  const attachAudio = React.useCallback((audio: HTMLAudioElement | null) => {
    audioRef.current = audio;
    if (audio) audio.volume = effectiveVolume(useVolume.getState());
  }, []);

  const updateProgress = React.useCallback((audio: HTMLAudioElement) => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const time = duration ? Math.max(0, Math.min(audio.currentTime, duration)) : 0;
    let buffered = 0;
    for (let i = 0; i < audio.buffered.length; i++) {
      if (audio.buffered.start(i) <= time && audio.buffered.end(i) >= time) buffered = audio.buffered.end(i);
    }
    positionRef.current = time;
    usePlayback.setState({ time, duration, buffered });
    setSessionPosition(session, duration > 0 ? { duration, position: time, playbackRate: audio.playbackRate || 1 } : undefined);
  }, [session]);

  const play = React.useCallback(() => {
    const audio = audioRef.current;
    const current = usePlayer.getState();
    if (!audio || !current.playlist) return;
    usePlayer.setState({ autoplay: true });
    if (!current.source) return;
    if (audio.ended || current.status === 'ended') {
      audio.currentTime = 0; positionRef.current = 0;
      usePlayer.setState({ message: '', errorCode: '' });
    }
    void audio.play().catch((error: unknown) => {
      const latest = usePlayer.getState();
      if (audioRef.current !== audio || latest.generation !== current.generation || latest.source !== current.source) return;
      usePlayback.setState({ busy: false });
      if (error instanceof DOMException && error.name === 'AbortError') return;
      latest.fail(error instanceof DOMException && error.name === 'NotAllowedError'
        ? '播放被浏览器阻止，请再次点击播放' : '播放失败，请重试', current.generation);
    });
  }, []);

  React.useEffect(() => bindPlaybackController({
    play,
    pause: () => {
      const current = usePlayer.getState();
      if (!current.playlist) return;
      usePlayer.setState({ autoplay: false, ...(current.source ? { status: 'paused' as const } : {}) });
      audioRef.current?.pause();
    },
    toggle: () => { if (audioRef.current?.paused) play(); else usePlayback.getState().pause(); },
    seek: seconds => {
      const audio = audioRef.current;
      if (!audio || !usePlayer.getState().source || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
      audio.currentTime = Math.max(0, Math.min(seconds, audio.duration));
      updateProgress(audio);
    },
  }), [play, updateProgress]);

  React.useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const sameTrack = trackRef.current === trackKey;
    trackRef.current = trackKey;
    if (!sameTrack) {
      retriedRef.current = false; positionRef.current = 0;
      usePlayback.setState({ time: 0, duration: 0, buffered: 0 });
    }
    if (!source) {
      audio.pause(); audio.removeAttribute('src'); audio.load();
      usePlayback.setState({ buffered: 0 });
      return;
    }
    const restoreTime = positionRef.current;
    audio.src = source.mediaUrl;
    const restorePosition = () => {
      if (sameTrack && Number.isFinite(audio.duration)) audio.currentTime = Math.min(restoreTime, audio.duration);
      updateProgress(audio);
    };
    audio.addEventListener('loadedmetadata', restorePosition, { once: true });
    if (!autoplay && usePlayer.getState().status === 'loading') usePlayer.setState({ status: 'paused' });
    if (autoplay) void audio.play().catch(() => {
      const current = usePlayer.getState();
      if (audioRef.current === audio && current.generation === generation && current.source === source) {
        usePlayer.setState({ status: 'paused' });
        usePlayback.setState({ busy: false });
      }
    });
    return () => { audio.removeEventListener('loadedmetadata', restorePosition); };
    // play/pause controls act directly on the current element. A change in
    // autoplay intent alone must not assign src again and interrupt playback.
  }, [source, trackKey, generation, updateProgress]);

  React.useEffect(() => {
    if (audioRef.current) audioRef.current.volume = effectiveVolume({ volume, muted });
  }, [volume, muted, generation]);
  React.useEffect(() => { retriedRef.current = false; }, [retryKey]);
  React.useEffect(() => {
    usePlayback.setState({ busy: status === 'loading' });
  }, [status, source]);

  React.useEffect(() => {
    if (!session || !playlist) return;
    const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => usePlayback.getState().play()],
      ['pause', () => usePlayback.getState().pause()],
      ['previoustrack', () => { void usePlayer.getState().prev(); }],
      ['nexttrack', () => { void usePlayer.getState().next(); }],
      ['seekto', details => { if (details.seekTime !== undefined) usePlayback.getState().seek(details.seekTime); }],
      ['seekbackward', details => usePlayback.getState().seek(usePlayback.getState().time - (details.seekOffset ?? 10))],
      ['seekforward', details => usePlayback.getState().seek(usePlayback.getState().time + (details.seekOffset ?? 10))],
    ];
    const supported: MediaSessionAction[] = [];
    for (const [action, handler] of actions) {
      try { session.setActionHandler(action, handler); supported.push(action); } catch { /* Older browsers expose only some actions. */ }
    }
    return () => {
      for (const action of supported) session.setActionHandler(action, null);
      session.metadata = null; session.playbackState = 'none'; setSessionPosition(session);
    };
  }, [session, playlist]);
  React.useEffect(() => {
    if (!session || !track || !playlist || typeof MediaMetadata === 'undefined') return;
    const cover = source?.coverUrl || track.cover || playlist.cover;
    session.metadata = new MediaMetadata({ title: track.name, artist: track.artist, album: playlist.name,
      artwork: cover ? [{ src: cover }] : [] });
  }, [session, track, playlist, source?.coverUrl]);
  React.useEffect(() => {
    if (session && playlist) session.playbackState = status === 'playing' ? 'playing' : 'paused';
  }, [session, playlist, status]);

  function active(audio: HTMLAudioElement) {
    const current = usePlayer.getState();
    return audioRef.current === audio && current.generation === generation && !!source && current.source === source;
  }

  return <audio key={generation} ref={attachAudio} preload="metadata"
    onPlay={event => { if (active(event.currentTarget)) usePlayer.getState().markPlaying(generation); }}
    onPlaying={event => { if (active(event.currentTarget)) usePlayback.setState({ busy: false }); }}
    onPause={event => { if (active(event.currentTarget)) usePlayer.getState().markPaused(generation); }}
    onWaiting={event => { if (active(event.currentTarget)) usePlayback.setState({ busy: true }); }}
    onCanPlay={event => { if (active(event.currentTarget)) usePlayback.setState({ busy: false }); }}
    onEnded={event => { if (active(event.currentTarget)) void usePlayer.getState().ended(); }}
    onTimeUpdate={event => { if (active(event.currentTarget)) updateProgress(event.currentTarget); }}
    onDurationChange={event => { if (active(event.currentTarget)) updateProgress(event.currentTarget); }}
    onProgress={event => { if (active(event.currentTarget)) updateProgress(event.currentTarget); }}
    onError={event => {
      if (!active(event.currentTarget)) return;
      usePlayback.setState({ busy: false });
      if (!retriedRef.current) { retriedRef.current = true; void usePlayer.getState().retry(true); }
      else usePlayer.getState().fail('无法播放这首歌曲，请重试或切换音质', generation);
    }} />;
}
