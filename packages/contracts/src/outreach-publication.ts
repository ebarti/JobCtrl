import { z } from "zod";

// A completed proposal is private review data, with no accepted draft identity,
// generation or approval authority. It must never enter the canonical cache.
export const OutreachPublicationConflictSchema = z.object({
  outcome: z.literal("conflict"),
  threadId: z.string().min(1),
  unpublishedDraft: z.object({
    bodyText: z.string(),
    kind: z.enum(["intro_request", "follow_up", "offer_negotiation", "offer_clarification", "offer_acceptance", "offer_decline"]),
    gateResults: z.object({
      passed: z.boolean(),
      computedAgainst: z.string(),
      determinationIds: z.array(z.string()),
      lineAnchors: z.array(z.record(z.string(), z.unknown())),
      sourceContext: z.record(z.string(), z.unknown()).nullable(),
      fabrications: z.array(z.record(z.string(), z.unknown())),
      validation: z.object({ passed: z.boolean(), errors: z.array(z.string()), warnings: z.array(z.string()) }).strict(),
      judge: z.object({
        approved: z.boolean(), score: z.number(), criterionScores: z.record(z.string(), z.number()),
        issues: z.array(z.string()), notes: z.string(),
      }).strict().nullable(),
    }).strict(),
    provenance: z.array(z.object({
      claimId: z.string(), section: z.string(), generatedText: z.string(),
      contactFactIds: z.array(z.string()), profileGrounded: z.boolean(), rationale: z.string(),
      sourceCitations: z.array(z.object({ sourceId: z.string(), quote: z.string() }).strict()).optional(),
    }).strict()),
  }).strict(),
}).strict();
export type OutreachPublicationConflict = z.infer<typeof OutreachPublicationConflictSchema>;
