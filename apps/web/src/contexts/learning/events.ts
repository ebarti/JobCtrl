import type { FeatureEventHandler } from "../../shared/ports/FeatureEvents.js";
import { careerLearningKeys } from "./queryKeys.js";

export const learningEvents: FeatureEventHandler = {
  eventTypes: ["CareerLearningRecorded", "ProfileUpdated", "ProfileSourceUpdated", "JobSourceObserved", "JobUpdated"],
  handle(event, invalidate) {
    invalidate(careerLearningKeys.all(event.tenantId));
  },
};
