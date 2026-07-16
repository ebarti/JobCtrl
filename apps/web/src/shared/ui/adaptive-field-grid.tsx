import { type ComponentPropsWithoutRef, type ReactNode } from "react";

import { cn } from "../lib/cn.js";
import { FieldGroup } from "./field.js";

export interface AdaptiveFieldGridProps extends Omit<
  ComponentPropsWithoutRef<"div">,
  "children"
> {
  readonly children: ReactNode;
}

export interface AdaptiveFieldSpanProps extends Omit<
  ComponentPropsWithoutRef<"div">,
  "children"
> {
  readonly children: ReactNode;
  readonly span?: "wide" | "full";
}

/**
 * Query-container-backed property grid. Its inner FieldGroup responds to the
 * space this composition actually receives instead of the viewport width.
 */
export function AdaptiveFieldGrid({
  children,
  className,
  ...props
}: AdaptiveFieldGridProps) {
  return (
    <div
      {...props}
      className={cn("adaptive-field-grid", className)}
      data-slot="adaptive-field-grid"
    >
      <FieldGroup className="adaptive-field-grid__fields">
        {children}
      </FieldGroup>
    </div>
  );
}

/** Named multi-column span that collapses with its owning AdaptiveFieldGrid. */
export function AdaptiveFieldSpan({
  children,
  className,
  span = "wide",
  ...props
}: AdaptiveFieldSpanProps) {
  return (
    <div
      {...props}
      className={cn("adaptive-field-span", className)}
      data-slot="adaptive-field-span"
      data-span={span}
    >
      {children}
    </div>
  );
}
