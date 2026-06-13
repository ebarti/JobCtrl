import { z } from "zod";

export const applyReviewSearchSchema = z.object({
  jobKey: z.string().min(1).optional().catch(undefined),
});

export type ApplyReviewSearch = z.infer<typeof applyReviewSearchSchema>;
