import { z } from "zod";

export const ANALYTICS_DIMENSIONS = [
  "source",
  "score_band",
  "fit_band",
  "apply_mode",
  "template",
  "policy",
] as const;

export type AnalyticsDimension = (typeof ANALYTICS_DIMENSIONS)[number];

export const analyticsSearchSchema = z.object({
  dimension: z.enum(ANALYTICS_DIMENSIONS).default("source"),
});

export type AnalyticsSearch = z.infer<typeof analyticsSearchSchema>;
