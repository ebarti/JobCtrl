import {
  WORKFLOW_RUN_SORT_FIELDS,
  WORKFLOW_RUN_STATUS_FILTERS,
} from "@jobctrl/contracts";
import { z } from "zod";

export const runsSearchSchema = z.object({
  status: z.enum(WORKFLOW_RUN_STATUS_FILTERS).default("all"),
  workflowType: z.string().default(""),
  startedSince: z.string().default(""),
  startedBefore: z.string().default(""),
  sort: z.enum(WORKFLOW_RUN_SORT_FIELDS).default("started_at"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
});

export type RunsSearch = z.infer<typeof runsSearchSchema>;
