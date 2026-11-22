import type { CompensationSourcePolicyUpdateRequest, CompensationSourceRegistryResponse, JobCompensationAudit, JobCompensationAuditMarketEstimate, JobCompensationSummary, MarketCompensationBenchmarkLineage, MarketCompensationDirectBenchmarkInput, MarketCompensationEvidenceRow, MarketCompensationPriceLevelInput } from "@jobctrl/contracts";

/** A persisted Python model receipt; its UUID is not a legacy determination hash. */
export interface CompensationReceipt {
  readonly receipt_id: string;
  readonly provider: string;
  readonly model: string;
  readonly lane: string;
  readonly prompt_version: string;
  readonly input_fingerprint: string;
  readonly created_at: string;
  readonly source_reference: string;
  readonly source_hash: string;
  readonly kind: string;
  readonly entity_id: string;
  readonly result: unknown;
}
export type CompensationEvidenceRow = Omit<MarketCompensationEvidenceRow, "companyScore" | "roleScore" | "levelScore" | "locationScore" | "freshnessScore" | "minimumAmount" | "maximumAmount"> & {
  companyScore: number | null;
  roleScore: number | null;
  levelScore: number | null;
  locationScore: number | null;
  freshnessScore: number | null;
  minimumAmount: number | null;
  maximumAmount: number | null;
  sourceReference?: string;
  sourceDate?: string | null;
  originalPeriod?: string | null;
  originalCurrency?: string | null;
  originalMinimum?: number | null;
  originalMaximum?: number | null;
};
export type CompensationDirectBenchmarkInput = Omit<MarketCompensationDirectBenchmarkInput, "weight" | "confidenceScore" | "asOfDate" | "freshUntil"> & {
  weight: number | null;
  confidenceScore: number | null;
  asOfDate: string | null;
  freshUntil: string | null;
  originalCurrency?: string | null;
  originalPeriod?: string | null;
  originalMinimum?: number | null;
  originalMaximum?: number | null;
  sourceUrl?: string | null;
  attribution?: string | null;
  classificationReceiptId?: string | null;
  providerConversionRate?: number | null;
  providerConversionReference?: string | null;
  rate?: { from_currency: string; to_currency: string; rate: number; as_of: string; source: { reference: string; url: string | null } } | null;
  rateFreshness?: { observed_at: string; fresh_until: string } | null;
};
export type CompensationPriceLevelInput = Omit<MarketCompensationPriceLevelInput, "asOfDate" | "freshUntil"> & {
  asOfDate: string | null;
  freshUntil: string | null;
  sourceUrl?: string | null;
  attribution?: string | null;
};
type ReplaceLineage<T> = T extends unknown ? Omit<T, "directInputs" | "priceLevelInputs" | "asOfDate" | "freshUntil"> & {
  directInputs: CompensationDirectBenchmarkInput[];
  priceLevelInputs: CompensationPriceLevelInput[];
  asOfDate: string | null;
  freshUntil: string | null;
} : never;
export type CompensationBenchmarkLineage = ReplaceLineage<MarketCompensationBenchmarkLineage>;
type ReplaceMarketReceipt<T> = T extends unknown ? Omit<T, "determinations" | "evidence" | "confidenceScore" | "confidenceInterval" | "benchmarkLineage"> & {
  determinations: CompensationReceipt[];
  evidence: CompensationEvidenceRow[];
  confidenceScore: number | null;
  confidenceInterval?: { minimumAmount: number; maximumAmount: number } | null;
  benchmarkLineage: CompensationBenchmarkLineage | null;
} : never;
export type CompensationMarketEstimate = ReplaceMarketReceipt<JobCompensationAuditMarketEstimate>;
type ReplacePostedReceipt<T> = T extends { determination: unknown } ? Omit<T, "determination"> & { determination: CompensationReceipt } : T;
type ReplaceEstimate<T> = T extends { estimate: infer Estimate }
  ? Omit<T, "estimate"> & { estimate: ReplaceMarketReceipt<Estimate> }
  : T;
export type CompensationAudit = Omit<JobCompensationAudit, "posted" | "market"> & {
  posted: ReplacePostedReceipt<JobCompensationAudit["posted"]> & { sourceCurrent?: boolean; sourceRevision?: number | null };
  market: ReplaceEstimate<JobCompensationAudit["market"]> & { sourceCurrent?: boolean; sourceRevision?: number | null; evidenceFresh?: boolean; evidenceFreshUntil?: string | null };
};
export interface CompensationEvidenceResponse {
  readonly summary: JobCompensationSummary | null;
  readonly audit: CompensationAudit | null;
  readonly refresh?: { status: string; failure_code: string | null; updated_at: string } | null;
}
export type CompensationPolicyRegistry = CompensationSourceRegistryResponse & { revision: number };
export type CompensationPolicyUpdate = CompensationSourcePolicyUpdateRequest & { expectedRevision: number };
