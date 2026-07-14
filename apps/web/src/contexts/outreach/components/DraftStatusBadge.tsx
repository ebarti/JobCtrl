import type { OutreachDraftStatus } from "@jobctrl/contracts";
import type { JSX } from "react";

import { StatusLabel, type StatusLabelTone } from "../../../shared/ui/status-label.js";
import { outreachDraftStatusLabel } from "../lib/draft-copy.js";

const STATUS_TONE: Record<OutreachDraftStatus, StatusLabelTone> = {
  candidate: "info",
  approved: "ok",
  rejected: "danger",
  superseded: "muted",
};

export interface DraftStatusBadgeProps {
  status: OutreachDraftStatus;
}

export function DraftStatusBadge({ status }: DraftStatusBadgeProps): JSX.Element {
  const label = outreachDraftStatusLabel(status);
  return (
    <StatusLabel
      className={`outreach-draft-status-${status}`}
      title={`Draft status: ${label}`}
      tone={STATUS_TONE[status]}
    >
      {label}
    </StatusLabel>
  );
}
