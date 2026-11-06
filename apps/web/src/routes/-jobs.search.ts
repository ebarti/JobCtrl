import {
  JOB_APPLY_STATUS_FILTERS,
  STAGES,
  STAGE_STATES,
} from "@jobctrl/contracts";
import { z } from "zod";

import { JobStatesFilterSchema } from "@jobctrl/contracts";
import { PYTHON_JOBS_SORT_FIELDS } from "../shared/stores/saved-table-views.js";

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
const jobsQueue = z
  .enum(["active", "closed", "deleted", "hidden"])
  .default("active");
const gridNumber = z.preprocess((value) => value === "" || value === null ? undefined : value,
  z.coerce.number().finite().nonnegative().max(1e12).optional());
const gridScore = z.preprocess((value) => value === "" || value === null ? undefined : value,
  z.coerce.number().int().min(1).max(10).optional());
const gridDate = z.string().trim().min(1).max(64).refine((value) => !Number.isNaN(Date.parse(value)), "Invalid date.").optional();
const columnFilters = z.record(z.string().min(1).max(64), z.object({
  operator: z.enum(["contains", "does_not_contain"]), text: z.string().max(1000),
  selectedValues: z.array(z.string().max(1000)).max(200),
}).strict()).refine((value) => Object.keys(value).length <= 32 && JSON.stringify(value).length <= 12000, "Job filters exceed the URL limit.");

export const jobsSearchSchema = z.object({
  q: z.string().max(1000).default(""),
  stage: z.enum(STAGE_OR_ALL).default("all"),
  state: z.enum(STATE_OR_ALL).default("all"),
  applyStatus: z.enum(JOB_APPLY_STATUS_FILTERS).default("all"),
  deleted: jobsQueue,
  jobStates: JobStatesFilterSchema.optional().catch(undefined),
  sort: z.enum(PYTHON_JOBS_SORT_FIELDS).default("discovered_at"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
  minFitScore: optionalScore,
  maxFitScore: optionalScore,
  discoveredSince: optionalTimestamp,
  scoredSince: optionalTimestamp,
  // The Python-backed grid uses a separate, bounded canonical navigation state.
  grid: z.literal("v1").optional(),
  job_state: z.string().max(100).refine((value) => value === "all" || (value.length > 0 && value.split(",").every((item) => ["active", "closed", "hidden", "deleted"].includes(item)))).optional(),
  fit_state: z.enum(["all", "current", "stale", "unassessed"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  offset: z.coerce.number().int().min(0).max(1e7).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  min_fit_score: gridScore, max_fit_score: gridScore,
  discovered_since: gridDate, scored_since: gridDate,
  posted_min_eur: gridNumber, posted_max_eur: gridNumber, market_min_eur: gridNumber, market_max_eur: gridNumber,
  posted_known: z.enum(["all", "known", "unknown"]).optional(), market_known: z.enum(["all", "known", "unknown"]).optional(),
  compensation_confidence: z.string().max(100).refine((value) => !value || value.split(",").every((item) => ["none", "low", "medium", "high"].includes(item))).optional(),
  compensation_warnings: z.enum(["all", "present", "none"]).optional(),
  column_filters: columnFilters.optional(),
  query_revision: z.string().min(1).max(80).optional(),
}).superRefine((value, context) => {
  if (value.grid === "v1" && (value.offset ?? 0) > 0 && !value.query_revision) {
    context.addIssue({ code: "custom", path: ["query_revision"], message: "Reload the first Jobs page to establish a query revision." });
  }
});

export type JobsSearch = z.infer<typeof jobsSearchSchema>;
