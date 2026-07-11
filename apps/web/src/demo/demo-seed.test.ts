import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_ARTIFACTS } from "./artifacts.js";
import { DEMO_CAPABILITY_MANIFEST } from "./capabilities.js";
import { materializeDemoSeed } from "./clock.js";
import { demoSeedDigest } from "./digest.js";
import { assertDemoSeedInvariants } from "./invariants.js";
import { scanDemoPrivacy } from "./privacy.js";
import { DEMO_SEED } from "./seed.js";

const CLOCK = { anchor: "2031-01-02T03:04:05.000Z" } as const;

describe("canonical public demo seed", () => {
  it("has a complete classified API capability manifest", () => {
    expect(Object.keys(DEMO_CAPABILITY_MANIFEST)).toHaveLength(118);
    expect(Object.values(DEMO_CAPABILITY_MANIFEST).every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it("is deterministic, immutable by type, and covers the required lifecycle arms", () => {
    expect(() => assertDemoSeedInvariants(DEMO_SEED)).not.toThrow();
    expect(demoSeedDigest(DEMO_SEED)).toBe("fnv1a-04d7c62c");
    expect(demoSeedDigest({ b: 2, a: ["seed", true] })).toBe(demoSeedDigest({ a: ["seed", true], b: 2 }));
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
