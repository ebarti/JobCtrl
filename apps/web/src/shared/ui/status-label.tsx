import type { JSX, ReactNode } from "react";

import { StatusDot } from "./status-dot.js";
import type { StatusDotState, StatusTagTone } from "./status-tokens.js";

export type StatusLabelTone = StatusTagTone | "neutral";

const DOT_STATE_BY_TONE: Record<StatusLabelTone, StatusDotState> = {
  danger: "failed",
  info: "running",
  muted: "pending",
  neutral: "pending",
  ok: "succeeded",
  warn: "needs_verification",
};

export interface StatusLabelProps {
  readonly ariaLabel?: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly id?: string;
  readonly title?: string;
  readonly tone: StatusLabelTone;
}

/**
 * Compact status treatment for lists and ledgers. The tone stays in the class
 * list so callers retain their semantic styling hooks while the visible state
 * is communicated by a dot and plain language.
 */
export function StatusLabel({
  ariaLabel,
  children,
  className,
  id,
  title,
  tone,
}: StatusLabelProps): JSX.Element {
  return (
    <span
      aria-label={ariaLabel}
      className={["tag", "editorial-status", tone, className].filter(Boolean).join(" ")}
      id={id}
      title={title}
    >
      <StatusDot state={DOT_STATE_BY_TONE[tone]} />
      <span className="editorial-status__label">{children}</span>
    </span>
  );
}
