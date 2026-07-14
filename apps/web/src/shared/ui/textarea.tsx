import { forwardRef, type TextareaHTMLAttributes } from "react";

import { cn } from "../lib/cn.js";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      className={cn(
        "flex min-h-[88px] w-full rounded-[2px] border border-input bg-card px-3 py-2.5 text-[13px] font-medium leading-relaxed shadow-none transition-[border-color,background-color] placeholder:font-normal placeholder:text-muted-foreground hover:border-foreground/35 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-55",
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
