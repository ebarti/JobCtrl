import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { forwardRef, type ReactNode } from "react";

import { cn } from "../lib/cn.js";
import { cardClassName } from "./card.js";

export type StatTone = "up" | "warn" | "down";

const toneClass: Record<StatTone, string> = {
  up: "text-success",
  warn: "text-warning",
  down: "text-destructive",
};

export interface StatCardProps extends Omit<
  useRender.ComponentProps<"div">,
  "children" | "className"
> {
  label: string;
  value: ReactNode;
  tag?: ReactNode;
  delta?: ReactNode;
  deltaTone?: StatTone | undefined;
  valueTone?: StatTone | undefined;
  className?: string;
}

export const StatCard = forwardRef<HTMLDivElement, StatCardProps>(
  (
    {
      label,
      value,
      tag,
      delta,
      deltaTone,
      valueTone,
      className,
      render,
      ...props
    },
    ref,
  ) => {
    return useRender({
      defaultTagName: "div",
      ref,
      render,
      props: mergeProps(props, {
        className: cn(cardClassName, "flex flex-col gap-2 p-4", className),
        children: (
          <>
            <div className="flex items-start justify-between gap-2">
              <span
                data-slot="stat-label"
                className="text-[13px] font-extrabold uppercase tracking-[0.08em] text-muted-foreground"
              >
                {label}
              </span>
              {tag ? <span className="shrink-0">{tag}</span> : null}
            </div>
            <span
              data-slot="stat-value"
              className={cn(
                "text-[28px] font-[900] leading-none tracking-[-0.02em]",
                valueTone ? toneClass[valueTone] : "text-foreground",
              )}
            >
              {value}
            </span>
            {delta ? (
              <span
                data-slot="stat-delta"
                className={cn(
                  "text-[13px] font-semibold",
                  deltaTone ? toneClass[deltaTone] : "text-muted-foreground",
                )}
              >
                {delta}
              </span>
            ) : null}
          </>
        ),
      }),
    });
  },
);
StatCard.displayName = "StatCard";
