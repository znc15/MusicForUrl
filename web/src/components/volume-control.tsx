import * as React from 'react';
import { Volume1, Volume2, VolumeX } from 'lucide-react';
import { cn } from '@/lib/utils';
import { VOLUME_STEP, effectiveVolume, useVolume } from '@/stores/volume';

function iconFor(level: number) {
  if (level === 0) return VolumeX;
  return level < 0.5 ? Volume1 : Volume2;
}

/**
 * 播放条上的音量控制。
 *
 * 状态在 `useVolume` 里，写入 localStorage，因此刷新与页面切换都不会丢。
 * 轨道支持点击定位、按住拖动、方向键微调（每次 5%）与 Home/End 跳到两端。
 */
export function VolumeControl({ className }: { className?: string }) {
  const volume = useVolume(state => state.volume);
  const muted = useVolume(state => state.muted);
  const setVolume = useVolume(state => state.setVolume);
  const toggleMute = useVolume(state => state.toggleMute);
  const trackRef = React.useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = React.useState(false);

  const level = effectiveVolume({ volume, muted });
  const Icon = iconFor(level);
  const percent = Math.round(level * 100);

  const volumeAt = React.useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  // 拖动挂在 window 上：指针移出轨道后仍然跟随，这是滑块的基本要求
  React.useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => setVolume(volumeAt(event.clientX));
    const stop = () => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [dragging, setVolume, volumeAt]);

  function onKeyDown(event: React.KeyboardEvent) {
    const map: Record<string, number | undefined> = {
      ArrowRight: VOLUME_STEP,
      ArrowUp: VOLUME_STEP,
      ArrowLeft: -VOLUME_STEP,
      ArrowDown: -VOLUME_STEP,
      Home: -1,
      End: 1,
    };
    if (event.key === 'Home') { event.preventDefault(); setVolume(0); return; }
    if (event.key === 'End') { event.preventDefault(); setVolume(1); return; }
    const delta = map[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    setVolume(volume + delta);
  }

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <button
        type="button"
        onClick={toggleMute}
        aria-label={muted || volume === 0 ? '取消静音' : '静音'}
        aria-pressed={muted || volume === 0}
        title={muted || volume === 0 ? '取消静音' : '静音'}
        className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:text-foreground"
      >
        <Icon className="size-4" />
      </button>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="音量"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}%${muted ? '（已静音）' : ''}`}
        onKeyDown={onKeyDown}
        onPointerDown={event => {
          event.preventDefault();
          event.currentTarget.focus();
          setDragging(true);
          setVolume(volumeAt(event.clientX));
        }}
        className="group relative flex h-6 w-full min-w-20 flex-1 cursor-pointer touch-none items-center rounded-full"
      >
        <span aria-hidden="true" className="absolute inset-x-0 h-1 rounded-full bg-muted" />
        <span
          className="absolute left-0 h-1 rounded-full bg-gradient-to-r from-primary to-[color-mix(in_srgb,var(--primary)_60%,white)]"
          style={{ width: `${percent}%` }}
        />
        <span
          aria-hidden="true"
          className={cn(
            'absolute size-3 -translate-x-1/2 rounded-full bg-primary shadow-sm transition-opacity',
            dragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
          )}
          style={{ left: `${percent}%` }}
        />
      </div>

    </div>
  );
}
