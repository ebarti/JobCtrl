import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { JobActions } from "../contexts/pipeline/components/JobActions.js";
import { StageTimeline } from "../contexts/pipeline/components/StageTimeline.js";
import { renderWithProviders } from "../test/render.js";
import { buildTestPorts } from "../test/testPorts.js";
import { DemoApiClientAdapter } from "./DemoApiClientAdapter.js";
import { DemoFeatureFlagAdapter } from "./ports.js";
import { DemoWorkspaceRepository, InMemoryDemoWorkspaceStore } from "./workspace/index.js";

const jobId = "job-fabrikam-systems";
const clock = { now: () => new Date("2026-07-11T12:00:00Z") };

function repository(store: InMemoryDemoWorkspaceStore) {
  return new DemoWorkspaceRepository({
    store, clock, createWorkspaceId: () => "owned-demo-retry-test",
    channelFactory: { create: () => null },
  });
}

describe("demo retry presentation", () => {
  it("seeds the unavailable score retry as non-retryable", async () => {
    const workspace = repository(new InMemoryDemoWorkspaceStore());
    try {
      await workspace.initialize();
      const api = new DemoApiClientAdapter(workspace);
      const detail = await api.job(jobId);
      expect(detail.stages.find((stage) => stage.stage === "score")?.retryable).toBe(false);
    } finally {
      workspace.dispose();
    }
  });

  it("blocks unsupported retry and explains it while preserving a retained workspace", async () => {
    const original = repository(new InMemoryDemoWorkspaceStore());
    await original.initialize();
    const saved = await original.snapshot();
    const retained = { ...saved, state: { ...saved.state, title: "Retained synthetic edit" } };
    retained.state.readModel.jobs.details[jobId]!.stages.find((stage) => stage.stage === "score")!.retryable = true;
    const store = new InMemoryDemoWorkspaceStore(retained);
    const workspace = repository(store);
    try {
      await workspace.initialize();
      const api = new DemoApiClientAdapter(workspace);
      const retry = vi.spyOn(api, "retryStage");
      const detail = await api.job(jobId);
      const ports = buildTestPorts();
      ports.api = api;
      ports.featureFlags = new DemoFeatureFlagAdapter();
      renderWithProviders(
        <>
          <JobActions canRetryStage currentStage="score" jobId={jobId} />
          <StageTimeline jobId={jobId} stages={detail.stages} />
        </>,
        { ports },
      );
      const user = userEvent.setup();
      const retryButton = screen.getByRole("button", { name: "Retry" });
      expect(retryButton).toBeDisabled();
      expect(retryButton).toHaveAttribute("title", "Stage retry is unavailable in the public demo.");
      await user.click(retryButton);
      expect(retry).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Technical details" }));
      expect(screen.getByLabelText("score diagnostics")).toHaveTextContent(/retry\s*unavailable in the demo/i);
      expect(await store.readSnapshot()).toEqual(retained);
      expect(await workspace.snapshot()).toEqual(retained);
    } finally {
      original.dispose();
      workspace.dispose();
    }
  });
});
