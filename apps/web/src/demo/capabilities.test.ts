import { describe, expect, it, vi } from "vitest";

import { DEMO_CAPABILITY_MANIFEST } from "./capabilities.js";
import { DEMO_SIMULATED_ASYNC_OPERATIONS } from "./contracts.js";
import { DemoApiClientAdapter } from "./DemoApiClientAdapter.js";
import {
  DemoWorkspaceRepository,
  InMemoryDemoWorkspaceStore,
} from "./workspace/index.js";

describe("supported public demo scenarios", () => {
  it("keeps the intentional async and external rehearsal allowlists", () => {
    const methodsInClass = (capabilityClass: string) => Object.entries(DEMO_CAPABILITY_MANIFEST)
      .filter(([, capability]) => capability.class === capabilityClass)
      .map(([method]) => method)
      .toSorted();

    expect(methodsInClass("simulated_async")).toEqual([
      "rescoreJob", "retailorJob", "retryStage", "runJobStage",
    ]);
    expect(methodsInClass("rehearsed_external")).toEqual([
      "applyJob", "discoverySourcePreview", "markApplied", "openArtifact",
    ]);
    expect(DEMO_CAPABILITY_MANIFEST.requiredBulletSuggestions.class).toBe("browser_local");
  });

  it("does not expose deferred operations just because the internal scenario engine supports them", async () => {
    const deferredOperations = [
      "renderResumeReviewDraft",
      "ensureCurrentResumeMaterials",
      "retryFailedJobs",
      "runPendingPreparation",
      "rescoreJobsNotOnCurrentScoringPolicy",
      "tailorJob",
      "retailorCurrentPolicy",
      "runPipelineStages",
      "generateOutreachDraft",
      "reviseOutreachDraft",
      "generateMaterials",
      "generateInterviewPrep",
    ] as const;
    const repository = new DemoWorkspaceRepository({
      store: new InMemoryDemoWorkspaceStore(),
      clock: { now: () => new Date("2026-07-11T09:00:00.000Z") },
      createWorkspaceId: () => "workspace-deferred-scenarios-test",
    });
    await repository.initialize();
    const adapter = new DemoApiClientAdapter(repository);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const before = repository.snapshotNow();
      for (const operation of deferredOperations) {
        expect(DEMO_SIMULATED_ASYNC_OPERATIONS, operation).toContain(operation);
        expect(DEMO_CAPABILITY_MANIFEST[operation].class, operation).toBe("unavailable");
        const invoke = adapter[operation] as (...args: unknown[]) => unknown;
        await expect(Promise.resolve().then(() => invoke())).rejects.toMatchObject({
          name: "DemoCapabilityError",
          code: "demo_capability_not_implemented",
          message: expect.stringContaining(operation),
        });
        expect(repository.snapshotNow(), operation).toEqual(before);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      adapter.dispose();
      repository.dispose();
    }
  });
});
