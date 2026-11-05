import * as React from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Check, Copy, FolderOpen, Library, Link2, Maximize2, Minimize2, Music2, Plus, X } from 'lucide-react';
import { apiPath, parseStreamUrl } from '@/lib/api';
import { validateMediaUrl } from '@/lib/workspace-rules';
import { imageSrc } from '@/lib/utils';
import { platformLabel } from '@/lib/platforms';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MediaStage } from '@/components/media-stage';
import { CoverArt } from '@/components/playlist-card';
import { PlayerFeedback, PlayerProgress, PlayerQuality, PlayerQueue, PlayerTransport } from '@/components/player-controls';
import { VolumeControl } from '@/components/volume-control';
import { usePlayer } from '@/stores/player';
import { usePlayback } from '@/stores/playback';
import { useVolume } from '@/stores/volume';
import '@/player.css';

type MediaSource = { url: string; isHls: boolean; local: boolean; title: string };

export function PreviewView() {
  const [input, setInput] = React.useState('');
  const [inputError, setInputError] = React.useState('');
  const [source, setSource] = React.useState<MediaSource | null>(null);
  const [openDialog, setOpenDialog] = React.useState(false);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const stageRef = React.useRef<HTMLElement>(null);
  const requestId = React.useRef(0);
  const playlist = usePlayer(state => state.playlist);
  const index = usePlayer(state => state.index);
  const status = usePlayer(state => state.status);
  const message = usePlayer(state => state.message);
  const track = playlist?.tracks[index];
  const artwork = track?.cover || playlist?.cover;
  const active = !!playlist || !!source;

  React.useEffect(() => () => { if (source?.local) URL.revokeObjectURL(source.url); }, [source]);
  React.useEffect(() => () => { requestId.current++; }, []);
  React.useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(false), 2200); return () => window.clearTimeout(timer); }, [copied]);
  React.useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stageRef.current?.requestFullscreen();
    } catch { toast.error('当前浏览器暂时无法进入全屏'); }
  }

  React.useEffect(() => {
    if (!playlist || source) return;
    function keydown(event: KeyboardEvent) {
      const target = event.target;
      if (event.ctrlKey || event.altKey || event.metaKey || event.repeat || document.querySelector('[role="dialog"][data-state="open"]')) return;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input,textarea,select,button,a,[role="slider"],[role="radio"]'))) return;
      const playback = usePlayback.getState();
      if (event.code === 'Space') { event.preventDefault(); playback.toggle(); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); playback.seek(playback.time - 5); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); playback.seek(playback.time + 5); }
      else if (event.key.toLowerCase() === 'm') useVolume.getState().toggleMute();
      else if (event.key.toLowerCase() === 'f') void toggleFullscreen();
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [playlist, source]);

  async function open(event: React.FormEvent) {
    event.preventDefault();
    const operation = ++requestId.current;
    setInputError('');
    try {
      if (!input.trim()) throw new Error('请粘贴播放链接');
      const url = validateMediaUrl(input.trim());
      const parsed = new URL(url);
      try { decodeURIComponent(parsed.pathname); } catch { throw new Error('播放链接已损坏，请重新复制完整地址'); }
      const stream = parseStreamUrl(url);
      if (stream) {
        setSource(null);
        const opened = await usePlayer.getState().open(stream.platform, stream.playlistId, stream.grant);
        if (operation !== requestId.current) return;
        if (opened) setOpenDialog(false);
        else if (usePlayer.getState().status === 'error') setInputError(usePlayer.getState().message);
        return;
      }
      if (/\/playlist\/m3u8\//.test(parsed.pathname)) throw new Error('播放链接不完整，请重新复制');
      usePlayer.getState().clear();
      setSource({ url, isHls: /\.m3u8$/i.test(parsed.pathname), local: false, title: decodeURIComponent(parsed.pathname.split('/').pop() || '') || parsed.hostname });
      setOpenDialog(false);
    } catch (error) {
      if (operation !== requestId.current) return;
      setInputError(error instanceof Error ? error.message : '链接无效');
      inputRef.current?.focus();
    }
  }

  function openFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    requestId.current++;
    setInputError('');
    usePlayer.getState().clear();
    setSource({ url: URL.createObjectURL(file), isHls: /\.m3u8$/i.test(file.name), local: true, title: file.name });
    setInput(''); setOpenDialog(false);
    event.target.value = '';
  }

  async function copyLink() {
    if (!playlist) return;
    const url = new URL(apiPath(playlist.platform, `/playlist/m3u8/${encodeURIComponent(playlist.grant)}/${encodeURIComponent(playlist.id)}/stream.m3u8`), location.origin).href;
    try { await navigator.clipboard.writeText(url); setCopied(true); if (!document.fullscreenElement) toast.success('播放地址已复制'); }
    catch { if (document.fullscreenElement) await document.exitFullscreen(); setInput(url); setOpenDialog(true); toast.error('自动复制失败，可在地址栏手动复制'); requestAnimationFrame(() => inputRef.current?.select()); }
  }

  const openForm = <form className="player-open-form" onSubmit={open}>
    <label htmlFor="media-url">播放链接</label>
    <div className="player-open-input"><Input id="media-url" ref={inputRef} value={input} onChange={event => { setInput(event.target.value); setInputError(''); }} placeholder="粘贴播放链接或 HTTPS 媒体地址" aria-label="媒体链接" aria-invalid={!!inputError} aria-describedby={inputError ? 'preview-input-error' : undefined} autoComplete="off" spellCheck={false} /></div>
    {inputError && <p id="preview-input-error" role="alert" className="player-input-error">{inputError}</p>}
    <Button type="submit" disabled={status === 'loading'} className="w-full h-11"><Link2 />{status === 'loading' ? '正在载入…' : '打开链接'}</Button>
    <div className="player-open-divider"><span>或</span></div>
    <Button type="button" variant="outline" className="w-full h-11" onClick={() => fileRef.current?.click()}><FolderOpen />选择本地文件</Button>
    <Link className="player-library-link" to="/user"><Library size={16} />从我的音乐中选择</Link>
  </form>;

  return <section ref={stageRef} className={`listening-room${active ? '' : ' is-empty'}`} aria-label="音乐播放器">
    <div className="player-ambience" aria-hidden="true">{artwork && <img src={imageSrc(artwork)} alt="" referrerPolicy="no-referrer" />}</div>
    <header className="listening-header">
      <div className="listening-context"><Music2 size={18} /><span>{playlist ? platformLabel(playlist.platform) : source?.local ? '本地播放' : source ? '媒体播放' : '播放器'}</span></div>
      <div className="listening-actions">
        {playlist && <button className="player-icon" aria-label={copied ? '播放地址已复制' : '复制播放地址'} title={copied ? '已复制' : '复制播放地址'} onClick={() => void copyLink()}>{copied ? <Check size={18} /> : <Copy size={18} />}</button>}
        {active && <button className="player-glass-button" aria-label="打开音乐" title="打开音乐" onClick={async () => { if (document.fullscreenElement) await document.exitFullscreen(); setOpenDialog(true); }}><Plus size={17} /><span>打开音乐</span></button>}
        {typeof document !== 'undefined' && document.fullscreenEnabled && <button className="player-icon" aria-label={fullscreen ? '退出全屏' : '进入全屏'} title={fullscreen ? '退出全屏' : '进入全屏'} onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>}
        {active && <button className="player-icon" aria-label="关闭播放器" title="关闭播放器" onClick={() => { requestId.current++; usePlayer.getState().clear(); setSource(null); }}><X size={18} /></button>}
      </div>
    </header>
    <div className="listening-layout">
      <div className="now-playing">
        {source ? <MediaStage src={source.url} isHls={source.isHls} title={source.title} /> : track && playlist ? <>
          <div className={`now-playing-artwork${status === 'playing' ? ' is-playing' : ''}`}><CoverArt src={artwork} seed={track.id} className="now-playing-cover" /></div>
          <div className="now-playing-title"><h1>{track.name}</h1><p>{track.artist || playlist.name}</p></div>
          <PlayerProgress /><PlayerTransport />
          <div className="now-playing-options"><VolumeControl className="player-volume" showValue /><PlayerQuality /></div>
          <PlayerFeedback />
        </> : <>
          <div className="player-empty-art" aria-hidden="true"><span /><Music2 strokeWidth={1.2} /></div>
          {status === 'loading' && <div className="now-playing-title"><h2>正在载入歌单…</h2></div>}
          {status === 'error' && <p role="alert" className="player-input-error">{message}</p>}
        </>}
      </div>
      <div className="listening-side">
        {playlist ? <PlayerQueue /> : <div className="player-source-panel">{source ? <h2>切换音乐</h2> : <h1>打开音乐</h1>}{!openDialog && openForm}</div>}
      </div>
    </div>
    <input ref={fileRef} type="file" accept="audio/*,video/*,.m3u8" className="hidden" onChange={openFile} />
    <Dialog open={openDialog} onOpenChange={setOpenDialog}><DialogContent aria-describedby={undefined}><DialogHeader><DialogTitle>打开音乐</DialogTitle></DialogHeader>{openDialog && openForm}</DialogContent></Dialog>
  </section>;
}
