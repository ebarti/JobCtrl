import { providerStatusResult, providerModelsResult, providerVerifyResult } from "./provider-fixture.js";
import { describe, expect, it, vi } from "vitest";

import { createEndpointMethods } from "@jobctrl/api-client";
import { ENDPOINTS } from "../src/contracts.js";
import { syntheticInterviewCatalogAsset } from "./interview-fixture.js";

const RECOMMENDATION_ID = `learning-recommendation:${"a".repeat(64)}`;
const REVIEW_ID = `learning-recommendation-review:${"b".repeat(64)}`;

describe("endpoint client factory", () => {
  it("generates the five interview methods from the shared endpoint registry", async () => {
    const catalog = syntheticInterviewCatalogAsset().data as { catalogRevision: string; catalogDigest: string; questions: unknown[] };
    const note = { jobId: "job/one", questionId: "TS09", revision: 1, noteText: "synthetic user statement",
      factualSupport: "unverified_user_statement", editStatus: "user_edited", sourceGeneration: null, bindings: null, updatedAt: "2026-10-02T12:00:00Z" };
    const transport = vi.fn(async (method: string, path: string) => {
      if (path === "/v1/interviews/catalog") return { ok: true, catalog, page: 1, pageSize: 121, total: 2 };
      if (path.startsWith("/v1/interviews/questions/")) return { ok: true, catalogBinding: { catalogRevision: catalog.catalogRevision, catalogDigest: catalog.catalogDigest }, question: catalog.questions[0] };
      if (path.endsWith("interview-prep/history")) return { ok: true, jobId: "job/one", generations: [], page: 1, pageSize: 20, total: 0 };
      return method === "POST" ? { ok: true, note } : { ok: true, jobId: "job/one", notes: [note], page: 1, pageSize: 20, total: 1 };
    });
    const client = createEndpointMethods(transport);
    await client.interviewCatalog({ role: "staff_principal" });
    await client.interviewQuestion("TS09");
    await client.interviewPrepHistory("job/one");
    await client.interviewNotes("job/one", { questionId: "TS09", history: true });
    await client.saveInterviewNote("job/one", { questionId: "TS09", expectedRevision: 0, noteText: "synthetic user statement" });
    expect(transport.mock.calls).toEqual([
      ["GET", "/v1/interviews/catalog", { role: "staff_principal" }],
      ["GET", "/v1/interviews/questions/TS09", undefined],
      ["GET", "/v1/jobs/job%2Fone/interview-prep/history", undefined],
      ["GET", "/v1/jobs/job%2Fone/interview-notes", { questionId: "TS09", history: true }],
      ["POST", "/v1/jobs/job%2Fone/interview-notes", { questionId: "TS09", expectedRevision: 0, noteText: "synthetic user statement" }],
    ]);
  });
  it("derives paths, payload placement, and response parsing from the registry", async () => {
    const transport = vi.fn(async (_method: string, path: string) => {
      if (path === "/v1/learning/recommendations") {
        return {
          ok: true,
          recommendations: [],
          page: 2,
          pageSize: 5,
          total: 0,
          totalPages: 0,
        };
      }
      if (path.endsWith("/reviews")) {
        return {
          ok: true,
          reviewId: REVIEW_ID,
          recommendationId: RECOMMENDATION_ID,
          revision: 1,
          context: "materials",
          policyKind: "tailoring_rule",
          reviewedAt: "2026-08-01T12:34:56.000Z",
          decision: "accepted",
          policyVersion: 2,
        };
      }
      return {
        ok: true,
        context: "materials",
        policyKind: "tailoring_rule",
        version: 3,
        status: "current",
        learnedRules: [],
        sourceReviewId: null,
        sourceRecommendationId: null,
        rollbackOfVersion: 1,
        rollbackReasonCode: "user_requested",
        createdAt: "2026-08-01T12:34:56.000Z",
      };
    });
    const client = createEndpointMethods(transport);

    await client.learningRecommendations({ page: 2, pageSize: 5 });
    await client.reviewLearningRecommendation(RECOMMENDATION_ID, {
      decision: "accepted",
    });
    await client.rollbackTailoringPolicy({ targetVersion: 1 });

    expect(transport.mock.calls).toEqual([
      ["GET", "/v1/learning/recommendations", { page: 2, pageSize: 5 }],
      [
        "POST",
        `/v1/learning/recommendations/${encodeURIComponent(RECOMMENDATION_ID)}/reviews`,
        { decision: "accepted" },
      ],
      ["POST", "/v1/learning/policies/materials/rollbacks", { targetVersion: 1 }],
    ]);
    expect(Object.keys(client).toSorted()).toEqual(
      Object.values(ENDPOINTS)
        .map((endpoint) => endpoint.name)
        .toSorted(),
    );
  });

  it("rejects a response that violates the endpoint response schema", async () => {
    const client = createEndpointMethods(async () => ({ ok: true }));

    await expect(client.rollbackTailoringPolicy({ targetVersion: 1 })).rejects.toThrow();
  });

  it("preserves empty-object bodies for optional write requests", async () => {
    const transport = vi.fn(async (_method: string, path: string) =>
      path === "/v1/outcomes/gmail/scan"
        ? {
            ok: true,
            scannedAnchorCount: 0,
            searchedMessageCount: 0,
            linkedEvidenceCount: 0,
            suggestionsCreatedCount: 0,
            duplicateMessageCount: 0,
            unlinkedCandidateCount: 0,
            evidence: [],
            suggestions: [],
          }
        : {},
    );
    const client = createEndpointMethods(transport);

    await expect(client.renderResumeReviewDraft("draft/one")).rejects.toThrow();
    await client.scanGmailApplicationOutcomes();

    expect(transport.mock.calls).toEqual([
      ["POST", "/v1/resume-review/drafts/draft%2Fone/render", {}],
      ["POST", "/v1/outcomes/gmail/scan", {}],
    ]);
  });
});

