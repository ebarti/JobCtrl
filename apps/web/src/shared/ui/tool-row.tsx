import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn.js";

export interface ToolRowProps extends HTMLAttributes<HTMLDivElement> {
  readonly primary?: ReactNode;
  readonly secondary?: ReactNode;
  readonly status?: ReactNode;
}

/** Shared action-row composition for route workspaces and data surfaces. */
export function ToolRow({
  primary,
  secondary,
  status,
  className,
  ...props
}: ToolRowProps) {
  return (
    <div className={cn("tool-row", className)} {...props}>
      {primary ? <div className="tool-row__primary">{primary}</div> : null}
      {secondary ? (
        <div className="tool-row__secondary">{secondary}</div>
      ) : null}
      {status ? <div className="tool-row__status">{status}</div> : null}
    </div>
  );
}
