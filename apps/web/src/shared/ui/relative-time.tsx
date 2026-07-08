import type { JSX } from "react";

import { formatRelative } from "../lib/relative-time.js";

export interface RelativeTimeProps {
  value: string | null;
  fallback?: string;
}

export function RelativeTime({ value, fallback = "-" }: RelativeTimeProps): JSX.Element {
  if (!value) {
    return <span>{fallback}</span>;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return <span>{value}</span>;
  }
  return (
    <time dateTime={parsed.toISOString()} title={parsed.toLocaleString()}>
      {formatRelative(parsed)}
    </time>
  );
}
