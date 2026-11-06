import { invalidateQueriesWithOptimisticOwnership } from "../../shared/lib/createOptimisticMutation.js";
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
    "ActionStarted",
    "ActionCompleted",
    "ActionFailed",
    "ActionCancellationRequested",
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
  handle(event, client) {
    void invalidateQueriesWithOptimisticOwnership(
      client,
      applyKeys.all(event.tenantId),
    );
  },
};
