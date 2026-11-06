import { formatDateTime } from "../../../shared/lib/formatters.js";

/** Calendar-only attestations and reminders must not acquire an invented time. */
export function formatOutreachDate(value: string | null): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : formatDateTime(value);
}
