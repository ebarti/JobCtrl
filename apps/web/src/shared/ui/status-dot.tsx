export interface StatusDotProps {
  state: string;
}

export function StatusDot({ state }: StatusDotProps) {
  return <span className={`status-dot ${state}`} />;
}
