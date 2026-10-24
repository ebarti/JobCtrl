// @vitest-environment node

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JobCtrlApiClient } from "@jobctrl/api-client";
import { ENDPOINTS } from "@jobctrl/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ApiClientPort } from "../shared/ports/ApiClientPort.js";
import { DEMO_ARTIFACTS } from "./artifacts.js";
import { DEMO_CAPABILITY_MANIFEST } from "./capabilities.js";
import { materializeDemoSeed } from "./clock.js";
import { demoSeedDigest } from "./digest.js";
import { assertDemoSeedInvariants } from "./invariants.js";
import { scanDemoPrivacy } from "./privacy.js";
import { DEMO_SEED } from "./seed.js";
import { DEMO_CAPABILITY_CLASSES, type DemoSeedValue } from "./contracts.js";

const CLOCK = { anchor: "2031-01-02T03:04:05.000Z" } as const;
const CONTOSO_JOB_KEY = "job-contoso-reliability";
const CONTOSO_GENERATION_ONE_ARTIFACT_IDS = [
  "artifact-contoso-resume-g1",
  "artifact-contoso-resume-pdf-g1",
] as const;

// The shared client also exposes configuration and legacy methods outside this
// browser port. A changed port/client boundary must update this exact typed set.
const CLIENT_ONLY_MEMBERS = {
  baseUrl: true,
  scoringKeywords: true,
  reviewResumeFeedbackSignal: true,
} satisfies Record<Exclude<keyof JobCtrlApiClient, keyof ApiClientPort>, true>;

function expectCompleteClassifiedManifest(
  manifest: Readonly<
    Record<string, { readonly class: string; readonly reason: string }>
  >,
) {
  const client = new JobCtrlApiClient();
  // TS-private transport helpers remain prototype methods at runtime.
  const internalMembers = new Set([
    "constructor",
    "get",
    "post",
    "patch",
    "delete",
    "request",
    ...Object.keys(CLIENT_ONLY_MEMBERS),
  ]);
  const methods = new Set(
    [
      ...Object.getOwnPropertyNames(JobCtrlApiClient.prototype),
      ...Object.keys(client),
    ].filter(
      (name) =>
        !internalMembers.has(name) &&
        typeof Reflect.get(client, name) === "function",
    ),
  );
  expect(Object.keys(manifest).toSorted()).toEqual([...methods].toSorted());
  for (const [method, capability] of Object.entries(manifest)) {
    expect(DEMO_CAPABILITY_CLASSES, method).toContain(capability.class);
    expect(capability.reason.trim(), method).not.toBe("");
  }
  for (const endpoint of Object.values(ENDPOINTS)) {
    expect(manifest[endpoint.name]?.class, endpoint.name).toBe(
      endpoint.demo.class,
    );
  }
}