const providerCases = [
  ["providerStatus", "GET", "/v1/providers/status", { ok: true, ...providerStatusResult }],
  ["providerModels", "GET", "/v1/providers/models", { ok: true, ...providerModelsResult }],
  ["verifyCodexProvider", "POST", "/v1/providers/codex/verify", { ok: true, verification: providerVerifyResult }],
] as const;

describe("generated provider clients", () => {
  it.each(providerCases)("%s derives transport and validates success", async (name, method, route, response) => {
    const transport = vi.fn(async () => response);
    await expect(createEndpointMethods(transport)[name]()).resolves.toEqual(response);
    expect(transport.mock.calls).toEqual([[method, route, method === "POST" ? {} : undefined]]);
  });

  it.each(providerCases)("%s rejects malformed and private response fields", async (name, _method, _route, response) => {
    for (const invalid of [{ ok: true }, { ...response, privateAccount: "synthetic-private-marker" },
      name === "verifyCodexProvider"
        ? { ...response, verification: { ...providerVerifyResult, status: "unknown" } }
        : { ok: true, providers: [{ ...providerStatusResult.providers[0], token: "synthetic-private-marker" }] }]) {
      await expect(createEndpointMethods(async () => invalid)[name]()).rejects.toThrow();
    }
  });

  it.each(providerCases)("%s propagates transport failures", async (name) => {
    const error = new Error("synthetic transport failure");
    await expect(createEndpointMethods(async () => { throw error; })[name]()).rejects.toBe(error);
  });

  it("retains catalog ordering and unready-provider controls at the client boundary", async () => {
    for (const providers of [providerModelsResult.providers.toReversed(),
      providerModelsResult.providers.map((p, i) => i === 0 ? { ...p, ready: false } : p)]) {
      await expect(createEndpointMethods(async () => ({ ok: true, providers })).providerModels()).rejects.toThrow();
    }
  });
});
