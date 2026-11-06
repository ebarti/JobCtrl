import { jobsInvalidation } from "./contexts/jobs/index.js";
import { composedJobsEvents } from "./contexts/jobs/composedList.js";
import { requirementsInvalidation } from "./contexts/requirements/index.js";
import { fitInvalidation } from "./contexts/fit/index.js";
import { wordingInvalidation, profileSourcesInvalidation } from "./contexts/profile/index.js";
import { resumesInvalidation } from "./contexts/resumes/index.js";
import { companyEvents } from "./contexts/companies/index.js";
import { interviewEvents } from "./contexts/interviews/index.js";
import { learningEvents } from "./contexts/learning/index.js";
import { digestEvents } from "./contexts/digest/index.js";
import { discoveryEvents } from "./contexts/discovery/index.js";
import { compensationEvents } from "./contexts/compensation/index.js";
import { offerEvents } from "./contexts/offers/index.js";
import { outreachEvents } from "./contexts/outreach/index.js";
import { applicationsEvents, outcomeEvents } from "./contexts/apply/index.js";
import { applicationSettingsEvents } from "./contexts/settings/index.js";
import { activityEvents } from "./contexts/activity/index.js";
import { pipelineTelemetryEvents, preparationInvalidation } from "./contexts/pipeline/index.js";
import { actionRunEvents } from "./contexts/runs/index.js";
import { credentialEvents } from "./contexts/settings/credentials.js";
import type { FeatureEventHandler } from "./shared/ports/FeatureEvents.js";

/** Application composition: every mounted feature contributes its event names. */
export const featureEventHandlers: readonly FeatureEventHandler[] = [
  jobsInvalidation,
  composedJobsEvents,
  requirementsInvalidation,
  fitInvalidation,
  wordingInvalidation,
  profileSourcesInvalidation,
  resumesInvalidation,
  companyEvents,
  interviewEvents,
  learningEvents,
  digestEvents,
  discoveryEvents,
  compensationEvents,
  offerEvents,
  outreachEvents,
  outcomeEvents,
  applicationsEvents,
  applicationSettingsEvents,
  activityEvents,
  preparationInvalidation,
  pipelineTelemetryEvents,
  actionRunEvents,
  credentialEvents,
];
