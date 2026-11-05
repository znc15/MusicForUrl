import * as React from 'react';
import { m } from 'motion/react';
import { cn } from '@/lib/utils';

// 时长表与旧版 cloudflare/ANIMATION.md 保持一致，方便对照
export const DURATION = {
  page: { enter: 0.28 },
  tabs: { enter: 0.24, exit: 0.12 },
  list: { enter: 0.22, exit: 0.1 },
  indicator: 0.26,
  theme: 0.36,
  press: 0.09,
};

const EASE = [0.22, 0.61, 0.36, 1] as const;

/**
 * 页面切换只做「进入」：路由变化时旧视图立刻卸载，新视图带 page-enter 动画挂载。
 *
 * 这里刻意不用 motion 的 AnimatePresence。它的出/进场是 JS 逐帧推进的，
 * 一旦 rAF 被节流（后台标签页、窗口被遮挡、系统「减少动态效果」）就可能停在
 * opacity 0 的初始帧或退场帧，页面变成空白。CSS 关键帧按时间轴推进且最终帧
 * 恒定可见，index.css 里的 prefers-reduced-motion 规则会让它瞬间结束。
 */
export function PageTransition({ viewKey, children }: { viewKey: string; children: React.ReactNode }) {
  return (
    <div key={viewKey} className="page-enter">
      {children}
    </div>
  );
}

export function ListReveal({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <m.ul
      className={className}
      initial="hidden"
      animate="visible"
      variants={{ visible: { transition: { staggerChildren: 0.025 } } }}
    >
      {children}
    </m.ul>
  );
}

export function ListItem({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <m.li
      className={className}
      variants={{ hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0 } }}
      transition={{ duration: DURATION.list.enter, ease: EASE }}
    >
      {children}
    </m.li>
  );
}

interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
}

/**
 * 分段控件。滑块用 layoutId 共享元素过渡，取代旧版手写测量宽度的做法。
 * tone="hero" 用于首页横幅：深色底 + 白色选中块。
 */
export function Segmented<T extends string>({
  value, options, onChange, className, ariaLabel, tone = 'default',
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  ariaLabel?: string;
  tone?: 'default' | 'hero';
}) {
  const id = React.useId();
  const hero = tone === 'hero';
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      // w-fit 而不是靠父级：否则在 flex-col 容器里会被 align-items:stretch 拉满整行
      className={cn(
        'inline-flex max-w-full w-fit flex-wrap items-center gap-1 rounded-lg p-1',
        hero ? 'bg-[var(--hero-seg)]' : 'bg-muted',
        className,
      )}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onKeyDown={event => {
              let next = index;
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % options.length;
              else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
              else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = options.length - 1;
              else return;
              event.preventDefault();
              onChange(options[next].value);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
            }}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] sm:px-4 font-medium',
              'transition-colors focus-visible:outline-none focus-visible:ring-2',
              hero ? 'focus-visible:ring-white/70' : 'focus-visible:ring-ring',
              active
                ? hero ? 'text-[var(--hero-mid)]' : 'text-foreground'
                : hero
                  ? 'text-[var(--hero-seg-foreground)] hover:text-white'
                  : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active && (
              <m.span
                layoutId={`segmented-${id}`}
                className={cn(
                  'absolute inset-0 rounded-md',
                  hero ? 'bg-[var(--hero-field)]' : 'bg-card shadow-sm',
                )}
                transition={{ duration: DURATION.indicator, ease: [0.4, 0, 0.2, 1] }}
              />
            )}
            <span className="relative z-10 inline-flex items-center gap-1.5">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export { m };
