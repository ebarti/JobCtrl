import type { ProfileImported, ProfileUpdated } from "@jobhunter/domain-types";

import type { InvalidationItem } from "../operations/invalidation-router.js";

export const profileUpdatedHandler = (
  _event: ProfileUpdated,
): readonly InvalidationItem[] => [];
export const profileImportedHandler = (
  _event: ProfileImported,
): readonly InvalidationItem[] => [];
