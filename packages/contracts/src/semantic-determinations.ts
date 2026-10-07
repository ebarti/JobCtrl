import { z } from "zod";
import taxonomy from "./semantic-taxonomy.v1.json" with { type: "json" };

export const SEMANTIC_TAXONOMY = taxonomy;
export const SEMANTIC_TAXONOMY_VERSION = taxonomy.schemaVersion;
// The active analysis format must match domain/materials/analysis.py.
export const EMPLOYER_ANALYSIS_PROMPT_VERSION = "employer-analysis-v4-determinations";

export const DeterminationCitationSchema = z
  .object({
    source_id: z.string().min(1).max(240),
    quote: z.string().min(1).max(4000),
    exact_values: z.array(z.string()).max(32),
  })
  .strict();

export const DeterminationEnvelopeSchema = z
  .object({
    determination_id: z.string().regex(/^[a-f0-9]{64}$/),
    tenant_id: z.string().min(1),
    entity_id: z.string().min(1),
    kind: z.string().min(1),
    schema_version: z.string().min(1),
    prompt_version: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    lane: z.enum([
      "discovery",
      "enrichment",
      "scoring",
      "tailoring",
      "apply",
      "contact",
      "interview",
      "profile",
      "compensation",
    ]),
    input_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    created_at: z.string().min(1),
    result: z.record(z.string(), z.unknown()),
  })
  .strict();

export type DeterminationEnvelope = z.infer<typeof DeterminationEnvelopeSchema>;
export type DeterminationCitation = z.infer<typeof DeterminationCitationSchema>;

export const TrackCodeSchema = z.enum(
  Object.keys(taxonomy.track) as [string, ...string[]],
);
export const SeniorityCodeSchema = z.enum(
  Object.keys(taxonomy.seniority) as [string, ...string[]],
);
export const OccupationFamilyCodeSchema = z.enum(
  Object.keys(taxonomy.occupationFamily) as [string, ...string[]],
);
export const WorkModelCodeSchema = z.enum(
  Object.keys(taxonomy.workModel) as [string, ...string[]],
);
export const RegionCodeSchema = z.enum(
  Object.keys(taxonomy.region) as [string, ...string[]],
);

export const RecordedLineAnchorSchema = z
  .object({
    lineId: z.string().min(1),
    evidenceIds: z.array(z.string()),
    requirementIds: z.array(z.string()),
    transformType: z.string(),
    reason: z.string(),
    determinationId: z.string(),
  })
  .strict();
