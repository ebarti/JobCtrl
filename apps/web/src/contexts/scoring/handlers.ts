import type { JobScored, ScoreCorrected } from "@jobhunter/domain-types";

import type { InvalidationItem } from "../operations/invalidation-router.js";

export const jobScoredHandler = (_event: JobScored): readonly InvalidationItem[] => [];
export const scoreCorrectedHandler = (_event: ScoreCorrected): readonly InvalidationItem[] => [];
