import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconInfoCircle,
  type TablerIcon,
} from "@tabler/icons-react";
import { cva, type VariantProps } from "class-variance-authority";
import type { JSX } from "react";

import { cn } from "../lib/cn.js";
import { Badge, type BadgeProps } from "./badge.js";
import type { StatusTagTone } from "./status-tokens.js";

const statusBadgeVariants = cva(
  "gap-1.5 rounded-none border-0 bg-transparent p-0 shadow-none before:size-2 before:shrink-0 before:rounded-full before:bg-current before:content-[''] has-[>svg]:before:hidden",
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
  extends
    Omit<BadgeProps, "variant">,
    VariantProps<typeof statusBadgeVariants> {
  /** Override the semantic tone icon, or pass false to retain the quiet dot. */
  icon?: TablerIcon | false | undefined;
}

const defaultToneIcons: Partial<Record<StatusTagTone, TablerIcon>> = {
  danger: IconCircleX,
  info: IconInfoCircle,
  ok: IconCircleCheck,
  warn: IconAlertTriangle,
};

/**
 * Restrained domain-state label. Semantic icons improve scanning for actionable
 * states; muted metadata keeps the quieter dot treatment.
 */
export function StatusBadge({
  children,
  className,
  icon,
  tone,
  ...props
}: StatusBadgeProps): JSX.Element {
  const resolvedTone = tone ?? "muted";
  const StatusIcon =
    icon === false ? null : (icon ?? defaultToneIcons[resolvedTone]);

  return (
    <Badge
      data-slot="status-badge"
      data-status-tone={resolvedTone}
      data-typography="status"
      variant="outline"
      className={cn(statusBadgeVariants({ tone: resolvedTone }), className)}
      {...props}
    >
      {StatusIcon ? (
        <StatusIcon
          aria-hidden="true"
          className="size-4"
          data-icon="inline-start"
          data-status-icon="true"
        />
      ) : null}
      {children}
    </Badge>
  );
}

export { statusBadgeVariants };
