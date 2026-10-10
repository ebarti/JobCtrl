import { describe, expect, it, vi } from "vitest";

import { DEMO_CAPABILITY_MANIFEST } from "./capabilities.js";
import { DemoApiClientAdapter } from "./DemoApiClientAdapter.js";
import {
  DemoWorkspaceRepository,
  InMemoryDemoWorkspaceStore,
} from "./workspace/index.js";

describe("offline model capabilities", () => {
  it("keeps external rehearsals bounded and model capabilities unavailable", () => {
    const methodsInClass = (capabilityClass: string) => Object.entries(DEMO_CAPABILITY_MANIFEST)
      .filter(([, capability]) => capability.class === capabilityClass)
      .map(([method]) => method)
      .toSorted();

    expect(methodsInClass("rehearsed_external")).toEqual([
      "markApplied", "openArtifact",
    ]);
    expect(DEMO_CAPABILITY_MANIFEST.requiredBulletSuggestions.class).toBe("unavailable");
  });

  it("fails unavailable model operations without changing saved artifacts or using the network", async () => {
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
      "rescoreJob", "retailorJob", "retryStage", "runJobStage",
      "targetRoleSuggestions", "requiredBulletSuggestions", "importResume",
      "discoverySourcePreview", "importManualCapture",
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
