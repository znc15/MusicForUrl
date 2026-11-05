import { create } from 'zustand';

interface PlaybackController {
  play(): void;
  pause(): void;
  toggle(): void;
  seek(seconds: number): void;
}

interface PlaybackState extends PlaybackController {
  time: number;
  duration: number;
  buffered: number;
  busy: boolean;
}

let controller: PlaybackController | null = null;

/** Views share transport controls; only PlaybackEngine owns the media element. */
export const usePlayback = create<PlaybackState>(() => ({
  time: 0, duration: 0, buffered: 0, busy: false,
  play: () => controller?.play(),
  pause: () => controller?.pause(),
  toggle: () => controller?.toggle(),
  seek: seconds => { if (Number.isFinite(seconds)) controller?.seek(seconds); },
}));

export function bindPlaybackController(next: PlaybackController) {
  controller = next;
  return () => {
    if (controller !== next) return;
    controller = null;
    usePlayback.setState({ time: 0, duration: 0, buffered: 0, busy: false });
  };
}
