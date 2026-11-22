import { z } from "zod";
import taxonomy from "./semantic-taxonomy.v1.json" with { type: "json" };

export const SEMANTIC_TAXONOMY = taxonomy;

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
    reasoning_effort: z.string().min(1).max(40).nullable().optional(),
    instruction_profile: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
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
