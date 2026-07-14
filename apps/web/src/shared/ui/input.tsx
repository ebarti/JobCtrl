import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "../lib/cn.js";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        "flex h-[38px] w-full rounded-[6px] border border-input bg-card px-3 py-1 text-[13px] font-medium shadow-[0_1px_2px_rgb(15_23_42/0.04)] transition-[border-color,box-shadow,background-color] file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:font-normal placeholder:text-muted-foreground hover:border-foreground/25 focus-visible:border-primary/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-55",
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Input.displayName = "Input";
