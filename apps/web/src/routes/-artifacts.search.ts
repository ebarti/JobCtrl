import { z } from "zod";

export const ARTIFACT_STATUSES = [
  "all",
  "accepted",
  "accepted_history",
  "candidate",
  "history",
  "accepted_translation",
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
  q: z.string().max(4000).default(""),
  status: z.enum(ARTIFACT_STATUSES).catch("all"),
  sort: z.enum(ARTIFACT_SORT_FIELDS_TUPLE).catch("created_at"),
  dir: z.enum(["asc", "desc"]).catch("desc"),
  page: z.number().int().min(1).catch(1),
  pageSize: z.number().int().min(1).max(200).catch(50),
});
export type ArtifactsSearch = z.infer<typeof artifactsSearchSchema>;
