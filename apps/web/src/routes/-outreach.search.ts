import { z } from "zod";

export const outreachSearchSchema = z.object({
  jobId: z.string().default(""),
  employer: z.string().default(""),
});

export type OutreachSearch = z.infer<typeof outreachSearchSchema>;
