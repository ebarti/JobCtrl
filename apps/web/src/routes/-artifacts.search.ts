import { z } from "zod";

export const ARTIFACT_STATUSES = [
  "all",
  "active",
  "approved",
  "candidate",
  "stale",
  "missing",
  "suppressed",
] as const;

export const ARTIFACT_SORT_FIELDS_TUPLE = [
  "created_at",
  "title",
  "company",
  "type",
  "status",
  "size_bytes",
] as const;

export const artifactsSearchSchema = z.object({
  q: z.string().default(""),
  status: z.enum(ARTIFACT_STATUSES).default("all"),
  sort: z.enum(ARTIFACT_SORT_FIELDS_TUPLE).default("created_at"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
});

export type ArtifactsSearch = z.infer<typeof artifactsSearchSchema>;
