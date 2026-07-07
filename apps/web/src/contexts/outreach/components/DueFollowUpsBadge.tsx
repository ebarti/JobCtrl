import type { JSX } from "react";

import { useDueFollowUpsQuery } from "../hooks/useDueFollowUpsQuery.js";

// Compact count of follow-ups that are due right now, for surfacing next to the
// outreach entry points. Renders nothing when none are due. These are reminders
// only — JobCtrl never sends them (INV-1).
export function DueFollowUpsBadge(): JSX.Element | null {
  const query = useDueFollowUpsQuery();
  const dueCount = (query.data ?? []).filter((item) => item.isDue).length;
  if (dueCount === 0) {
    return null;
  }
  return (
    <span className="tag outreach-due-badge" aria-label={`${dueCount} follow-ups due`}>
      {dueCount} due
    </span>
  );
}
