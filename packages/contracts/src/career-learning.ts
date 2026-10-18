import { z } from "zod";
import {
  DeterminationCitationSchema,
  DeterminationEnvelopeSchema,
} from "./semantic-determinations.js";

export const CareerDemandSchema = z
  .object({
    demand_id: z.string().min(1).max(80),
    skill: z.string().min(1).max(200),
    mentions: z.array(DeterminationCitationSchema).min(1).max(60),
    capability: z.enum([
      "demonstrated",
      "partial",
      "not_evidenced",
      "uncertain",
    ]),
    evidence: z.array(DeterminationCitationSchema).max(24),
    rationale: z.string().min(1).max(2000),
    uncertainty: z.string().min(1).max(2000),
  })
  .strict();
export const CareerMilestoneProposalSchema = z
  .object({
    proposal_id: z.string().min(1).max(80),
    demand_id: z.string().min(1).max(80),
    kind: z.enum(["learning", "evidence_building"]),
    title: z.string().min(1).max(240),
    action: z.string().min(1).max(2000),
    completion_criterion: z.string().min(1).max(2000),
    rationale: z.string().min(1).max(2000),
  })
  .strict();
export const CareerDemandComparisonSchema = z
  .object({
    demands: z.array(CareerDemandSchema).max(60),
    proposals: z.array(CareerMilestoneProposalSchema).max(30),
    uncertainty: z.string().min(1).max(2000),
  })
  .strict();
const SourceSchema = z
  .object({
    source_id: z.string().min(1).max(240),
    text: z.string().max(64000),
  })
  .strict();
const SnapshotSchema = z
  .object({
    profileVersion: z.number().int().positive().nullable(),
    jobs: z
      .array(
        z
          .object({
            jobId: z.string().uuid(),
            title: z.string(),
            company: z.string(),
            sourceId: z.string(),
            text: z.string(),
            applicationUrls: z.array(z.string()),
          })
          .strict(),
      )
      .max(30),
    sources: z.array(SourceSchema).max(230),
    selectedCount: z.number().int().positive(),
    cohortSize: z.number().int().positive(),
    analyzedCount: z.number().int().nonnegative(),
    missingDescriptions: z.array(z.string().uuid()),
    duplicateSelections: z.array(
      z
        .object({ jobId: z.string().uuid(), count: z.number().int().min(2) })
        .strict(),
    ),
    duplicateIdentities: z.array(z.array(z.string().uuid()).min(2)),
    confirmedEvidenceCount: z.number().int().nonnegative(),
    excludedEvidenceCount: z.number().int().nonnegative(),
  })
  .strict();
const CohortSchema = z
  .object({
    cohortId: z.string().uuid(),
    revision: z.number().int().positive(),
    title: z.string().min(1).max(160),
    asOf: z.iso.date(),
    aspirations: z.string().max(2000),
    comparedAt: z.iso.datetime({ offset: true }),
    jobIds: z.array(z.string().uuid()).min(1).max(30),
    snapshot: SnapshotSchema,
    snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    determinationId: z.string().regex(/^[a-f0-9]{64}$/),
    determination: DeterminationEnvelopeSchema,
    comparison: CareerDemandComparisonSchema,
  })
  .strict();
const MilestoneStatusSchema = z.enum([
  "planned",
  "in_progress",
  "completed",
  "abandoned",
]);
const MilestoneHistorySchema = z
  .object({
    revision: z.number().int().positive(),
    status: MilestoneStatusSchema,
    completionEvidence: z.string().max(4000),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export const CareerLearningResponseSchema = z
  .object({
    ok: z.literal(true),
    truncated: z.boolean(),
    preview: SnapshotSchema.extend({
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    }).nullable(),
    cohorts: z
      .array(
        CohortSchema.extend({
          staleReasons: z.array(z.string()),
          lastAttempt: z
            .object({
              cohortId: z.string().uuid(),
              failureCode: z.string().nullable(),
              occurredAt: z.iso.datetime({ offset: true }),
            })
            .strict()
            .nullable(),
        }),
      )
      .max(20),
    milestones: z
      .array(
        MilestoneHistorySchema.extend({
          milestoneId: z.string().regex(/^[a-f0-9]{64}$/),
          cohortId: z.string().uuid(),
          cohortRevision: z.number().int().positive(),
          determinationId: z.string().regex(/^[a-f0-9]{64}$/),
          proposal: CareerMilestoneProposalSchema,
          origin: CohortSchema,
          selectedAt: z.iso.datetime({ offset: true }),
          staleReasons: z.array(z.string()),
          history: z.array(MilestoneHistorySchema).max(50),
        }),
      )
      .max(100),
  })
  .strict();
export const CareerLearningCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("preview"),
      jobIds: z.array(z.string().uuid()).min(1).max(30),
    })
    .strict(),
  z
    .object({
      action: z.literal("compare"),
      cohortId: z.string().uuid().nullable().optional(),
      expectedRevision: z.number().int().nonnegative(),
      title: z.string().trim().min(1).max(160),
      asOf: z.iso.date(),
      jobIds: z.array(z.string().uuid()).min(1).max(30),
      aspirations: z.string().max(2000),
      expectedSnapshotFingerprint: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("choose"),
      cohortId: z.string().uuid(),
      expectedRevision: z.number().int().positive(),
      determinationId: z.string().regex(/^[a-f0-9]{64}$/),
      proposalId: z.string().min(1).max(80),
    })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      milestoneId: z.string().regex(/^[a-f0-9]{64}$/),
      expectedRevision: z.number().int().positive(),
      status: MilestoneStatusSchema,
      completionEvidence: z.string().max(4000),
    })
    .strict()
    .refine(
      (value) =>
        value.status !== "completed" ||
        Boolean(value.completionEvidence.trim()),
      {
        message:
          "Describe completion evidence before marking a milestone completed.",
        path: ["completionEvidence"],
      },
    ),
]);
export const CareerLearningParamsSchema = z
  .object({
    tenantId: z.string().min(1),
    expectedAppDir: z.string().min(1),
    expectedDbPath: z.string().min(1),
    command: CareerLearningCommandSchema.optional(),
  })
  .strict();
export type CareerLearningCommand = z.infer<typeof CareerLearningCommandSchema>;
export type CareerLearningResponse = z.infer<
  typeof CareerLearningResponseSchema
>;
export type CareerCohort = CareerLearningResponse["cohorts"][number];
export type CareerMilestone = CareerLearningResponse["milestones"][number];
