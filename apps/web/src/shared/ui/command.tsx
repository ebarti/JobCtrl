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
import { Dialog, DialogContent } from "./dialog.js";

function assignForwardedRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref) {
    (ref as { current: T | null }).current = value;
  }
}

function normalizeCommandInputRole(input: HTMLInputElement) {
  if (input.getAttribute("role") !== "searchbox") {
    input.setAttribute("role", "searchbox");
  }
  for (const attribute of ["aria-autocomplete", "aria-controls", "aria-activedescendant", "aria-expanded"]) {
    if (input.hasAttribute(attribute)) {
      input.removeAttribute(attribute);
    }
  }
}

function normalizeCommandListRoles(list: HTMLDivElement) {
  if (list.hasAttribute("aria-activedescendant")) {
    list.removeAttribute("aria-activedescendant");
  }
  const items = Array.from(list.querySelectorAll("[cmdk-item]"));
  if (items.length === 0) {
    if (list.getAttribute("role") !== "presentation") {
      list.setAttribute("role", "presentation");
    }
    return;
  }
  if (list.getAttribute("role") !== "menu") {
    list.setAttribute("role", "menu");
  }
  const sizer = list.querySelector("[cmdk-list-sizer]");
  if (sizer?.getAttribute("role") !== "group") {
    sizer?.setAttribute("role", "group");
  }
  items.forEach((item) => {
    if (item.getAttribute("role") !== "menuitem") {
      item.setAttribute("role", "menuitem");
    }
    if (item.hasAttribute("aria-selected")) {
      item.removeAttribute("aria-selected");
    }
  });
}

export const Command = forwardRef<
  ComponentRef<typeof CommandPrimitive>,
  ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      "flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground",
      className,
    )}
    {...props}
  />
));
Command.displayName = CommandPrimitive.displayName;

export interface CommandDialogProps extends ComponentPropsWithoutRef<typeof Dialog> {}

export function CommandDialog({ children, ...props }: CommandDialogProps) {
  return (
    <Dialog {...props}>
      <DialogContent className="overflow-hidden p-0">
        <Command className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
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
  const inputRef = useRef<ComponentRef<typeof CommandPrimitive.Input> | null>(null);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    normalizeCommandInputRole(input);
    const observer = new MutationObserver(() => normalizeCommandInputRole(input));
    observer.observe(input, { attributes: true });
    return () => observer.disconnect();
  }, []);
  return (
    <div className="flex items-center border-b border-input bg-background px-3" cmdk-input-wrapper="">
      <IconSearch className="mr-2 h-4 w-4 shrink-0 opacity-50" />
      <CommandPrimitive.Input
        ref={(node) => {
          inputRef.current = node;
          assignForwardedRef(ref, node);
        }}
        className={cn(
          "flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
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
  const listRef = useRef<ComponentRef<typeof CommandPrimitive.List> | null>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    normalizeCommandListRoles(list);
    const observer = new MutationObserver(() => normalizeCommandListRoles(list));
    observer.observe(list, { attributes: true, childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return (
    <CommandPrimitive.List
      ref={(node) => {
        listRef.current = node;
        assignForwardedRef(ref, node);
      }}
      className={cn("max-h-[300px] overflow-y-auto overflow-x-hidden", className)}
      {...props}
    />
  );
});
CommandList.displayName = CommandPrimitive.List.displayName;

export const CommandEmpty = forwardRef<
  ComponentRef<typeof CommandPrimitive.Empty>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => (
  <CommandPrimitive.Empty ref={ref} className="py-6 text-center text-sm" {...props} />
));
CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

export const CommandGroup = forwardRef<
  ComponentRef<typeof CommandPrimitive.Group>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      "overflow-hidden p-1 text-popover-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
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
  <CommandPrimitive.Separator ref={ref} className={cn("-mx-1 h-px bg-border", className)} {...props} />
));
CommandSeparator.displayName = CommandPrimitive.Separator.displayName;

export const CommandItem = forwardRef<
  ComponentRef<typeof CommandPrimitive.Item>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none aria-selected:bg-accent aria-selected:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
      className,
    )}
    {...props}
  />
));
CommandItem.displayName = CommandPrimitive.Item.displayName;

export function CommandShortcut({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("ml-auto text-xs tracking-widest text-muted-foreground", className)} {...props} />
  );
}
CommandShortcut.displayName = "CommandShortcut";
