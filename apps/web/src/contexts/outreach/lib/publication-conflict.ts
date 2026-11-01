import { JobCtrlApiError } from "@jobctrl/api-client";
import { OutreachPublicationConflictSchema, type OutreachPublicationConflict } from "@jobctrl/contracts";

/** Read private completion data without giving it canonical draft authority. */
export function readPublicationConflict(error: unknown): OutreachPublicationConflict | null {
  if (!(error instanceof JobCtrlApiError) || error.status !== 409) return null;
  const response = error.responseBody;
  if (!response || typeof response !== "object" || !("outcome" in response) || !("threadId" in response) || !("unpublishedDraft" in response)) return null;
  const parsed = OutreachPublicationConflictSchema.safeParse({
    outcome: response.outcome, threadId: response.threadId, unpublishedDraft: response.unpublishedDraft,
  });
  return parsed.success ? parsed.data : null;
}
