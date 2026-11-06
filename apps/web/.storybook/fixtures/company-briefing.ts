import type { CompanyBriefingView } from "@jobctrl/contracts";

// Explicit synthetic model decision used only for rendering, not judgment grading.
export const sampleCompanyBriefing: CompanyBriefingView = {
  company: { companyId: "a".repeat(64), name: "Example Company", homepageUrl: "https://example.com/", sourceUrls: ["https://example.com/about"], configuredAt: "2026-01-01T12:00:00Z", revision: 1 },
  accepted: { companyId: "a".repeat(64), configurationId: 1, observedAt: "2026-01-01T12:00:00Z", acceptedAt: "2026-01-01T12:00:00Z", promptVersion: "company-briefing-v1", determinationId: "b".repeat(64), provider: "synthetic", model: "synthetic", revision: 3,
    sources: [{ sourceId: "c".repeat(64), url: "https://example.com/about", finalUrl: "https://example.com/about", contentHash: "d".repeat(64), text: "Example public source.", observedAt: "2026-01-01T12:00:00Z" }],
    result: { identity: "confirmed", identity_reason: "Synthetic identity determination", identity_citations: [{ source_id: "c".repeat(64), quote: "Example public source.", exact_values: [] }], claims: [{ kind: "hypothesis", text: "Synthetic company hypothesis", uncertainty: "One source; this is not established fact.", event_date: null, citations: [{ source_id: "c".repeat(64), quote: "Example public source.", exact_values: [] }] }] } },
  lastAttempt: { determinationId: null, sources: [], identityReason: null, startedAt: "2026-02-01T12:00:00Z", finishedAt: "2026-02-01T12:00:00Z", failureCode: "provider_error", revision: 4 },
  staleReasons: ["sources_older_than_seven_days"], status: "stale",
};
