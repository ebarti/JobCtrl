"use client";

import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import type { ReactNode } from "react";

import { cn } from "../lib/cn.js";

function Progress({
  className,
  children,
  value,
  ...props
}: ProgressPrimitive.Root.Props) {
  return (
    <ProgressPrimitive.Root
      value={value}
      data-slot="progress"
      className={cn("flex flex-wrap gap-3", className)}
      {...props}
    >
      {children}
      <ProgressTrack>
        <ProgressIndicator />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  );
}

function ProgressTrack({ className, ...props }: ProgressPrimitive.Track.Props) {
  return (
    <ProgressPrimitive.Track
      className={cn(
        "relative flex h-2 w-full items-center overflow-x-hidden rounded-2xl bg-muted",
        className,
      )}
      data-slot="progress-track"
      {...props}
    />
  );
}

function ProgressIndicator({
  className,
  ...props
}: ProgressPrimitive.Indicator.Props) {
  return (
    <ProgressPrimitive.Indicator
      data-slot="progress-indicator"
      className={cn("h-full bg-primary transition-all", className)}
      {...props}
    />
  );
}

function ProgressLabel({ className, ...props }: ProgressPrimitive.Label.Props) {
  return (
    <ProgressPrimitive.Label
      className={cn("text-sm font-medium", className)}
      data-slot="progress-label"
      {...props}
    />
  );
}

type ProgressValueFormatter = NonNullable<
  ProgressPrimitive.Value.Props["children"]
>;

type ProgressValueProps = Omit<ProgressPrimitive.Value.Props, "children"> & {
  readonly children?: ProgressValueFormatter | ReactNode;
};

function ProgressValue({
  children,
  className,
  ...props
}: ProgressValueProps) {
  const valueChildren =
    typeof children === "function"
      ? children
      : children === undefined
        ? undefined
        : () => children;

  return (
    <ProgressPrimitive.Value
      className={cn(
        "ml-auto text-sm text-muted-foreground tabular-nums",
        className,
      )}
      data-slot="progress-value"
      {...props}
    >
      {valueChildren}
    </ProgressPrimitive.Value>
  );
}

export {
  Progress,
  ProgressTrack,
  ProgressIndicator,
  ProgressLabel,
  ProgressValue,
};
