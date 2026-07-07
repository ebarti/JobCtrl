import type {
  OutreachDraftDto,
  OutreachDraftKind,
  OutreachDraftStatus,
} from "@jobctrl/contracts";

export const OUTREACH_DRAFT_STATUS_LABELS: Record<OutreachDraftStatus, string> = {
  candidate: "Under review",
  approved: "Approved",
  rejected: "Rejected",
  superseded: "Superseded",
};

export const OUTREACH_DRAFT_KIND_LABELS: Record<OutreachDraftKind, string> = {
  intro_request: "Intro request",
  follow_up: "Follow-up",
};

export function outreachDraftStatusLabel(status: OutreachDraftStatus | string): string {
  return (OUTREACH_DRAFT_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export function outreachDraftKindLabel(kind: OutreachDraftKind | string): string {
  return (OUTREACH_DRAFT_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

/**
 * Format an approved draft's body for a user-initiated clipboard copy (INV-1: an
 * approved draft leaves JobCtrl only when the user copies it — there is no send
 * transport). Returns the trimmed body text, preserving internal line breaks so
 * the message pastes intact.
 */
export function formatApprovedDraftForClipboard(draft: OutreachDraftDto): string {
  return draft.bodyText.trim();
}
