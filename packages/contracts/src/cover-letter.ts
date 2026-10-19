import { z } from "zod";

export const COVER_LETTER_RENDERER_VERSION = "playwright-cover-letter-v2";
export const CoverLetterSettingsSchema = z.object({
  paper: z.enum(["Letter", "A4"]),
  fontFamily: z.enum(["georgia", "times", "arial"]),
  fontSizePt: z.number().finite().min(9).max(14),
  marginMm: z.number().finite().min(8).max(28),
  lineHeight: z.number().finite().min(1).max(2),
  paragraphSpacingPx: z.number().finite().min(0).max(24),
}).strict();
export type CoverLetterSettings = z.infer<typeof CoverLetterSettingsSchema>;
export const DEFAULT_COVER_LETTER_SETTINGS: CoverLetterSettings = {
  paper: "Letter", fontFamily: "georgia", fontSizePt: 11,
  marginMm: 17.78, lineHeight: 1.6, paragraphSpacingPx: 14,
};
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const CoverLetterSourceSchema = z.object({
  tenantId: z.string(), jobId: z.string(), artifactId: z.string(),
  generation: z.number().int().nonnegative(), textSha256: hash,
}).strict();
export const CoverLetterAcceptedSchema = z.object({
  source: CoverLetterSourceSchema,
  acceptedVersion: hash,
  pdfArtifactId: z.string().nullable(),
  pdfSha256: hash.nullable(),
  pdfSourceCurrent: z.boolean(),
  settings: CoverLetterSettingsSchema,
  rendererVersion: z.string().nullable(),
}).strict();
export type CoverLetterAccepted = z.infer<typeof CoverLetterAcceptedSchema>;
export const CoverLetterRenderRequestSchema = z.object({
  source: CoverLetterSourceSchema, expectedAcceptedVersion: hash,
  settings: CoverLetterSettingsSchema,
}).strict();
export type CoverLetterRenderRequest = z.infer<typeof CoverLetterRenderRequestSchema>;
export const CoverLetterPreviewSchema = z.object({
  previewId: z.uuid(), source: CoverLetterSourceSchema,
  expectedAcceptedVersion: hash, settings: CoverLetterSettingsSchema,
  rendererVersion: z.literal(COVER_LETTER_RENDERER_VERSION), pdfSha256: hash,
}).strict();
export type CoverLetterPreview = z.infer<typeof CoverLetterPreviewSchema>;
export const CoverLetterRenderResponseSchema = z.object({ ok: z.literal(true), preview: CoverLetterPreviewSchema }).strict();
export const CoverLetterSaveRequestSchema = z.object({
  previewId: z.uuid(), expectedAcceptedVersion: hash,
}).strict();
export const CoverLetterSaveResponseSchema = z.object({ ok: z.literal(true), accepted: CoverLetterAcceptedSchema }).strict();
