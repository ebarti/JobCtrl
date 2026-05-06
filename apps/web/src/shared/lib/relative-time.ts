const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function formatRelative(date: Date, now: Date = new Date()): string {
  const deltaMs = date.getTime() - now.getTime();
  const absMs = Math.abs(deltaMs);
  if (absMs < MINUTE) {
    return deltaMs >= 0 ? "in a moment" : "just now";
  }
  if (absMs < HOUR) {
    const minutes = Math.round(absMs / MINUTE);
    return deltaMs >= 0 ? `in ${minutes}m` : `${minutes}m ago`;
  }
  if (absMs < DAY) {
    const hours = Math.round(absMs / HOUR);
    return deltaMs >= 0 ? `in ${hours}h` : `${hours}h ago`;
  }
  if (absMs < WEEK) {
    const days = Math.round(absMs / DAY);
    return deltaMs >= 0 ? `in ${days}d` : `${days}d ago`;
  }
  return date.toLocaleDateString();
}
