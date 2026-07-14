import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, JSX } from "react";

import { cn } from "../lib/cn.js";

const badgeVariants = cva(
  "inline-flex min-h-[22px] items-center rounded-none border-0 border-l-2 bg-transparent px-2 text-[11px] font-bold leading-none tracking-0 transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-primary text-foreground",
        secondary: "border-border text-muted-foreground",
        destructive: "border-destructive text-destructive",
        outline: "border-border text-muted-foreground",
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
