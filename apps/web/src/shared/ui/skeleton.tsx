import type { HTMLAttributes, JSX } from "react";

import { cn } from "../lib/cn.js";

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}
