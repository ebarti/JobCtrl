import type { ProfileImported, ProfileUpdated } from "@jobhunter/domain-types";

import { invalidate, type InvalidationItem } from "../operations/invalidation-router.js";
import { profileKeys } from "./queryKeys.js";

export const profileUpdatedHandler = (
  event: ProfileUpdated,
): readonly InvalidationItem[] => [invalidate(profileKeys.profile(event.tenantId))];

export const profileImportedHandler = (
  event: ProfileImported,
): readonly InvalidationItem[] => [invalidate(profileKeys.profile(event.tenantId))];
