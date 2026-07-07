import type {
  ProfileImported,
  ProfileUpdated,
  TailoringPolicyUpdated,
} from "@jobctrl/domain-types";

import { artifactsKeys } from "../operations/artifactsKeys.js";
import { dashboardKeys } from "../operations/dashboardKeys.js";
import { invalidate, type InvalidationItem } from "../operations/invalidation-router.js";
import { jobsKeys } from "../operations/jobsKeys.js";
import { profileKeys } from "./queryKeys.js";

export const profileUpdatedHandler = (
  event: ProfileUpdated,
): readonly InvalidationItem[] => [invalidate(profileKeys.profile(event.tenantId))];

export const profileImportedHandler = (
  event: ProfileImported,
): readonly InvalidationItem[] => [invalidate(profileKeys.profile(event.tenantId))];

export const tailoringPolicyUpdatedHandler = (
  event: TailoringPolicyUpdated,
): readonly InvalidationItem[] => [
  invalidate(profileKeys.profile(event.tenantId)),
  invalidate(jobsKeys.all(event.tenantId)),
  invalidate(artifactsKeys.all(event.tenantId)),
  invalidate(dashboardKeys.summary(event.tenantId)),
];
