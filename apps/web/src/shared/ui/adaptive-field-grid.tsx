import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn.js";

export interface AdaptiveFieldGridProps extends HTMLAttributes<HTMLDivElement> {
  readonly children: ReactNode;
  readonly columns?: "auto" | 1 | 2 | 3 | 4;
  readonly minColumnWidth?: number;
  readonly density?: "compact" | "regular";
}

type AdaptiveGridStyle = CSSProperties & {
  "--adaptive-field-min"?: string;
};

export function AdaptiveFieldGrid({
  children,
  className,
  columns = "auto",
  minColumnWidth = 220,
  density = "regular",
  style,
  ...props
}: AdaptiveFieldGridProps) {
  const adaptiveStyle: AdaptiveGridStyle = {
    ...style,
    "--adaptive-field-min": `${minColumnWidth}px`,
  };

  return (
    <div
      className={cn("adaptive-field-grid-container", className)}
      style={adaptiveStyle}
      {...props}
    >
      <div
        className="adaptive-field-grid"
        data-columns={columns}
        data-density={density}
      >
        {children}
      </div>
    </div>
  );
}

export interface AdaptiveFieldSpanProps extends HTMLAttributes<HTMLDivElement> {
  readonly children: ReactNode;
  readonly span?: "wide" | "full";
}

export function AdaptiveFieldSpan({
  children,
  className,
  span = "wide",
  ...props
}: AdaptiveFieldSpanProps) {
  return (
    <div className={cn("adaptive-field-span", className)} data-span={span} {...props}>
      {children}
    </div>
  );
}
