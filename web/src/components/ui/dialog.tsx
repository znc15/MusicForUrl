import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

// Radix 提供焦点陷阱、Escape 处理、背景 inert 与 ARIA，旧版前端是手写的
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className, children, onOpenAutoFocus, onCloseAutoFocus, ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
  const returnFocus = React.useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/45" />
      <DialogPrimitive.Content
        className={cn(
          'dialog-surface fixed left-1/2 top-1/2 z-50 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2',
          'max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain rounded-lg border border-border bg-card p-5 shadow-lg focus:outline-none',
          className,
        )}
        {...props}
        onOpenAutoFocus={event => {
          returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          onOpenAutoFocus?.(event);
        }}
        onCloseAutoFocus={event => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          // A higher-priority dialog may have opened during this one's exit animation.
          if (document.querySelector('[role="dialog"][data-state="open"]')) {
            event.preventDefault();
            return;
          }
          const target = returnFocus.current?.isConnected && returnFocus.current !== document.body
            ? returnFocus.current : document.querySelector<HTMLElement>('[data-announcement-trigger]');
          if (target) { event.preventDefault(); target.focus({ preventScroll: true }); }
        }}
      >
        {children}
        <DialogPrimitive.Close
          className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          aria-label="关闭"
        >
          <X className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 flex flex-col gap-1 pr-6', className)} {...props} />;
}

export function DialogTitle({
  className, ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-base font-semibold', className)} {...props} />;
}

export function DialogDescription({
  className, ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-[13px] text-muted-foreground', className)}
      {...props}
    />
  );
}
