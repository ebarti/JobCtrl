import { z } from "zod";
import { DiscoverySettingsResponseSchema, ModelReceiptSchema } from "@jobctrl/contracts";
import type { SourceLocatorListResponse } from "@jobctrl/contracts";

export type LocatorCandidate = SourceLocatorListResponse["candidates"][number] & {
  readonly revision?: number;
  readonly decision?: "pending" | "promote" | "reject" | "reset";
};
export type LocatorList = Omit<SourceLocatorListResponse, "candidates"> & { candidates: LocatorCandidate[] };

export const RoleFeedbackSchema = z.object({ ok: z.literal(true), suggestions: z.array(z.object({
  suggestionId: z.string(), status: z.enum(["pending", "approved", "declined"]),
  ruleKind: z.enum(["exact_title_exclusion", "target_role_review"]), titlePattern: z.string(), titleDisplay: z.string(), reason: z.string(),
  evidence: z.array(z.object({ source_id: z.string(), quote: z.string() }).passthrough()), provenance: ModelReceiptSchema,
  appliedFilter: z.object({ kind: z.literal("exact_title_exclusion"), literal: z.string() }).nullable().optional(),
}).passthrough()) }).passthrough();
export type RoleFeedback = z.infer<typeof RoleFeedbackSchema>;

export const DiscoverySettingsPythonSchema = DiscoverySettingsResponseSchema.extend({
  revision: z.number().int().nonnegative(),
  policyRevision: z.number().int().positive(),
  settings: DiscoverySettingsResponseSchema.shape.settings.passthrough(),
  effectiveSettings: DiscoverySettingsResponseSchema.shape.effectiveSettings.passthrough(),
}).passthrough();

// Preview is a read of saved observations. A stored observation does not imply
// an estimated confidence, so absence remains unknown to the reader.
export const DiscoveryPreviewSchema = z.object({
  ok: z.literal(true), sourceId: z.string(),
  leads: z.array(z.object({
    candidateUrl: z.string(), title: z.string(), company: z.string().nullable(),
    location: z.string().nullable(), estimatedConfidence: z.number().nullable().optional(),
  }).passthrough()),
  generatedAt: z.string().optional(),
}).passthrough();
export type DiscoveryPreview = z.infer<typeof DiscoveryPreviewSchema>;
