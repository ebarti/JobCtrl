/**
 * Phase 7 / S-26: TypeScript JobEnrichment + enrichment value objects.
 */

import { describe, it, expect } from "vitest";
import { LOCAL_TENANT } from "../src/tenant.js";
import { generateJobId } from "../src/identifiers.js";
import {
  ATTEMPT_STATUSES,
  ENRICHMENT_LIFECYCLE,
  EXTRACTION_TIERS,
  createApplicationUrl,
  createFullDescription,
  isExtractionTier,
  type ApplicationUrl,
  type AttemptStatus,
  type DetailPage,
  type EnrichmentAttempt,
  type EnrichmentError,
  type EnrichmentLifecycle,
  type ExtractionTier,
  type FullDescription,
  type JobEnrichment,
} from "../src/enrichment/index.js";

describe("Enrichment types", () => {
  it("ExtractionTier has the §4.2 literal range", () => {
    expect(EXTRACTION_TIERS).toEqual(["json_ld", "css_selectors", "llm_assisted"]);
  });

  it("EnrichmentLifecycle covers the four states", () => {
    expect(ENRICHMENT_LIFECYCLE).toEqual(["pending", "running", "enriched", "failed"]);
  });

  it("AttemptStatus covers the three terminal states", () => {
    expect(ATTEMPT_STATUSES).toEqual(["running", "succeeded", "failed"]);
  });

  it("createFullDescription rejects empty strings", () => {
    expect(createFullDescription("hi").text).toBe("hi");
    expect(() => createFullDescription("")).toThrow(/non-empty/);
  });

  it("createApplicationUrl rejects empty strings", () => {
    expect(createApplicationUrl("https://x").value).toBe("https://x");
    expect(() => createApplicationUrl("")).toThrow(/non-empty/);
  });

  it("isExtractionTier narrows correctly", () => {
    expect(isExtractionTier("json_ld")).toBe(true);
    expect(isExtractionTier("nope")).toBe(false);
  });

  it("a fully specified JobEnrichment is structurally constructable", () => {
    const description: FullDescription = createFullDescription("desc");
    const apply: ApplicationUrl = createApplicationUrl("https://apply");
    const tier: ExtractionTier = "json_ld";
    const status: EnrichmentLifecycle = "enriched";
    const attempt: EnrichmentAttempt = {
      attemptNumber: 1,
      extractionTier: "json_ld",
      status: "succeeded" satisfies AttemptStatus,
      startedAt: "2026-05-01T00:00:00+00:00",
      finishedAt: "2026-05-01T00:00:01+00:00",
      error: null,
    };
    const enrichment: JobEnrichment = {
      tenantId: LOCAL_TENANT,
      jobId: generateJobId(),
      currentStatus: status,
      attempts: [attempt],
      fullDescription: description,
      applicationUrl: apply,
      enrichedAt: "2026-05-01T00:00:01+00:00",
      extractionTier: tier,
      updatedAt: "2026-05-01T00:00:01+00:00",
    };
    expect(enrichment.attempts.length).toBe(1);
    expect(enrichment.fullDescription?.text).toBe("desc");
    expect(enrichment.extractionTier).toBe("json_ld");
  });

  it("an empty JobEnrichment carries an empty attempts list", () => {
    const enrichment: JobEnrichment = {
      tenantId: LOCAL_TENANT,
      jobId: generateJobId(),
      currentStatus: "pending",
      attempts: [],
      fullDescription: null,
      applicationUrl: null,
      enrichedAt: null,
      extractionTier: null,
      updatedAt: "2026-05-01T00:00:00+00:00",
    };
    expect(enrichment.currentStatus).toBe("pending");
    expect(enrichment.attempts).toEqual([]);
  });

  it("a failed attempt carries an EnrichmentError", () => {
    const error: EnrichmentError = {
      code: "HTTP_404",
      message: "Not found",
      retryable: false,
    };
    const attempt: EnrichmentAttempt = {
      attemptNumber: 1,
      extractionTier: "css_selectors",
      status: "failed",
      startedAt: "t0",
      finishedAt: "t1",
      error,
    };
    expect(attempt.error?.code).toBe("HTTP_404");
  });

  it("DetailPage is structurally constructable", () => {
    const page: DetailPage = {
      url: "https://x",
      finalUrl: "https://x/final",
      pageTitle: "Title",
      html: "<p>hi</p>",
      jsonLd: [{ "@type": "JobPosting" }],
      status: 200,
      fetchedAt: "2026-05-01T00:00:00+00:00",
    };
    expect(page.status).toBe(200);
    expect(page.jsonLd.length).toBe(1);
  });
});
