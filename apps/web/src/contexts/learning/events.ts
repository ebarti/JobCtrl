import { invalidateQueriesWithOptimisticOwnership } from "../../shared/lib/createOptimisticMutation.js";
import type { FeatureEventHandler } from "../../shared/ports/FeatureEvents.js";
import { careerLearningKeys } from "./queryKeys.js";

export const learningEvents: FeatureEventHandler = {
  eventTypes: ["CareerLearningRecorded", "ProfileUpdated", "ProfileSourceUpdated", "JobSourceObserved", "JobUpdated"],
  handle(event, queryClient) {
    void invalidateQueriesWithOptimisticOwnership(queryClient, careerLearningKeys.all(event.tenantId));
  },
};
