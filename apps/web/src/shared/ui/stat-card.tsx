import { forwardRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn.js";
import { Card } from "./card.js";

export type StatDeltaTone = "up" | "warn" | "down";

const deltaToneClass: Record<StatDeltaTone, string> = {
  up: "text-success",
  warn: "text-warning",
  down: "text-destructive",
};

export interface StatCardProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  value: ReactNode;
  tag?: ReactNode;
  delta?: ReactNode;
  deltaTone?: StatDeltaTone;
}

export const StatCard = forwardRef<HTMLDivElement, StatCardProps>(
  ({ label, value, tag, delta, deltaTone = "up", className, ...props }, ref) => (
    <Card ref={ref} className={cn("flex flex-col gap-2 p-4", className)} {...props}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-muted-foreground">
          {label}
        </span>
        {tag ? <span className="shrink-0">{tag}</span> : null}
      </div>
      <span className="text-[28px] font-[900] leading-none tracking-[-0.02em] text-foreground">
        {value}
      </span>
      {delta ? (
        <span className={cn("text-[12px] font-semibold", deltaToneClass[deltaTone])}>{delta}</span>
      ) : null}
    </Card>
  ),
);
StatCard.displayName = "StatCard";
