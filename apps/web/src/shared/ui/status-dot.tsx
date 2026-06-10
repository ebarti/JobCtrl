import type { StatusDotState } from "./status-tokens.js";

export interface StatusDotProps {
  state: StatusDotState;
}

export function StatusDot({ state }: StatusDotProps) {
  return <span aria-hidden="true" className={`status-dot ${state}`} />;
}
