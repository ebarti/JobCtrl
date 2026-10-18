import { z } from "zod";
import { DeterminationCitationSchema } from "./semantic-determinations.js";

const timestamp = z.string().datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const CompanyBriefingConfigSchema = z.object({
  companyId: hash, name: z.string().min(1).max(500), homepageUrl: z.string().url(),
  sourceUrls: z.array(z.string().url()).min(1).max(3), configuredAt: timestamp, revision: z.number().int().positive(),
}).strict();
export const CompanyBriefingLinkSchema = z.object({
  companyId: hash, jobId: z.string().uuid(), employerName: z.string(), confirmedAt: timestamp,
  revision: z.number().int().positive(),
}).strict();
export const CompanyBriefingResultSchema = z.object({
  identity: z.enum(["confirmed", "needs_review"]), identity_reason: z.string().min(1).max(1000),
  identity_citations: z.array(DeterminationCitationSchema).min(1).max(3),
  claims: z.array(z.object({
    kind: z.enum(["company_fact", "reported_event", "hypothesis"]), text: z.string().min(1).max(1500),
    uncertainty: z.string().min(1).max(1000), event_date: z.string().max(100).nullable(),
    citations: z.array(DeterminationCitationSchema).min(1).max(3),
  }).strict()).max(12),
}).strict();
export const CompanyBriefingSourcesSchema = z.array(z.object({ sourceId: hash, url: z.string().url(), finalUrl: z.string().url(),
    observedAt: timestamp, contentHash: hash, text: z.string().min(1).max(12000),
  }).strict()).max(3);
export const AcceptedCompanyBriefingSchema = z.object({
  companyId: hash, configurationId: z.number().int().positive(), observedAt: timestamp, acceptedAt: timestamp,
  promptVersion: z.string(), determinationId: hash, provider: z.string(), model: z.string(),
  sources: CompanyBriefingSourcesSchema.min(1), result: CompanyBriefingResultSchema, revision: z.number().int().positive(),
}).strict();
export const CompanyBriefingAttemptSchema = z.object({
  determinationId: hash.nullable().default(null), sources: CompanyBriefingSourcesSchema.default([]), identityReason: z.string().max(1000).nullable().default(null),
  startedAt: timestamp, finishedAt: timestamp, failureCode: z.string().regex(/^[a-z_]+$/).nullable(),
  revision: z.number().int().positive(),
}).strict();
export interface CompanyBriefingView {
  company: z.output<typeof CompanyBriefingConfigSchema> | null;
  accepted: z.output<typeof AcceptedCompanyBriefingSchema> | null;
  lastAttempt: z.output<typeof CompanyBriefingAttemptSchema> | null;
  staleReasons: string[];
  status: "current" | "stale" | "missing" | "needs_review" | "unavailable";
}
export interface CompanyBriefingSummary {
  companyId: string; name: string; jobId: string; observedAt: string | null;
  status: CompanyBriefingView["status"]; staleReasons: string[]; failureCode: string | null;
}