describe("canonical public demo seed", () => {
  it("has a complete classified API capability manifest", () => {
    expectTypeOf<keyof typeof DEMO_CAPABILITY_MANIFEST>().toEqualTypeOf<
      keyof ApiClientPort
    >();
    expectCompleteClassifiedManifest(DEMO_CAPABILITY_MANIFEST);
  });

  it("keeps cover-letter rendering unavailable and existing review classifications intact", () => {
    for (const method of ["renderCoverLetterPreview", "acceptCoverLetterPreview", "coverLetterPreviewPdfUrl"] as const) {
      expect(DEMO_CAPABILITY_MANIFEST[method]).toMatchObject({ class: "unavailable" });
    }
    expect(DEMO_CAPABILITY_MANIFEST.applyReviewQueue.class).toBe("browser_local");
    expect(DEMO_CAPABILITY_MANIFEST.openArtifact.class).toBe("rehearsed_external");
  });

  it.each(["health", "careerLearning", "writeCareerLearning"])(
    "rejects a missing public capability: %s",
    (method) => {
      const incomplete: Record<string, { class: string; reason: string }> = {
        ...DEMO_CAPABILITY_MANIFEST,
      };
      delete incomplete[method];
      expect(() => expectCompleteClassifiedManifest(incomplete)).toThrow();
    },
  );

  it("rejects extra capabilities, unknown classes and blank explanations", () => {
    expect(() =>
      expectCompleteClassifiedManifest({
        ...DEMO_CAPABILITY_MANIFEST,
        unregisteredOperation: {
          class: "browser_local",
          reason: "Unregistered",
        },
      }),
    ).toThrow();
    expect(() =>
      expectCompleteClassifiedManifest({
        ...DEMO_CAPABILITY_MANIFEST,
        health: { class: "unclassified", reason: "Invalid class" },
      }),
    ).toThrow();
    expect(() =>
      expectCompleteClassifiedManifest({
        ...DEMO_CAPABILITY_MANIFEST,
        health: { class: "browser_local", reason: " " },
      }),
    ).toThrow();
  });

  it("rejects a registered endpoint with the wrong supported capability class", () => {
    expect(() =>
      expectCompleteClassifiedManifest({
        ...DEMO_CAPABILITY_MANIFEST,
        careerLearning: {
          class: "browser_local",
          reason: "Incorrect offline support",
        },
      }),
    ).toThrow();
  });

  it("keeps private offer and compensation capabilities unavailable", () => {
    for (const capability of ["jobOffer", "saveOfferTerms", "recordOfferDecision", "postedCompensationFact", "marketCompensationEstimate"] as const) {
      expect(DEMO_CAPABILITY_MANIFEST[capability].class, capability).toBe("unavailable");
    }
  });

  it("is deterministic, immutable by type, and covers the required lifecycle arms", () => {
    expect(() => assertDemoSeedInvariants(DEMO_SEED)).not.toThrow();
    expect(demoSeedDigest(DEMO_SEED)).toBe("fnv1a-28df099a");
    expect(demoSeedDigest({ b: 2, a: ["seed", true] })).toBe(demoSeedDigest({ a: ["seed", true], b: 2 }));
  });

  it("includes contact edit publication bases in the full seed integrity digest", () => {
    const changed = structuredClone(DEMO_SEED) as DemoSeedValue;
    const contact = changed.readModel.contacts.details["contact-demo-hiring-partner"]!.contact;
    contact.fingerprint = "e".repeat(64);

    expect(demoSeedDigest(changed)).not.toBe(demoSeedDigest(DEMO_SEED));
  });

  it("has non-empty server-shaped route data and normalized detail maps", () => {
    const model = DEMO_SEED.readModel;
    expect(model.dashboard.summary.activity).not.toHaveLength(0);
    expect(model.jobs.list.items).not.toHaveLength(0);
    expect(Object.keys(model.jobs.details)).not.toHaveLength(0);
    expect(model.discovery.sources.sources).not.toHaveLength(0);
    expect(model.discovery.quarantine.entries).not.toHaveLength(0);
    expect(model.discovery.manualCapture.items).not.toHaveLength(0);
    expect(model.evidence.entries).not.toHaveLength(0);
    expect(model.materials.list.items).not.toHaveLength(0);
    expect(Object.keys(model.materials.details)).not.toHaveLength(0);
    expect(model.materials.resumeTemplates.templates).not.toHaveLength(0);
    expect(model.apply.queue.items).not.toHaveLength(0);
    expect(model.runs.list.items).not.toHaveLength(0);
    expect(Object.keys(model.runs.details)).not.toHaveLength(0);
    expect(new Set(model.analytics.outcomes.outcomes.map((outcome) => outcome.kind))).toEqual(
      new Set(["interview", "rejection", "offer"]),
    );
    expect(model.contacts.list.items).not.toHaveLength(0);
    expect(model.outreach.thread.thread?.drafts).not.toHaveLength(0);
    expect(model.outreach.dueFollowUps.followUps).not.toHaveLength(0);
  });

  it("keeps Contoso generation-one materials accepted, previewable, and blocked from apply", () => {
    const model = DEMO_SEED.readModel;
    const contoso = model.jobs.list.items.find((item) => item.jobKey === CONTOSO_JOB_KEY);
    const detail = model.jobs.details[CONTOSO_JOB_KEY];
    const artifacts = model.materials.list.items.filter((item) => item.jobKey === CONTOSO_JOB_KEY);
    const allowedAssetUrls: ReadonlySet<string> = new Set(
      Object.values(DEMO_ARTIFACTS).map((asset) => asset.url),
    );

    expect(contoso).toMatchObject({
      artifactCount: 2,
      currentStage: "tailor",
      currentState: "blocked",
      errorCode: "demo_missing_requirement",
    });
    expect(detail?.job.artifactCount).toBe(2);
    expect(detail?.artifacts.map((artifact) => artifact.artifactId)).toEqual(
      CONTOSO_GENERATION_ONE_ARTIFACT_IDS,
    );
    expect(artifacts.map((artifact) => artifact.artifactId)).toEqual(
      CONTOSO_GENERATION_ONE_ARTIFACT_IDS,
    );
    expect(artifacts.every((artifact) => artifact.status === "accepted")).toBe(true);
    expect(artifacts.every((artifact) => allowedAssetUrls.has(artifact.localPath))).toBe(true);
    expect(artifacts.every((artifact) => !artifact.localPath.includes("://"))).toBe(true);
    for (const artifact of artifacts) {
      expect(model.materials.details[artifact.artifactId]?.artifact).toEqual(artifact);
    }

    expect(detail?.applyAudit.state).toBe("blocked");
    expect(detail?.applyAudit.hardBlockers).toContainEqual(
      expect.objectContaining({ code: "missing_requirement", severity: "blocking" }),
    );
    expect(detail?.applyAudit.sources).toEqual([
      expect.objectContaining({ kind: "materials.resume", status: "present" }),
      expect.objectContaining({ kind: "materials.resume_pdf", status: "present" }),
    ]);
    expect(model.apply.queue.items.some((item) => item.jobKey === CONTOSO_JOB_KEY)).toBe(false);
    expect(scanDemoPrivacy(JSON.stringify({ contoso, artifacts }))).toEqual([]);
  });

  it("materializes reset truth with the same accepted Contoso generation-one references", () => {
    const resetSeed = materializeDemoSeed(DEMO_SEED, CLOCK).readModel;
    const contoso = resetSeed.jobs.list.items.find((item) => item.jobKey === CONTOSO_JOB_KEY);
    const artifacts = resetSeed.materials.list.items.filter((item) => item.jobKey === CONTOSO_JOB_KEY);

    expect(contoso).toMatchObject({ artifactCount: 2, currentStage: "tailor", currentState: "blocked" });
    expect(artifacts.map((artifact) => [artifact.artifactId, artifact.status])).toEqual([
      ["artifact-contoso-resume-g1", "accepted"],
      ["artifact-contoso-resume-pdf-g1", "accepted"],
    ]);
    expect(resetSeed.jobs.details[CONTOSO_JOB_KEY]?.artifacts).toEqual(artifacts);
  });

  it("keeps the failed Fabrikam rescore inspectable and aligned across dashboard, list, and detail", () => {
    const model = DEMO_SEED.readModel;
    const fabrikam = DEMO_SEED.readModel.jobs.details["job-fabrikam-systems"];
    const failedJobs = model.jobs.list.items.filter(
      (item) =>
        item.deletedAt === null &&
        item.hiddenAt === null &&
        item.currentState === "failed",
    );

    expect(model.dashboard.summary.totals.failures).toBe(failedJobs.length);
    expect(failedJobs.map((item) => item.jobKey)).toEqual([
      "job-fabrikam-systems",
    ]);
    expect(fabrikam?.job).toMatchObject({
      currentStage: "score",
      currentSubstage: "score",
      currentState: "failed",
      errorCode: "demo_rescore_gate",
    });
    expect(fabrikam?.stages).toContainEqual(
      expect.objectContaining({
        stage: "score",
        state: "failed",
        errorCode: "demo_rescore_gate",
        retryable: true,
      }),
    );
  });

  it("rejects a dashboard failure total that cannot be opened through the Failures KPI", () => {
    const mismatched = structuredClone(DEMO_SEED) as unknown as {
      readModel: { dashboard: { summary: { totals: { failures: number } } } };
    };
    mismatched.readModel.dashboard.summary.totals.failures += 1;

    expect(() =>
      assertDemoSeedInvariants(mismatched as unknown as typeof DEMO_SEED),
    ).toThrow(
      "dashboard failure total must match the failed jobs KPI query",
    );
  });

  it("materializes every seed timestamp from one injected reference anchor", () => {
    const materialized = materializeDemoSeed(DEMO_SEED, CLOCK);
    expect(materialized.schemaVersion).toBe(DEMO_SEED.schemaVersion);
    expect(materialized.title).toBe(DEMO_SEED.title);
    expect(materialized.artifacts).toEqual(DEMO_SEED.artifacts);
    expect(materialized.generatedAt).toBe(CLOCK.anchor);
    expect(materialized.readModel.dashboard.summary.generatedAt).toBe(CLOCK.anchor);
    expect(materialized.readModel.jobs.list.items[0]?.discoveredAt).toBe("2030-12-30T03:04:05.000Z");
    expect(materialized.routeData.dashboard[0]?.at).toBe("2031-01-02T02:46:05.000Z");
    expect(JSON.stringify(materialized)).not.toContain("demo-time:");
    expect(materializeDemoSeed(DEMO_SEED, CLOCK)).toEqual(materialized);
  });

  it("has a simulated no-effect receipt for every external-effect class", () => {
    expect(new Set(DEMO_SEED.receipts.map((receipt) => receipt.kind))).toEqual(
      new Set(["application", "outreach", "discovery", "llm", "os_open"]),
    );
    expect(DEMO_SEED.receipts.every((receipt) => receipt.simulated && !receipt.externalEffectOccurred)).toBe(true);
  });

  it("rejects an authored profile that only passes because the API wire type is unknown", () => {
    const malformed = structuredClone(DEMO_SEED) as {
      readModel: { profile: { config: { profile: unknown } } };
    };
    malformed.readModel.profile.config.profile = {
      resume: { experience_entries: [] },
    };

    expect(() => assertDemoSeedInvariants(malformed as typeof DEMO_SEED)).toThrow();
  });

  it("rejects malformed server envelopes and incomplete direct-link graphs", () => {
    const malformedList = structuredClone(DEMO_SEED) as {
      readModel: { jobs: { list: { ok: boolean } } };
    };
    malformedList.readModel.jobs.list.ok = false;
    expect(() => assertDemoSeedInvariants(malformedList as typeof DEMO_SEED)).toThrow(
      "jobs list must be a successful server envelope",
    );

    const missingTotals = structuredClone(DEMO_SEED) as {
      readModel: { dashboard: { summary: { totals: Record<string, unknown> } } };
    };
    delete missingTotals.readModel.dashboard.summary.totals.jobs;
    expect(() => assertDemoSeedInvariants(missingTotals as typeof DEMO_SEED)).toThrow(
      "dashboard totals must include a numeric job count",
    );

    const missingRunDetail = structuredClone(DEMO_SEED) as {
      readModel: { runs: { details: Record<string, unknown> } };
    };
    delete missingRunDetail.readModel.runs.details["run-materials-progress"];
    expect(() => assertDemoSeedInvariants(missingRunDetail as typeof DEMO_SEED)).toThrow(
      "run-materials-progress is missing its direct-link detail",
    );

    const missingPreview = structuredClone(DEMO_SEED) as { artifacts: Record<string, unknown> };
    delete missingPreview.artifacts.sourcePreview;
    expect(() => assertDemoSeedInvariants(missingPreview as typeof DEMO_SEED)).toThrow(
      "references a missing bundled preview asset",
    );

    const missingSourcePreview = structuredClone(DEMO_SEED) as {
      readModel: { discovery: { sourcePreviews: Record<string, unknown> } };
    };
    delete missingSourcePreview.readModel.discovery.sourcePreviews["demo-source:review"];
    expect(() => assertDemoSeedInvariants(missingSourcePreview as typeof DEMO_SEED)).toThrow(
      "source demo-source:review is missing its direct-link preview",
    );

    const danglingSourceRun = structuredClone(DEMO_SEED) as unknown as {
      readModel: { discovery: { sources: { sources: Array<{ lastRunId: string | null }> } } };
    };
    danglingSourceRun.readModel.discovery.sources.sources[0]!.lastRunId = "run-missing";
    expect(() => assertDemoSeedInvariants(danglingSourceRun as unknown as typeof DEMO_SEED)).toThrow(
      "source demo-source:northwind workflow run run-missing is missing its direct-link detail",
    );

    const missingContosoArtifact = structuredClone(DEMO_SEED) as unknown as {
      readModel: { materials: { details: Record<string, unknown> } };
    };
    delete missingContosoArtifact.readModel.materials.details["artifact-contoso-resume-g1"];
    expect(() => assertDemoSeedInvariants(missingContosoArtifact as unknown as typeof DEMO_SEED)).toThrow(
      "artifact artifact-contoso-resume-g1 is missing its direct-link detail",
    );
  });

  it("rejects inconsistent artifact counts, states, and preview paths", () => {
    const wrongCount = structuredClone(DEMO_SEED) as unknown as {
      readModel: { jobs: { list: { items: Array<{ jobKey: string; artifactCount: number }> } } };
    };
    const contoso = wrongCount.readModel.jobs.list.items.find((item) => item.jobKey === CONTOSO_JOB_KEY)!;
    contoso.artifactCount = 1;
    expect(() => assertDemoSeedInvariants(wrongCount as unknown as typeof DEMO_SEED)).toThrow(
      `job ${CONTOSO_JOB_KEY} artifact count must match its material projections`,
    );

    const wrongStatus = structuredClone(DEMO_SEED) as unknown as {
      readModel: {
        materials: { details: Record<string, { artifact: { status: string } }> };
      };
    };
    const artifactDetail = wrongStatus.readModel.materials.details["artifact-contoso-resume-g1"]!;
    artifactDetail.artifact = { ...artifactDetail.artifact, status: "suppressed" };
    expect(() => assertDemoSeedInvariants(wrongStatus as unknown as typeof DEMO_SEED)).toThrow(
      "artifact artifact-contoso-resume-g1 has inconsistent list and detail status",
    );

    const externalPreview = structuredClone(DEMO_SEED) as unknown as {
      readModel: { materials: { list: { items: Array<{ artifactId: string; localPath: string }> } } };
    };
    const preview = externalPreview.readModel.materials.list.items.find(
      (item) => item.artifactId === "artifact-contoso-resume-pdf-g1",
    )!;
    preview.localPath = "https://demo.invalid/contoso-resume.pdf";
    expect(() => assertDemoSeedInvariants(externalPreview as unknown as typeof DEMO_SEED)).toThrow(
      "artifact artifact-contoso-resume-pdf-g1 references a missing bundled preview asset",
    );
  });
});

