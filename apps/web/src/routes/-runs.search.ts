import { z } from "zod";

export const runsSearchSchema = z.object({
  status: z.enum(["all", "pending", "queued", "running", "succeeded", "failed", "cancelled", "start_failed"]).catch("all"),
  workflowType: z.string().default(""),
  startedSince: z.string().default(""),
  startedBefore: z.string().default(""),
  sort: z.string().default("started_at"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
});

export type RunsSearch = z.infer<typeof runsSearchSchema>;
