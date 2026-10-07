import type {
  ProfileImported,
  ProfileUpdated,
  TailoringPolicyUpdated,
} from "@jobctrl/domain-types";

import { artifactsKeys } from "../operations/artifactsKeys.js";
import { evidenceMapKeys } from "../operations/evidenceMapKeys.js";
import { dashboardKeys } from "../operations/dashboardKeys.js";
import { invalidate, type InvalidationItem } from "../operations/invalidation-router.js";
import { interviewKeys } from "../operations/interviewKeys.js";
import { jobsKeys } from "../operations/jobsKeys.js";
import { discoveryKeys } from "../operations/queryKeys.js";
import { profileKeys } from "./queryKeys.js";

export const profileUpdatedHandler = (
  event: ProfileUpdated,
): readonly InvalidationItem[] => [invalidate(profileKeys.profile(event.tenantId)), invalidate(discoveryKeys.preferences(event.tenantId)), invalidate(evidenceMapKeys.list(event.tenantId)), invalidate(interviewKeys.jobs(event.tenantId)), invalidate(jobsKeys.details(event.tenantId))];

export const profileImportedHandler = (
  event: ProfileImported,
): readonly InvalidationItem[] => [invalidate(profileKeys.profile(event.tenantId)), invalidate(discoveryKeys.preferences(event.tenantId)), invalidate(evidenceMapKeys.list(event.tenantId)), invalidate(interviewKeys.jobs(event.tenantId)), invalidate(jobsKeys.details(event.tenantId))];

export const tailoringPolicyUpdatedHandler = (
  event: TailoringPolicyUpdated,
): readonly InvalidationItem[] => [
  invalidate(profileKeys.profile(event.tenantId)),
  invalidate(jobsKeys.all(event.tenantId)),
  invalidate(artifactsKeys.all(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];
