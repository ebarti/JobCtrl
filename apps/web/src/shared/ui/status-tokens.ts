export const STATUS_TAG_TONES = ["ok", "warn", "danger", "info", "muted"] as const;
export type StatusTagTone = (typeof STATUS_TAG_TONES)[number];

export const STATUS_DOT_STATES = [
  "succeeded",
  "failed",
  "exhausted",
  "blocked",
  "running",
  "queued",
  "pending",
  "skipped",
  "stale",
  "canceled",
] as const;
export type StatusDotState = (typeof STATUS_DOT_STATES)[number];

export const SEGMENT_BAR_TONES = ["done", "failed", "blocked", "running", "pending"] as const;
export type SegmentBarTone = (typeof SEGMENT_BAR_TONES)[number];

export const TIMELINE_TONES = ["info", "success", "warning", "danger", "muted"] as const;
export type TimelineTone = (typeof TIMELINE_TONES)[number];

