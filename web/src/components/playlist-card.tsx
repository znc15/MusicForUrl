import * as React from 'react';
import { Play } from 'lucide-react';
import { cn, imageSrc } from '@/lib/utils';

// 没有封面时用歌单 ID 决定渐变，保证网格不会出现空白块
const FALLBACK_GRADIENTS = [
  'linear-gradient(140deg,#9ad6ef,#2f9fd0 60%,#1c6c92)',
  'linear-gradient(140deg,#c9a8f0,#6f5bd4 60%,#3b2f8f)',
  'linear-gradient(140deg,#ffc9a3,#e5764f 58%,#a33f2a)',
  'linear-gradient(140deg,#a8e6c9,#3fa87a 58%,#1f6b4c)',
  'linear-gradient(140deg,#ffd6e7,#d95f95 58%,#8d2f5c)',
  'linear-gradient(140deg,#a9c6ff,#4a6fd8 58%,#26398f)',
];

export function gradientFor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return FALLBACK_GRADIENTS[hash % FALLBACK_GRADIENTS.length];
}

export function CoverArt({ src, seed, className }: { src?: string; seed: string; className?: string }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [src]);
  const useImage = !!src && !failed;
  return (
    <span
      className={cn('relative block overflow-hidden bg-muted', className)}
      style={useImage ? undefined : { backgroundImage: gradientFor(seed) }}
    >
      {useImage && (
        <img
          src={imageSrc(src)}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      )}
      {!useImage && (
        <span className="absolute inset-0 grid place-items-center text-2xl text-white/45" aria-hidden="true">♪</span>
      )}
    </span>
  );
}

export function PlaylistCard({
  id, name, meta, cover, onOpen, onPlay, className,
}: {
  id: string;
  name: string;
  meta: string;
  cover?: string;
  onOpen: () => void;
  onPlay?: () => void;
  className?: string;
}) {
  return (
    <div className={cn('group min-w-0', className)}>
      <div className="relative">
      <button
        type="button"
        onClick={onOpen}
        className="relative block aspect-square w-full overflow-hidden rounded-xl shadow-[var(--shadow-card)] transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:-translate-y-0.5"
        aria-label={`${onPlay ? '查看歌单' : '播放'} ${name}`}
      >
        <CoverArt src={cover} seed={id} className="size-full" />
        {!onPlay && <span
          aria-hidden="true"
          className="absolute bottom-2 right-2 grid size-8 place-items-center rounded-full bg-white/92 text-[var(--hero-mid)] opacity-0 shadow-lg transition-opacity group-hover:opacity-100"
        >
          <Play className="size-3.5 fill-current" />
        </span>}
      </button>
      {onPlay && <button type="button" onClick={onPlay} aria-label={`播放 ${name}`}
        className="absolute bottom-2 right-2 grid size-9 place-items-center rounded-full bg-card text-primary shadow-md transition-colors hover:bg-primary hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Play className="size-4 fill-current" />
      </button>}
      </div>
      <button type="button" onClick={onOpen} className="mt-2.5 block max-w-full truncate text-left text-[13px] font-medium hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{name}</button>
      <p className="truncate text-[11.5px] text-muted-foreground">{meta}</p>
    </div>
  );
}
