import type { OutreachDraftStatus } from "@jobctl/contracts";
import type { JSX } from "react";

import { outreachDraftStatusLabel } from "../lib/draft-copy.js";

const STATUS_TONE: Record<OutreachDraftStatus, string> = {
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
    <span className={`tag ${STATUS_TONE[status]} outreach-draft-status-${status}`} title={`Draft status: ${label}`}>
      {label}
    </span>
  );
}