describe("public demo fixture privacy boundary", () => {
  it("rejects sensitive-looking fixture content", () => {
    expect(scanDemoPrivacy(["hello person", "@", "sample", ".test"].join(""))).toContain("email");
    expect(scanDemoPrivacy(["sample", ".example", ".com"].join(""))).toContain("domain");
    expect(scanDemoPrivacy(["real-employer", ".tech"].join(""))).toContain("domain");
    expect(scanDemoPrivacy(["+34 ", "612 345 678"].join(""))).toContain("phone");
    expect(scanDemoPrivacy(["sk", "-synthetic-token"].join(""))).toContain("secret");
    expect(scanDemoPrivacy(["https", "://", "sample", ".invalid/path"].join(""))).toContain("full_url");
    expect(scanDemoPrivacy(["/", "Users", "/sample/private.txt"].join(""))).toContain("local_path");
    expect(scanDemoPrivacy(["system", " prompt content"].join(""))).toContain("raw_prompt");
    expect(scanDemoPrivacy(["raw", " profile text content"].join(""))).toContain("raw_profile");
  });

  it("does not classify canonical timestamps and ordinary counters as phone contacts", () => {
    expect(scanDemoPrivacy("2031-01-02T03:04:05.000Z")).not.toContain("phone");
    expect(scanDemoPrivacy("120000")).not.toContain("phone");
  });

  it("keeps every bundled asset safe, present, and same-origin", () => {
    for (const asset of Object.values(DEMO_ARTIFACTS)) {
      const path = join(process.cwd(), "public", asset.url);
      expect(existsSync(path), asset.assetId).toBe(true);
      expect(scanDemoPrivacy(readFileSync(path, "utf8")), asset.assetId).toEqual([]);
    }
    const pdfPath = join(process.cwd(), "public", "demo/profile-resume.pdf");
    expect(readFileSync(pdfPath, "utf8").startsWith("%PDF-")).toBe(true);
  });
});
