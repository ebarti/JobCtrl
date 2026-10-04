import { z } from "zod";

export const interviewsSearchSchema = z.object({
  q: z.string().max(200).catch(""),
  topic: z.string().max(100).catch(""),
  role: z.string().max(100).catch(""),
  source: z.string().max(100).catch(""),
  format: z.string().max(100).catch(""),
  mode: z.enum(["graph", "list"]).catch("list"),
  card: z.string().max(100).catch(""),
  job: z.string().max(200).catch(""),
});

export type InterviewsSearch = z.infer<typeof interviewsSearchSchema>;
