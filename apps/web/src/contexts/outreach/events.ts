import type { FeatureEventHandler } from "../../shared/ports/FeatureEvents.js";
import { outreachKeys } from "./queryKeys.js";

const contactEvents = ["ContactCreated", "ContactUpdated", "ContactDeleted"] as const;
const researchEvents = ["ContactResearchTaskStarted", "ContactResearchTaskUpdated", "ContactResearchTaskFailed", "ContactCandidateConfirmed"] as const;
const threadEvents = ["OutreachDraftGenerated", "OutreachDraftRevised", "OutreachDraftApproved", "OutreachDraftRejected", "OutreachSendLogged", "FollowUpScheduled", "FollowUpCompleted", "FollowUpDismissed"] as const;
const sourceEvents = ["ProfileUpdated", "ProfileSourceUpdated", "JobCaptured", "JobSourceObserved", "JobUpdated", "OfferRecordChanged", "CompensationEvidenceChanged", "CompensationRefreshChanged", "CompensationSourcePolicyChanged"] as const;

export const outreachEvents: FeatureEventHandler = {
  eventTypes: [...contactEvents, ...researchEvents, ...threadEvents, ...sourceEvents],
  handle(event, invalidate) {
    const tenant = event.tenantId;
    if ((contactEvents as readonly string[]).includes(event.eventType)) {
      invalidate(outreachKeys.contacts(tenant));
      invalidate(outreachKeys.threads(tenant));
    }
    if ((researchEvents as readonly string[]).includes(event.eventType)) {
      invalidate(outreachKeys.researchTasks(tenant));
      if (event.eventType === "ContactCandidateConfirmed") invalidate(outreachKeys.contacts(tenant));
    }
    if ((threadEvents as readonly string[]).includes(event.eventType) || (sourceEvents as readonly string[]).includes(event.eventType)) {
      invalidate(outreachKeys.threads(tenant));
    }
    if ((threadEvents as readonly string[]).includes(event.eventType) || event.eventType === "ContactDeleted") {
      invalidate(outreachKeys.dueFollowUps(tenant));
    }
  },
};
