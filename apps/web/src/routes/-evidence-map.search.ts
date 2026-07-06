import { z } from "zod";

export const evidenceMapSearchSchema = z.object({
  q: z.string().catch(""),
  entry: z.string().catch(""),
  job: z.string().catch(""),
});

export type EvidenceMapSearch = z.infer<typeof evidenceMapSearchSchema>;
