import { z } from "zod";

const nullableText = z.string().nullable();
const nullableNumber = z.number().finite().nullable();
const message = z.object({ code: z.string(), message: z.string() }).passthrough();
const receipt = z.object({
  receipt_id: z.string().min(1), provider: z.string(), model: z.string(), lane: z.string(),
  prompt_version: z.string(), input_fingerprint: z.string(), created_at: z.string(),
  source_reference: z.string(), source_hash: z.string(), kind: z.string(), entity_id: z.string(),
  result: z.unknown().refine((value) => value !== undefined),
}).passthrough();
const range = z.object({
  currency: nullableText, period: z.string(), component: z.string(), minimumAmount: nullableNumber,
  maximumAmount: nullableNumber, displayRange: nullableText,
}).passthrough();
const summary = z.object({
  projectionVersion: z.number(), legacyRawSalary: nullableText, warningCount: z.number(),
  posted: z.object({ recordStatus: z.enum(["recorded", "not_recorded", "unavailable"]),
    parseState: nullableText, confidence: z.string(), warningCount: z.number(), range: range.nullable(), displayRange: nullableText }).passthrough(),
  market: z.object({ recordStatus: z.enum(["recorded", "not_requested", "unavailable"]), estimateState: z.string(),
    confidenceBand: z.string(), confidenceScore: nullableNumber, sourceCount: z.number(), sampleCount: nullableNumber,
    warningCount: z.number(), benchmarkKind: nullableText, range: range.nullable(), displayRange: nullableText,
    confidenceInterval: range.nullable(), displayConfidenceInterval: nullableText }).passthrough(),
}).passthrough();
const postedFact = z.object({
  parseState: z.enum(["missing", "unparseable", "ambiguous", "parsed_range"]),
  sourceField: z.string(), sourceText: nullableText, parsedAt: z.string(), confidence: z.string(), warnings: z.array(message),
}).passthrough().superRefine((fact, context) => {
  if (fact.parseState === "parsed_range") {
    const parsed = z.object({ currency: nullableText, period: z.string(), component: z.string(),
      minimumAmount: nullableNumber, maximumAmount: nullableNumber }).safeParse(fact);
    if (!parsed.success) context.addIssue({ code: "custom", message: "Invalid posted range" });
  }
});
const source = z.object({ sourceId: z.string(), displayName: z.string(), snapshotVersion: z.string(),
  aggregateBucket: nullableText, geographyScope: nullableText, releaseYear: nullableNumber,
  sampleCount: nullableNumber, attribution: z.string() }).passthrough();
const evidence = z.object({ sourceId: z.string(), displayName: z.string(), determinationId: nullableText,
  companyName: z.string(), roleTitle: z.string(), location: nullableText, levelLabel: nullableText,
  companyTier: z.string(), component: z.string(), currency: z.string(), period: z.string(),
  minimumAmount: nullableNumber, maximumAmount: nullableNumber, sampleCount: nullableNumber, releaseYear: nullableNumber,
  companyScore: nullableNumber, roleScore: nullableNumber, levelScore: nullableNumber,
  locationScore: nullableNumber, freshnessScore: nullableNumber }).passthrough();
const factor = z.object({ name: z.string(), score: z.number(), band: z.string(), reason: z.string() }).passthrough();
const estimate = z.object({ estimateState: z.enum(["unsupported", "source_unavailable", "insufficient_evidence", "estimated_range"]),
  confidenceBand: z.string(), confidenceScore: nullableNumber, sourceCount: z.number(), sampleCount: nullableNumber,
  aggregateBucket: nullableText, geographyScope: nullableText, seniorityLabel: nullableText, companyName: nullableText,
  roleTitle: nullableText, matchScope: z.string(), sources: z.array(source), factors: z.array(factor), evidence: z.array(evidence),
  warnings: z.array(message), determinations: z.array(receipt), estimatorVersion: z.string(), estimatedAt: z.string(),
  benchmarkLineage: z.unknown(),
}).passthrough().superRefine((value, context) => {
  const extra = value.estimateState === "estimated_range"
    ? z.object({ currency: z.string(), period: z.string(), component: z.string(), minimumAmount: z.number(), maximumAmount: z.number() })
    : z.object({ [value.estimateState === "unsupported" ? "unsupportedReasons" : value.estimateState === "source_unavailable" ? "sourceUnavailableReasons" : "insufficientReasons"]: z.array(message) });
  if (!extra.safeParse(value).success) context.addIssue({ code: "custom", message: "Invalid market evidence" });
});
export const postedEvidenceRead = z.discriminatedUnion("recordStatus", [
  z.object({ recordStatus: z.literal("recorded"), fact: postedFact, determination: receipt }).passthrough(),
  z.object({ recordStatus: z.literal("not_recorded") }).passthrough(),
  z.object({ recordStatus: z.literal("unavailable"), failureCode: z.string() }).passthrough(),
]);
export const marketEvidenceRead = z.discriminatedUnion("recordStatus", [
  z.object({ recordStatus: z.literal("recorded"), estimate }).passthrough(),
  z.object({ recordStatus: z.literal("not_requested") }).passthrough(),
  z.object({ recordStatus: z.literal("unavailable"), failureCode: z.string() }).passthrough(),
]);
export const compensationEvidenceEnvelope = z.object({
  summary: summary.nullable(), audit: z.object({ projectionVersion: z.number(), posted: postedEvidenceRead, market: marketEvidenceRead }).passthrough().nullable(),
  refresh: z.object({ status: z.string(), failure_code: nullableText, updated_at: z.string() }).passthrough().nullable().optional(),
}).passthrough();

const control = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), enabled: z.boolean() }).passthrough(),
  z.object({ kind: z.literal("user_preference"), enabled: z.boolean(), accessMode: nullableText,
    allowedAccessModes: z.array(z.string()), europeCoverageRequired: z.boolean(), europeCoverageConfirmed: z.boolean() }).passthrough(),
]);
export const compensationPolicyEnvelope = z.object({ ok: z.literal(true), revision: z.number().int().nonnegative().safe(),
  sources: z.array(z.object({ sourceId: z.string(), displayName: z.string(), sourceType: z.string(), accessMode: z.string(),
    availability: z.string(), licenseStatus: z.string(), termsUrl: nullableText, sourceUrl: nullableText, freshnessPolicy: z.string(),
    attributionRequirement: z.string(), supportedFields: z.array(z.string()), disabledReason: nullableText, configured: z.boolean(), control,
    coverage: z.object({ geography: z.string(), regions: z.array(z.string()), notes: z.string() }).passthrough(), notes: z.array(z.string()) }).passthrough()),
}).passthrough();
