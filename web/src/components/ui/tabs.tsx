import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Tabs = TabsPrimitive.Root;

export function TabsList({
  className, ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('flex w-fit max-w-full min-w-0 items-center gap-4 overflow-x-auto border-b border-border', className)}
      {...props}
    />
  );
}

export function TabsTrigger({
  className, ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'inline-flex min-h-10 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-1.5 py-2 text-[13px] font-medium',
        'text-muted-foreground transition-colors hover:text-foreground',
        'data-[state=active]:border-primary data-[state=active]:text-primary',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className, ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn('dialog-content-enter mt-4 focus-visible:outline-none', className)}
      {...props}
    />
  );
}

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({
  className, children, ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'flex h-9 items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 opacity-60" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className, children, ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position="popper"
        sideOffset={4}
        className={cn(
          'z-50 min-w-[8rem] overflow-hidden rounded-md border border-border bg-popover',
          'text-popover-foreground shadow-md',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  className, children, ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px]',
        'outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        'data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="ml-auto">
        <Check className="size-3.5" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}
