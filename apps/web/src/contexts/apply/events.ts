import type { FeatureEventHandler } from "../../shared/ports/FeatureEvents.js";
import { applyKeys } from "./queryKeys.js";

export const applicationsEvents: FeatureEventHandler = {
  eventTypes: [
    "ApplicationsUpdated",
    "ApplicationSubmitIntentRecorded",
    "ApplicationSubmitted",
    "ApplicationOutcomeRecorded",
    "OutcomeSuggestionDecided",
    "ScreeningAnswerUpdated",
    "ActionQueued",
    "ActionStarted",
    "ActionCompleted",
    "ActionFailed",
    "ActionCancellationRequested",
    "ActionCancellationAcknowledged",
    "ProfileUpdated",
    "ProfileWordingUpdated",
    "ProfileSourceUpdated",
    "JobUpdated",
    "JobSourceObserved",
    "ResumeAccepted",
    "ResumeEdited",
    "ResumeRendered",
    "FitAssessed",
    "FitCorrected",
    "FitRequirementCorrected",
    "FitCoverageUpdated",
    "SettingsUpdated",
  ],
  handle(event, invalidate) {
    if (event.eventType === "ActionQueued") {
      const payload = event.payload;
      if (!payload || typeof payload !== "object" || !("action" in payload) ||
          typeof payload.action !== "string" || !payload.action.startsWith("applications.")) return;
    }
    invalidate(applyKeys.all(event.tenantId));
  },
};
