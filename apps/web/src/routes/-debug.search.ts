import { ACTIVITY_SORT_FIELDS } from "@jobctl/contracts";
import { z } from "zod";

export const debugSearchSchema = z.object({
  q: z.string().default(""),
  level: z.string().default(""),
  stage: z.string().default(""),
  eventType: z.string().default(""),
  sort: z.enum(ACTIVITY_SORT_FIELDS).default("occurred_at"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
});

export type DebugSearch = z.infer<typeof debugSearchSchema>;
