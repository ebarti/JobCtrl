import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, JSX } from "react";

import { cn } from "../lib/cn.js";

const badgeVariants = cva(
  "inline-flex min-h-5 items-center rounded-md border px-1.5 text-[10px] font-medium leading-none tracking-[0.01em] transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
  {
    variants: {
      variant: {
        default: "border-border bg-secondary text-secondary-foreground",
        secondary: "border-transparent bg-muted text-muted-foreground",
        destructive:
          "border-[color-mix(in_oklab,var(--destructive)_26%,var(--border))] bg-[color-mix(in_oklab,var(--destructive)_10%,var(--card))] text-destructive",
        outline: "border-border bg-transparent text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
