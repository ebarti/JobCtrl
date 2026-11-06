import { CareerLearningResponseSchema } from "@jobctrl/contracts";
import { z } from "zod";

// The shared wire schema includes the Python receipt and source fences.
export const LearningResponseSchema = CareerLearningResponseSchema;
export type LearningResponse = z.infer<typeof LearningResponseSchema>;
export type CareerCohort = LearningResponse["cohorts"][number];
export type CareerMilestone = LearningResponse["milestones"][number];
