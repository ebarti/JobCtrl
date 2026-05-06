import { JOB_SORT_FIELDS, STAGES, STAGE_STATES } from "@jobhunter/contracts";
import { z } from "zod";

const STAGE_OR_ALL = [...STAGES, "all"] as const;
const STATE_OR_ALL = [...STAGE_STATES, "all"] as const;

export const jobsSearchSchema = z.object({
  q: z.string().default(""),
  stage: z.enum(STAGE_OR_ALL).default("all"),
  state: z.enum(STATE_OR_ALL).default("all"),
  deleted: z.enum(["active", "deleted"]).default("active"),
  sort: z.enum(JOB_SORT_FIELDS).default("discovered_at"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
});

export type JobsSearch = z.infer<typeof jobsSearchSchema>;