export const ResumeEditIntentReviewSchema = z
  .object({
    revisionId: z.string().min(1),
    textFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    editIntentId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();
export type ResumeEditIntentReview = z.infer<
  typeof ResumeEditIntentReviewSchema
>;
export const ResumeEditReviewSchema = z
  .object({
    passed: z.boolean(),
    claimVerificationId: z.string(),
    qualityDeterminationId: z.string(),
    editIntentId: z.string().nullable(),
    revisionId: z.string(),
    textFingerprint: z.string(),
    profileVersion: z.number().int().positive(),
    analysisGeneration: z.number().int().nonnegative(),
    anchors: z.array(RecordedLineAnchorSchema),
    errors: z.array(z.string()),
  })
  .strict();
export type ResumeEditReview = z.infer<typeof ResumeEditReviewSchema>;

export const FormOptionSchema = z
  .object({
    option_id: z.string().min(1).max(240),
    label: z.string().max(2000),
  })
  .strict();
export const FormQuestionSchema = z
  .object({
    question_id: z.string().min(1).max(240),
    descriptor: z.string().max(2000),
    control_type: z.enum(["text", "select", "radio", "checkbox"]),
    options: z.array(FormOptionSchema).max(300),
  })
  .strict();
export const FormSnapshotSchema = z
  .object({
    snapshotId: z.string().min(1).max(240),
    pageUrl: z.string().url().max(4000),
    questions: z.array(FormQuestionSchema).min(1).max(200),
  })
  .strict();
export const FormMappingSchema = z
  .object({
    question_id: z.string(),
    decision: z.enum(["mapped", "missing", "unmapped"]),
    fact_id: z.string().nullable(),
    value: z.string(),
    option_id: z.string().nullable(),
    citations: z.array(DeterminationCitationSchema),
    rationale: z.string(),
  })
  .strict();
export const FormMappingResponseSchema = z
  .object({
    ok: z.literal(true),
    snapshotId: z.string(),
    profileVersion: z.number().int().positive(),
    determinationId: z.string(),
    mappings: z.array(FormMappingSchema),
  })
  .strict();
export type FormQuestion = z.infer<typeof FormQuestionSchema>;
export type FormSnapshot = z.infer<typeof FormSnapshotSchema>;
export type FormMappingResponse = z.infer<typeof FormMappingResponseSchema>;

export const RoleEquivalenceSchema = z
  .object({
    verdict: z.enum(["equivalent", "different", "uncertain"]),
    citations: z.array(DeterminationCitationSchema).min(1).max(12),
    rationale: z.string().min(1).max(1000),
  })
  .strict();
export const EditIntentResultSchema = z
  .object({
    edits: z.array(
      z
        .object({
          edit_id: z.string(),
          kind: z.enum([
            "factual_correction",
            "claim_policy_correction",
            "style_preference",
            "provenance_dispute",
          ]),
          citations: z.array(DeterminationCitationSchema).min(1),
          rationale: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export const PostingTriageDecisionSchema = z
  .object({
    listing_id: z.string(),
    verdict: z.enum(["admit", "reject", "uncertain"]),
    reason_code: z.enum([
      "compatible",
      "role_mismatch",
      "seniority_mismatch",
      "location_mismatch",
      "work_model_mismatch",
      "exclusion",
      "insufficient_information",
    ]),
    rationale: z.string().min(1),
    citations: z.array(DeterminationCitationSchema).min(1),
  })
  .strict();
export const PostingTriageResultSchema = z
  .object({ listings: z.array(PostingTriageDecisionSchema).min(1).max(100) })
  .strict();
export const DiscoveryTriageRowSchema = z
  .object({
    preferencesDetermination: DeterminationEnvelopeSchema.nullable(),
    rowId: z.string(),
    targetFingerprint: z.string(),
    listingId: z.string(),
    sourceId: z.string(),
    url: z.string(),
    title: z.string(),
    company: z.string(),
    location: z.string(),
    status: z.enum([
      "pending_triage",
      "literal_excluded",
      "admit",
      "reject",
      "uncertain",
    ]),
    reasonCode: z.string().nullable(),
    failureCode: z.string().nullable(),
    rationale: z.string().nullable(),
    citations: z.array(DeterminationCitationSchema),
    determination: DeterminationEnvelopeSchema.nullable(),
    createdAt: z.string(),
  })
  .strict();
export const DiscoveryTriageResponseSchema = z
  .object({
    ok: z.literal(true),
    rows: z.array(DiscoveryTriageRowSchema),
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
  })
  .strict();
export type DiscoveryTriageResponse = z.infer<
  typeof DiscoveryTriageResponseSchema
>;

export const MessageOutcomeDeterminationSchema = z
  .object({
    kind: z.enum([
      "offer",
      "rejection",
      "interview",
      "assessment",
      "applied_confirmation",
      "recruiter_reply",
      "bounced",
      "unknown",
    ]),
    confidence: z.number().min(0).max(1),
    citations: z.array(DeterminationCitationSchema).min(1).max(12),
    rationale: z.string().min(1).max(1000),
  })
  .strict();

const VerificationFindingSchema = z
  .object({
    kind: z.enum([
      "unsupported_claim",
      "prohibited_claim",
      "voice",
      "self_talk",
      "negotiation_guidance",
      "process_narration",
    ]),
    rationale: z.string().min(1).max(1000),
    citation: DeterminationCitationSchema,
  })
  .strict();
export const ClaimVerificationDeterminationSchema = z
  .object({
    verdict: z.enum(["pass", "fail"]),
    rationale: z.string().min(1).max(1500),
    lines: z
      .array(
        z
          .object({
            line_id: z.string().min(1).max(240),
            verdict: z.enum(["pass", "fail"]),
            served_requirements: z
              .array(
                z
                  .object({
                    requirement_id: z.string().min(1).max(240),
                    citation: DeterminationCitationSchema,
                    rationale: z.string().min(1).max(1000),
                  })
                  .strict(),
              )
              .max(400),
            source_evidence: z.array(DeterminationCitationSchema).max(400),
            claims: z
              .array(
                z
                  .object({
                    kind: z.enum([
                      "candidate_fact",
                      "hypothetical",
                      "target_role",
                      "employer_statement",
                      "advice",
                    ]),
                    support: z.enum([
                      "supported",
                      "unsupported",
                      "not_factual",
                      "uncertain",
                    ]),
                    text: DeterminationCitationSchema,
                    evidence: z.array(DeterminationCitationSchema).max(32),
                    rationale: z.string().min(1).max(1000),
                  })
                  .strict(),
              )
              .max(40),
            findings: z.array(VerificationFindingSchema).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();

export const ArtifactQualityDeterminationSchema = z
  .object({
    evidence_corrections: z.array(DeterminationCitationSchema).max(32),
    verdict: z.enum(["pass", "fail"]),
    score: z.number().min(0).max(1),
    rationale: z.string().min(1).max(1500),
    findings: z
      .array(
        z
          .object({
            line_id: z.string().min(1).max(240),
            category: z.enum([
              "relevance",
              "clarity",
              "completeness",
              "structure",
              "voice",
              "interview_defensibility",
            ]),
            citation: DeterminationCitationSchema,
            rationale: z.string().min(1).max(1500),
            repair_instruction: z.string().min(1).max(1500),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export const SearchPreferencesRequestSchema = z
  .object({
    operation: z.enum(["read", "prepare", "confirm"]),
    expectedProfileVersion: z.number().int().positive(),
    determinationId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.operation === "confirm"
        ? Boolean(value.determinationId)
        : value.determinationId === undefined,
    "Confirmation needs the current proposal ID.",
  );
const PreferenceFieldSchema = <T extends z.ZodType>(value: T) =>
  z
    .object({
      value,
      citations: z.array(DeterminationCitationSchema).min(1),
      rationale: z.string().min(1),
    })
    .strict();
const PlaceSchema = z
  .object({
    country_code: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable(),
    region: RegionCodeSchema,
    locality: z.string().nullable(),
    citations: z.array(DeterminationCitationSchema).min(1),
    rationale: z.string().min(1),
  })
  .strict();
export const SearchPreferencesResultSchema = z
  .object({
    roles: z
      .array(
        z
          .object({
            title: z.string().min(1),
            track: TrackCodeSchema,
            seniority_floor: SeniorityCodeSchema,
            occupation_family: OccupationFamilyCodeSchema,
            citations: z.array(DeterminationCitationSchema).min(1),
            rationale: z.string().min(1),
          })
          .strict(),
      )
      .max(40),
    places: z.array(PlaceSchema).max(40),
    work_models: z.array(PreferenceFieldSchema(WorkModelCodeSchema)).max(8),
    conditions: z
      .array(
        z
          .object({
            category: z.enum([
              "role",
              "seniority",
              "location",
              "work_model",
              "work_authorization",
              "language",
              "qualification",
              "employer_condition",
              "other",
            ]),
            force: z.enum(["required", "excluded", "preferred", "uncertain"]),
            description: z.string().min(1),
            citations: z.array(DeterminationCitationSchema).min(1),
            rationale: z.string().min(1),
          })
          .strict(),
      )
      .max(40),
    rationale: z.string().min(1),
  })
  .strict();
export const SearchPreferencesResponseSchema = z
  .object({
    ok: z.literal(true),
    profileVersion: z.number().int().positive(),
    inputVersion: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["missing", "pending_confirmation", "confirmed"]),
    determination: DeterminationEnvelopeSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.status === "missing") !== (value.determination === null))
      ctx.addIssue({
        code: "custom",
        message: "Preference status requires a recorded determination.",
      });
    if (
      value.determination &&
      (value.determination.kind !== "search_preferences" ||
        value.determination.schema_version !== "1" ||
        value.determination.prompt_version !== "search-preferences-v1" ||
        !SearchPreferencesResultSchema.safeParse(value.determination.result)
          .success)
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid preference determination.",
      });
  });
export type SearchPreferencesRequest = z.infer<
  typeof SearchPreferencesRequestSchema
>;
export type SearchPreferencesResponse = z.infer<
  typeof SearchPreferencesResponseSchema
>;
