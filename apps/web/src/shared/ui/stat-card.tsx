import { Slot, Slottable } from "@radix-ui/react-slot";
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn.js";
import { cardClassName } from "./card.js";

export type StatTone = "up" | "warn" | "down";

const toneClass: Record<StatTone, string> = {
  up: "text-success",
  warn: "text-warning",
  down: "text-destructive",
};

export interface StatCardProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  value: ReactNode;
  tag?: ReactNode;
  delta?: ReactNode;
  deltaTone?: StatTone | undefined;
  valueTone?: StatTone | undefined;
  /**
   * Render the card as the single child element (e.g. an anchor) so the whole
   * surface becomes interactive while keeping the stat layout. Uses the Radix
   * Slot pattern; the child's own props (href, onClick) are preserved.
   */
  asChild?: boolean;
}

export const StatCard = forwardRef<HTMLDivElement, StatCardProps>(
  (
    { label, value, tag, delta, deltaTone, valueTone, asChild = false, className, children, ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot : "div";
    return (
      <Comp
        ref={ref}
        className={cn(cardClassName, "flex flex-col gap-2 p-4", className)}
        {...props}
      >
        <div className="flex items-start justify-between gap-2">
          <span
            data-slot="stat-label"
            className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-muted-foreground"
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
              "text-[12px] font-semibold",
              deltaTone ? toneClass[deltaTone] : "text-muted-foreground",
            )}
          >
            {delta}
          </span>
        ) : null}
        {asChild ? <Slottable>{children}</Slottable> : null}
      </Comp>
    );
  },
);
StatCard.displayName = "StatCard";
