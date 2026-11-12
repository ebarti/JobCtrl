import { z } from "zod";

const Count = z.number().int().nonnegative().nullable();
const Section = z.object({ count: Count }).passthrough();
export const DigestSchema = z.object({
  ok: z.literal(true), generatedAt: z.string(), since: z.string().nullable(), highFitThreshold: z.number(),
  newMatches: Section.extend({ highFitCount: Count }),
  blockedSources: Section.extend({ sources: z.array(z.object({ sourceId: z.string(), displayName: z.string().optional(), recommendedState: z.string(), consecutiveFailures: z.number() }).passthrough()) }),
  reviewNeededMaterials: Section, staleScores: Section, pendingApprovals: Section,
  followUpsDue: Section.extend({ derived: z.literal(true), thresholdDays: z.number(), dayBoundary: z.string() }),
  budget: z.object({
    status: z.enum(["ok", "over_budget", "incomplete"]), estimatedUsd: z.number().nullable(),
    dailyBudgetUsd: z.number(), remainingUsd: z.number().nullable(), unlimited: z.boolean(),
    costStatus: z.enum(["complete", "unavailable", "pending", "unresolved"]).optional(),
    tokenStatus: z.enum(["complete", "unavailable", "pending", "unresolved"]).optional(),
    knownUsd: z.number().nonnegative().optional(),
  }),
  deepLinks: z.object({ newMatches: z.string(), blockedSources: z.string(), reviewNeededMaterials: z.string(), staleScores: z.string(), pendingApprovals: z.string(), followUpsDue: z.string(), budget: z.string() }),
  unavailable: z.array(z.string()),
  companyBriefings: z.array(z.object({ companyId: z.string(), jobId: z.string(), name: z.string(), status: z.string(), observedAt: z.string().nullable(), failureCode: z.string().nullable().optional() }).passthrough()).optional(),
}).passthrough();
export type Digest = z.infer<typeof DigestSchema>;
