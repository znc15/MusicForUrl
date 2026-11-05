import * as React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronUp, ListMusic, X } from 'lucide-react';
import { CoverArt } from '@/components/playlist-card';
import { PlayerFeedback, PlayerProgress, PlayerQueue, PlayerTransport } from '@/components/player-controls';
import { VolumeControl } from '@/components/volume-control';
import { usePlayer } from '@/stores/player';
import '@/player.css';

/** UI only. PlaybackEngine owns the persistent audio element. */
export function MiniPlayer() {
  const { pathname } = useLocation();
  const playlist = usePlayer(state => state.playlist);
  const index = usePlayer(state => state.index);
  const clear = usePlayer(state => state.clear);
  const [queueOpen, setQueueOpen] = React.useState(false);
  const track = playlist?.tracks[index];
  if (!playlist || !track || /^\/preview(?:\.html)?\/?$/.test(pathname)) return null;
  return <aside className="mini-player" aria-label="迷你播放器">
    {queueOpen && <div className="mini-player-queue"><button className="player-icon mini-queue-close" aria-label="关闭播放队列" onClick={() => setQueueOpen(false)}><X size={18} /></button><PlayerQueue compact /></div>}
    <div className="mini-player-bar">
      <Link to="/preview" className="mini-player-track" aria-label={`展开播放器：${track.name}`}>
        <CoverArt src={track.cover || playlist.cover} seed={track.id} className="mini-player-cover" />
        <span><strong>{track.name}</strong><small>{track.artist || playlist.name}</small></span><ChevronUp size={16} />
      </Link>
      <PlayerTransport compact />
      <div className="mini-player-volume"><VolumeControl /></div>
      <button className="player-icon mini-player-queue-button" aria-label="播放队列" aria-expanded={queueOpen} onClick={() => setQueueOpen(value => !value)}><ListMusic size={19} /></button>
      <button className="player-icon mini-player-close" aria-label="关闭播放器" onClick={clear}><X size={18} /></button>
    </div>
    <PlayerProgress compact /><PlayerFeedback />
  </aside>;
}
