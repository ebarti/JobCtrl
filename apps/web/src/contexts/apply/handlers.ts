import type {
  ApplicationFailed,
  ApplicationSubmitted,
  ApplyRunEventRecorded,
  ApplyRunStarted,
} from "@jobhunter/domain-types";

import type { InvalidationItem } from "../operations/invalidation-router.js";

export const applyRunStartedHandler = (
  _event: ApplyRunStarted,
): readonly InvalidationItem[] => [];
export const applyRunEventRecordedHandler = (
  _event: ApplyRunEventRecorded,
): readonly InvalidationItem[] => [];
export const applicationSubmittedHandler = (
  _event: ApplicationSubmitted,
): readonly InvalidationItem[] => [];
export const applicationFailedHandler = (
  _event: ApplicationFailed,
): readonly InvalidationItem[] => [];
