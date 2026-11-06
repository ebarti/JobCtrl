import { usePorts } from "../../../shared/providers/PortsProvider.js";
import type { OutreachDraftDto } from "@jobctrl/contracts";
export function useCopyOfferDraft() {
  const { http, clipboard } = usePorts();
  return async (
    draft: OutreachDraftDto,
    threadId?: string,
    expectedFingerprint?: string,
  ) => {
    if (draft.status !== "approved" || draft.offerSourcesCurrent === false)
      throw new Error("Review a current approved offer draft before copying.");
    if (!threadId || !expectedFingerprint) throw new Error("Refresh the outreach thread before copying.");
    const saved = await http.json<{ ok: true; draftId: string; bodyText: string }>(
      "POST", `/v1/outreach/threads/${encodeURIComponent(threadId)}/drafts/${encodeURIComponent(draft.draftId)}/copy`,
      { body: { expectedFingerprint } },
    );
    if (saved.ok !== true || saved.draftId !== draft.draftId || saved.bodyText !== draft.bodyText) {
      throw new Error("The approved message changed. Refresh and review it before copying.");
    }
    await clipboard.write(saved.bodyText);
  };
}
