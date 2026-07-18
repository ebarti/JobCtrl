import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, JSX } from "react";

import { cn } from "../lib/cn.js";

const badgeVariants = cva(
  "inline-flex min-h-5 items-center rounded-md border px-1.5 transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 [&>svg]:pointer-events-none [&>svg]:shrink-0 [&>svg:not([class*='size-'])]:size-3",
  {
    variants: {
      variant: {
        default: "border-border bg-secondary text-secondary-foreground",
        secondary: "border-transparent bg-muted text-muted-foreground",
        category: "border-border bg-muted text-muted-foreground",
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

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({
  className,
  variant,
  ...props
}: BadgeProps): JSX.Element {
  return (
    <span
      data-slot="badge"
      data-typography="label"
      data-variant={variant ?? "default"}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { badgeVariants };
