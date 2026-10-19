import { z } from "zod";
import { IsoTimestampSchema } from "./schemas.js";

/** These facts are explicitly attested by the user, never extracted by a heuristic. */
export const OfferSourceSchema = z
  .object({
    reference: z.string().trim().min(1).max(1000),
    quote: z
      .string()
      .min(1)
      .max(8000)
      .refine(
        (value) => value.trim().length > 0,
        "A nonempty verbatim source quote is required.",
      ),
    capturedAt: IsoTimestampSchema,
    userConfirmed: z.literal(true),
  })
  .strict();
const SourcedTextSchema = z
  .object({
    value: z.string().trim().min(1).max(4000),
    source: OfferSourceSchema,
  })
  .strict();
export const OFFER_CASH_COMPONENTS = [
  "base_salary",
  "bonus",
  "signing_bonus",
  "commission",
  "other",
] as const;
export const OFFER_PERIODS = [
  "year",
  "month",
  "week",
  "hour",
  "one_off",
  "unknown",
] as const;
export const OfferTermsSchema = z
  .object({
    source: OfferSourceSchema,
    cash: z
      .array(
        z
          .object({
            component: z.enum(OFFER_CASH_COMPONENTS),
            amount: z.number().finite().nonnegative().max(1e12),
            currency: z
              .string()
              .regex(/^[A-Z]{3}$/)
              .nullable(),
            period: z.enum(OFFER_PERIODS),
            source: OfferSourceSchema,
          })
          .strict(),
      )
      .max(20),
    equity: SourcedTextSchema.nullable(),
    benefits: SourcedTextSchema.nullable(),
    decisionDeadline: z
      .object({ value: IsoTimestampSchema, source: OfferSourceSchema })
      .strict()
      .nullable(),
  })
  .strict();
export const SaveOfferTermsSchema = z
  .object({
    expectedRevisionId: z.uuid().nullable(),
    terms: OfferTermsSchema,
    correctionReason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
export const RecordOfferDecisionSchema = z
  .object({
    expectedDecisionId: z.uuid().nullable(),
    termsRevisionId: z.uuid(),
    decision: z.enum(["accepted", "declined"]),
    occurredAt: IsoTimestampSchema,
    source: OfferSourceSchema,
    correctionReason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
export const OfferTermsRevisionSchema = SaveOfferTermsSchema.extend({
  revisionId: z.uuid(),
  recordedAt: IsoTimestampSchema,
});
export const OfferDecisionSchema = RecordOfferDecisionSchema.extend({
  decisionId: z.uuid(),
  recordedAt: IsoTimestampSchema,
});
export const OfferReadResponseSchema = z.object({
  ok: z.literal(true),
  jobId: z.uuid(),
  termsHistory: z.array(OfferTermsRevisionSchema),
  decisions: z.array(OfferDecisionSchema),
  currentTerms: OfferTermsRevisionSchema.nullable(),
  currentDecision: OfferDecisionSchema.nullable(),
});
export type OfferSource = z.infer<typeof OfferSourceSchema>;
export type OfferTerms = z.infer<typeof OfferTermsSchema>;
export type SaveOfferTerms = z.infer<typeof SaveOfferTermsSchema>;
export type RecordOfferDecision = z.infer<typeof RecordOfferDecisionSchema>;
export type OfferTermsRevision = z.infer<typeof OfferTermsRevisionSchema>;
export type OfferDecision = z.infer<typeof OfferDecisionSchema>;
export type OfferReadResponse = z.infer<typeof OfferReadResponseSchema>;
