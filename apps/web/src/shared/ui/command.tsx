import { Command as CommandPrimitive } from "cmdk";
import { IconSearch } from "@tabler/icons-react";
import {
  type ForwardedRef,
  forwardRef,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type HTMLAttributes,
  useEffect,
  useRef,
} from "react";

import { cn } from "../lib/cn.js";
import { Dialog, DialogContent, DialogTitle } from "./dialog.js";

function assignForwardedRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref) {
    (ref as { current: T | null }).current = value;
  }
}

function normalizeCommandListRoles(list: HTMLDivElement) {
  const items = Array.from(list.querySelectorAll("[cmdk-item]"));
  const separators = Array.from(list.querySelectorAll("[cmdk-separator]"));
  const sizer = list.querySelector("[cmdk-list-sizer]");
  separators.forEach((separator) => {
    if (separator.getAttribute("role") !== "presentation") {
      separator.setAttribute("role", "presentation");
    }
  });
  if (items.length === 0) {
    if (sizer?.getAttribute("role") !== "presentation") {
      sizer?.setAttribute("role", "presentation");
    }
    if (list.getAttribute("role") !== "presentation") {
      list.setAttribute("role", "presentation");
    }
    if (list.hasAttribute("aria-owns")) {
      list.removeAttribute("aria-owns");
    }
    if (list.hasAttribute("aria-activedescendant")) {
      list.removeAttribute("aria-activedescendant");
    }
    return;
  }
  if (list.getAttribute("role") !== "listbox") {
    list.setAttribute("role", "listbox");
  }
  if (sizer?.getAttribute("role") !== "group") {
    sizer?.setAttribute("role", "group");
  }
  const ownedItemIds = items.map((item) => item.id).join(" ");
  if (list.getAttribute("aria-owns") !== ownedItemIds) {
    list.setAttribute("aria-owns", ownedItemIds);
  }
  items.forEach((item) => {
    if (item.getAttribute("role") !== "option") {
      item.setAttribute("role", "option");
    }
  });
}

export const Command = forwardRef<
  ComponentRef<typeof CommandPrimitive>,
  ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    data-slot="command"
    className={cn(
      "flex h-full w-full flex-col overflow-hidden rounded-[10px] bg-popover text-popover-foreground",
      className,
    )}
    {...props}
  />
));
Command.displayName = CommandPrimitive.displayName;

export interface CommandDialogProps extends ComponentPropsWithoutRef<
  typeof Dialog
> {}

export function CommandDialog({ children, ...props }: CommandDialogProps) {
  return (
    <Dialog {...props}>
      <DialogContent className="overflow-hidden p-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command className="[&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input]]:h-11 [&_[cmdk-item]]:px-2.5 [&_[cmdk-item]]:py-2">
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

export const CommandInput = forwardRef<
  ComponentRef<typeof CommandPrimitive.Input>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex items-center border-b border-border bg-popover px-3"
      cmdk-input-wrapper=""
    >
      <IconSearch
        aria-hidden
        className="mr-2 shrink-0 text-muted-foreground"
        size={16}
      />
      <CommandPrimitive.Input
        ref={ref}
        data-slot="command-input"
        data-typography="control"
        className={cn(
          "flex h-10 w-full bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
});
CommandInput.displayName = CommandPrimitive.Input.displayName;

export const CommandList = forwardRef<
  ComponentRef<typeof CommandPrimitive.List>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => {
  const listRef = useRef<ComponentRef<typeof CommandPrimitive.List> | null>(
    null,
  );
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    normalizeCommandListRoles(list);
    const observer = new MutationObserver(() =>
      normalizeCommandListRoles(list),
    );
    observer.observe(list, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, []);
  return (
    <CommandPrimitive.List
      ref={(node) => {
        listRef.current = node;
        assignForwardedRef(ref, node);
      }}
      data-slot="command-list"
      className={cn(
        "max-h-[300px] overflow-y-auto overflow-x-hidden",
        className,
      )}
      {...props}
    />
  );
});
CommandList.displayName = CommandPrimitive.List.displayName;

export const CommandEmpty = forwardRef<
  ComponentRef<typeof CommandPrimitive.Empty>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    data-slot="command-empty"
    data-typography="body"
    className={cn("py-8 text-center text-sm text-muted-foreground", className)}
    {...props}
  />
));
CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

export const CommandGroup = forwardRef<
  ComponentRef<typeof CommandPrimitive.Group>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    data-slot="command-group"
    className={cn(
      "overflow-hidden p-1.5 text-popover-foreground [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-muted-foreground",
      className,
    )}
    {...props}
  />
));
CommandGroup.displayName = CommandPrimitive.Group.displayName;

export const CommandSeparator = forwardRef<
  ComponentRef<typeof CommandPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    data-slot="command-separator"
    className={cn("mx-1 my-1 h-px bg-border", className)}
    {...props}
  />
));
CommandSeparator.displayName = CommandPrimitive.Separator.displayName;

export const CommandItem = forwardRef<
  ComponentRef<typeof CommandPrimitive.Item>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    data-slot="command-item"
    data-typography="control"
    className={cn(
      "relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none aria-selected:bg-muted aria-selected:text-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:shrink-0",
      className,
    )}
    {...props}
  />
));
CommandItem.displayName = CommandPrimitive.Item.displayName;

export function CommandShortcut({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      data-slot="command-shortcut"
      data-typography="metadata"
      className={cn("ml-auto text-muted-foreground", className)}
      {...props}
    />
  );
}
CommandShortcut.displayName = "CommandShortcut";
