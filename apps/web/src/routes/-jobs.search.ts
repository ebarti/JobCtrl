import {
  JOB_APPLY_STATUS_FILTERS,
  JOB_SORT_FIELDS,
  STAGES,
  STAGE_STATES,
} from "@jobhunter/contracts";
import { z } from "zod";

const STAGE_OR_ALL = [...STAGES, "all"] as const;
const STATE_OR_ALL = [...STAGE_STATES, "all"] as const;
const optionalScore = z
  .preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.coerce.number().int().min(1).max(10).optional(),
  )
  .catch(undefined);
const optionalTimestamp = z
  .preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.string().trim().min(1).optional(),
  )
  .catch(undefined);

export const jobsSearchSchema = z.object({
  q: z.string().default(""),
  stage: z.enum(STAGE_OR_ALL).default("all"),
  state: z.enum(STATE_OR_ALL).default("all"),
  applyStatus: z.enum(JOB_APPLY_STATUS_FILTERS).default("all"),
  deleted: z.enum(["active", "closed", "deleted", "hidden"]).default("active"),
  sort: z.enum(JOB_SORT_FIELDS).default("discovered_at"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
  minFitScore: optionalScore,
  maxFitScore: optionalScore,
  discoveredSince: optionalTimestamp,
  scoredSince: optionalTimestamp,
});

export type JobsSearch = z.infer<typeof jobsSearchSchema>;
