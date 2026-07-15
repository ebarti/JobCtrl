import { cva, type VariantProps } from "class-variance-authority";
import type { JSX } from "react";

import { cn } from "../lib/cn.js";
import { Badge, type BadgeProps } from "./badge.js";
import type { StatusTagTone } from "./status-tokens.js";

const statusBadgeVariants = cva(
  "min-h-0 gap-1.5 rounded-none border-0 bg-transparent p-0 text-[11px] font-semibold leading-5 shadow-none before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']",
  {
    variants: {
      tone: {
        danger: "text-destructive",
        info: "text-status-info",
        muted: "text-muted-foreground",
        ok: "text-success",
        warn: "text-warning",
      } satisfies Record<StatusTagTone, string>,
    },
    defaultVariants: {
      tone: "muted",
    },
  },
);

export interface StatusBadgeProps
  extends Omit<BadgeProps, "variant">,
    VariantProps<typeof statusBadgeVariants> {}

/**
 * Restrained domain-state label. The dot and text carry tone without turning
 * operational state into a filled pill or competing with primary actions.
 */
export function StatusBadge({ className, tone, ...props }: StatusBadgeProps): JSX.Element {
  return (
    <Badge
      data-slot="status-badge"
      variant="outline"
      className={cn(statusBadgeVariants({ tone }), className)}
      {...props}
    />
  );
}

export { statusBadgeVariants };
