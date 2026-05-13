/**
 * Phase 7 / S-25: TypeScript Job + discovery types.
 *
 * The TS types are pure compile-time interfaces, so the runtime tests
 * focus on the validating constructors enforcing their invariants and
 * confirming a fully populated Job is structurally constructable from
 * literal data.
 */

import { describe, it, expect } from "vitest";
import { LOCAL_TENANT } from "../src/tenant.js";
import { generateJobId } from "../src/identifiers.js";
import {
  SEARCH_STRATEGIES,
  SMART_EXTRACT_EXPERIMENTAL_POLICY,
  UNKNOWN_EMPLOYER,
  createSourcePolicy,
  createEmployer,
  createPostingUrl,
  createSource,
  isSearchStrategy,
  isUnknownEmployer,
  validateSourceLocationCandidate,
  type Employer,
  type Job,
  type JobMetadata,
  type PostingUrl,
  type SearchStrategy,
  type Source,
} from "../src/discovery/index.js";

describe("Discovery types", () => {
  it("exposes the canonical SearchStrategy literal range", () => {
    expect(SEARCH_STRATEGIES).toEqual([
      "jobspy",
      "workday_api",
      "smart_extract",
      "manual",
    ]);
  });

  it("createPostingUrl accepts non-empty strings", () => {
    expect(createPostingUrl("https://example.com").value).toBe("https://example.com");
  });

  it.each(["", "   "])("createPostingUrl rejects empty value %p", (value) => {
    expect(() => createPostingUrl(value)).toThrow(/non-empty/);
  });

  it("createSource accepts a non-empty board", () => {
    expect(createSource("greenhouse").board).toBe("greenhouse");
  });

  it("createSource rejects empty boards", () => {
    expect(() => createSource("")).toThrow(/non-empty/);
  });

  it("createEmployer defaults to UNKNOWN sentinel", () => {
    expect(createEmployer().name).toBe(UNKNOWN_EMPLOYER);
    expect(isUnknownEmployer(createEmployer())).toBe(true);
    expect(isUnknownEmployer(createEmployer("Acme"))).toBe(false);
  });

  it("createEmployer rejects empty names", () => {
    expect(() => createEmployer("")).toThrow(/non-empty/);
  });

  it("isSearchStrategy narrows correctly", () => {
    expect(isSearchStrategy("jobspy")).toBe(true);
    expect(isSearchStrategy("workday_api")).toBe(true);
    expect(isSearchStrategy("nope")).toBe(false);
    expect(isSearchStrategy(123)).toBe(false);
  });

  it("a fully specified Job is structurally constructable", () => {
    const postingUrl: PostingUrl = createPostingUrl("https://example.com/jobs/1");
    const source: Source = createSource("greenhouse");
    const employer: Employer = createEmployer("Acme Corp");
    const strategy: SearchStrategy = "jobspy";
    const metadata: JobMetadata = {
      title: "Senior Engineer",
      salary: "$200k",
      description: "",
      location: "Remote",
    };
    const job: Job = {
      tenantId: LOCAL_TENANT,
      jobId: generateJobId(),
      postingUrl,
      source,
      employer,
      searchStrategy: strategy,
      metadata,
      discoveredAt: "2026-05-01T00:00:00+00:00",
      deletedAt: null,
      deleteReason: null,
    };
    expect(job.postingUrl.value).toBe("https://example.com/jobs/1");
    expect(job.source.board).toBe("greenhouse");
    expect(job.employer.name).toBe("Acme Corp");
    expect(job.searchStrategy).toBe("jobspy");
    expect(job.metadata.title).toBe("Senior Engineer");
    expect(job.deletedAt).toBeNull();
  });

  it("a soft-deleted Job carries deletedAt + deleteReason", () => {
    const job: Job = {
      tenantId: LOCAL_TENANT,
      jobId: generateJobId(),
      postingUrl: createPostingUrl("https://x"),
      source: createSource("x"),
      employer: createEmployer("Acme"),
      searchStrategy: "manual",
      metadata: { title: "x", salary: "", description: "", location: "" },
      discoveredAt: "2026-05-01T00:00:00+00:00",
      deletedAt: "2026-05-02T00:00:00+00:00",
      deleteReason: "not interested",
    };
    expect(job.deletedAt).toBe("2026-05-02T00:00:00+00:00");
    expect(job.deleteReason).toBe("not interested");
  });

  it("SourcePolicy keeps third-party bypass disabled", () => {
    expect(SMART_EXTRACT_EXPERIMENTAL_POLICY.policyId).toBe("smart_extract_experimental");
    expect(() =>
      createSourcePolicy({
        ...SMART_EXTRACT_EXPERIMENTAL_POLICY,
        policyId: "bad",
        thirdPartyControlBypass: true as false,
      }),
    ).toThrow(/thirdPartyControlBypass/);
  });

  it("validates locator candidates into promotion, manual review, or rejection", () => {
    const baseCandidate = {
      tenantId: LOCAL_TENANT,
      candidateId: "candidate-1",
      candidateUrl: "https://example.com/careers",
      sourceKind: "employer_careers_page" as const,
      evidence: {
        matchedUrl: "https://example.com/careers",
        pageTitle: "Careers",
        detectedAtsKind: null,
        sourceNativeToken: null,
        employerDomainMatched: true,
        redirectChain: [],
        validationFetchStatus: 200,
      },
      manualActionRequired: null,
      discoveredAt: "2026-05-12T00:00:00Z",
    };
    expect(validateSourceLocationCandidate({ ...baseCandidate, confidence: 0.9 })).toBe("promote");
    expect(validateSourceLocationCandidate({ ...baseCandidate, confidence: 0.5 })).toBe(
      "manual_action_required",
    );
    expect(validateSourceLocationCandidate({ ...baseCandidate, confidence: 0.1 })).toBe("reject");
    expect(
      validateSourceLocationCandidate({
        ...baseCandidate,
        confidence: 0.9,
        evidence: { ...baseCandidate.evidence, employerDomainMatched: false },
      }),
    ).toBe("manual_action_required");
    expect(
      validateSourceLocationCandidate(
        {
          ...baseCandidate,
          confidence: 0.9,
          evidence: { ...baseCandidate.evidence, employerDomainMatched: false },
        },
        {
          userAgent: "JobHunter Source Locator (local)",
          maxRequestsPerDomain: 5,
          minPromotionConfidence: 0.75,
          minManualReviewConfidence: 0.4,
          domainAllowlist: [],
          allowAutonomousBroadDiscovery: true,
        },
      ),
    ).toBe("promote");
  });
});
