import type { JSX } from "react";

import { StatusBadge } from "../../../shared/ui/status-badge.js";
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
    <StatusBadge
      aria-label={`${dueCount} follow-ups due`}
      className="outreach-due-badge"
      tone="warn"
    >
      {dueCount} due
    </StatusBadge>
  );
}
