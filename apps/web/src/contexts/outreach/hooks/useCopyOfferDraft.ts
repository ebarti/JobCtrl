import { usePorts } from "../../../shared/providers/PortsProvider.js";
import type { OutreachDraftDto } from "@jobctrl/contracts";
export function useCopyOfferDraft() {
  const { api, clipboard } = usePorts();
  return async (
    draft: OutreachDraftDto,
    contactId?: string,
    jobId?: string,
  ) => {
    if (draft.status !== "approved" || draft.offerSourcesCurrent === false)
      throw new Error("Review a current approved offer draft before copying.");
    if (draft.kind.startsWith("offer_")) {
      if (!contactId || !jobId)
        throw new Error("Offer source binding is missing.");
      const fresh = await api.outreachThread(contactId, { jobId });
      const saved = fresh.thread?.drafts.find(
        (value) => value.draftId === draft.draftId,
      );
      if (
        !saved ||
        saved.status !== "approved" ||
        saved.offerSourcesCurrent !== true ||
        saved.bodyText !== draft.bodyText
      ) {
        throw new Error(
          "Offer terms or decision changed. Generate and review a new draft.",
        );
      }
    }
    await clipboard.write(draft.bodyText.trim());
  };
}
