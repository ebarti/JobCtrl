import { afterEach, describe, expect, it, vi } from "vitest";

import { scanDemoPrivacy } from "./privacy.js";
import {
  DEMO_INITIAL_EXTERNAL_REHEARSAL_OPERATIONS,
  DemoArtifactPreviewError,
  DemoExternalRehearsalExecutor,
  DemoExternalResourceNotFoundError,
  type DemoArtifactPreviewHandle,
} from "./DemoExternalRehearsalExecutor.js";
import {
  DemoWorkspaceRepository,
  InMemoryDemoWorkspaceStore,
} from "./workspace/index.js";

const NOW = "2026-07-11T12:00:00.000Z";
const JOB = "6e2f4a10-20be-4d5f-98a4-a4bb9a877a35";
const ARTIFACT = "artifact-tailored-resume";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function harness(
  open = vi.fn<(url: `/demo/${string}`) => DemoArtifactPreviewHandle | null>(() => ({
    close: vi.fn(),
  })),
) {
  let id = 0;
  const repository = new DemoWorkspaceRepository({
    store: new InMemoryDemoWorkspaceStore(),
    clock: { now: () => new Date(NOW) },
    createWorkspaceId: () => "workspace-external-rehearsal-test",
  });
  await repository.initialize();
  const executor = new DemoExternalRehearsalExecutor(repository, {
    opener: open,
    clock: { now: () => new Date(NOW) },
    createId: (prefix) => `demo-${prefix}-${++id}`,
  });
  return { executor, open, repository };
}

describe("DemoExternalRehearsalExecutor initial slice", () => {
  it("keeps its execute table exhaustive for the three assigned methods", () => {
    expect(DEMO_INITIAL_EXTERNAL_REHEARSAL_OPERATIONS).toEqual([
      "openArtifact",
      "applyJob",
      "markApplied",
    ]);
  });

  it("opens only a bundled same-origin artifact and records success afterward", async () => {
    const { executor, open, repository } = await harness();
    const before = repository.snapshotNow();

    const response = await executor.execute("openArtifact", [ARTIFACT]);

    expect(Object.keys(response).sort()).toEqual(["artifact", "ok", "opened", "path"]);
    expect(response).toMatchObject({
      ok: true,
      opened: true,
      path: "/demo/tailored-resume.pdf",
      artifact: { artifactId: ARTIFACT },
    });
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith("/demo/tailored-resume.pdf");
    const after = repository.snapshotNow();
    expect(after.state.receipts).toHaveLength(before.state.receipts.length + 1);
    expect(after.state.receipts.at(-1)).toMatchObject({
      kind: "os_open",
      operation: "openArtifact",
      entityType: "artifact",
      entityId: ARTIFACT,
      simulated: true,
      externalEffectOccurred: false,
      recordedAt: NOW,
    });
    expect(after.lastEventSequence).toBe(before.lastEventSequence);
  });

  it("exposes a safe fallback URL when a popup is blocked and records no receipt", async () => {
    const open = vi.fn<(url: `/demo/${string}`) => DemoArtifactPreviewHandle | null>(() => null);
    const { executor, repository } = await harness(open);
    const receiptCount = repository.snapshotNow().state.receipts.length;

    await expect(executor.execute("openArtifact", [ARTIFACT])).rejects.toMatchObject({
      code: "demo_preview_blocked",
      previewUrl: "/demo/tailored-resume.pdf",
    } satisfies Partial<DemoArtifactPreviewError>);
    expect(repository.snapshotNow().state.receipts).toHaveLength(receiptCount);
  });

  it("rejects missing and external artifact paths before invoking the opener", async () => {
    const { executor, open, repository } = await harness();

    await expect(executor.execute("openArtifact", ["artifact-missing"])).rejects.toBeInstanceOf(
      DemoExternalResourceNotFoundError,
    );
    await repository.mutate((draft) => {
      draft.state.readModel.materials.details[ARTIFACT]!.artifact.localPath =
        "https://outside.invalid/resume.pdf";
    });
    await expect(executor.execute("openArtifact", [ARTIFACT])).rejects.toMatchObject({
      code: "demo_preview_rejected",
      previewUrl: null,
    } satisfies Partial<DemoArtifactPreviewError>);
    expect(open).not.toHaveBeenCalled();
  });

  it("forces apply into a completed no-effect dry run with typed events and safe receipt", async () => {
    const { executor, repository } = await harness();
    const before = repository.snapshotNow();
    const response = await executor.execute("applyJob", [
      JOB,
      { dryRun: false, headless: true, limit: 3, model: "caller-provider" },
    ]);

    expect(Object.keys(response).sort()).toEqual([
      "action",
      "actionId",
      "command",
      "eventCursor",
      "jobKey",
      "message",
      "ok",
      "result",
      "runId",
      "status",
      "workflowId",
    ]);
    expect(response).toMatchObject({
      ok: true,
      action: "apply",
      status: "dry_run_complete",
      jobKey: JOB,
      command: {
        action: "apply",
        jobKey: JOB,
        dryRun: true,
        headless: false,
        limit: 3,
        model: "simulated",
      },
      result: { simulated: true, externalEffectOccurred: false, result: "dry_run" },
    });
    const after = repository.snapshotNow();
    const job = after.state.readModel.jobs.list.items.find((item) => item.jobKey === JOB)!;
    expect(job.applyStatus).toBe(before.state.readModel.jobs.list.items[0]!.applyStatus);
    expect(job.appliedAt).toBe(before.state.readModel.jobs.list.items[0]!.appliedAt);
    expect(after.state.readModel.apply.queue.items[0]?.latestApplyRun).toMatchObject({
      runId: response.runId,
      dryRun: true,
      status: "dry_run_complete",
    });
    expect(after.state.readModel.runs.details[response.runId]).toMatchObject({
      status: "dry_run_complete",
      inputSummary: { simulated: true, operation: "applyJob", dryRun: true },
    });
    const events = after.eventLog.slice(before.eventLog.length).map((record) => record.event);
    expect(events.map((event) => event.eventType)).toEqual([
      "ApplyRunStarted",
      "ApplyRunEventRecorded",
    ]);
    expect(events.some((event) => event.eventType === "ApplySubmitIntended")).toBe(false);
    expect(events.some((event) => event.eventType === "ApplicationSubmitted")).toBe(false);
    const receipt = after.state.receipts.at(-1)!;
    expect(receipt).toMatchObject({
      kind: "application",
      operation: "applyJob",
      entityId: JOB,
      simulated: true,
      externalEffectOccurred: false,
    });
    expect(JSON.stringify({ receipt, events, input: after.state.readModel.runs.details[response.runId]?.inputSummary }))
      .not.toContain("caller-provider");
    expect(scanDemoPrivacy(JSON.stringify({ receipt, events }))).toEqual([]);
  });

  it("records an explicitly simulated applied projection without a submission event", async () => {
    const { executor, repository } = await harness();
    const before = repository.snapshotNow();
    const response = await executor.execute("markApplied", [
      JOB,
      { reason: "https://outside.invalid/private-reason" },
    ]);

    expect(Object.keys(response).sort()).toEqual([
      "action",
      "actionId",
      "command",
      "eventCursor",
      "jobKey",
      "message",
      "ok",
      "result",
      "runId",
      "status",
    ]);
    expect(response).toMatchObject({
      action: "mark_applied",
      status: "succeeded",
      result: { simulated: true, externalEffectOccurred: false, result: "simulated_applied" },
    });
    const after = repository.snapshotNow();
    const detail = after.state.readModel.jobs.details[JOB]!;
    expect(detail.job).toMatchObject({
      applyStatus: "applied",
      appliedAt: NOW,
      currentStage: "apply",
      currentState: "succeeded",
    });
    expect(detail.auditHistory[0]).toMatchObject({
      title: "Simulated applied state recorded",
      actor: "demo_rehearsal",
    });
    expect(after.state.readModel.apply.queue.items.some((item) => item.jobKey === JOB)).toBe(false);
    const events = after.eventLog.slice(before.eventLog.length).map((record) => record.event);
    expect(events.map((event) => event.eventType)).toEqual(["StageCompleted"]);
    expect(events.some((event) => event.eventType === "ApplicationSubmitted")).toBe(false);
    const receipt = after.state.receipts.at(-1)!;
    expect(receipt).toMatchObject({
      operation: "markApplied",
      entityId: JOB,
      simulated: true,
      externalEffectOccurred: false,
    });
    expect(JSON.stringify({ receipt, events, audit: detail.auditHistory[0] })).not.toContain(
      "outside.invalid",
    );
  });

  it("rejects invalid job IDs without mutating events or receipts", async () => {
    const { executor, repository } = await harness();
    const before = repository.snapshotNow();

    await expect(executor.execute("applyJob", ["job-missing", {}])).rejects.toBeInstanceOf(
      DemoExternalResourceNotFoundError,
    );
    await expect(executor.execute("markApplied", ["job-missing", {}])).rejects.toBeInstanceOf(
      DemoExternalResourceNotFoundError,
    );
    const after = repository.snapshotNow();
    expect(after.lastEventSequence).toBe(before.lastEventSequence);
    expect(after.state.receipts).toEqual(before.state.receipts);
  });

  it("never touches network, provider, browser automation, or messaging globals", async () => {
    const fetchSpy = vi.fn();
    const xhrSpy = vi.fn();
    const eventSourceSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("XMLHttpRequest", xhrSpy);
    vi.stubGlobal("EventSource", eventSourceSpy);
    const { executor } = await harness();

    await executor.execute("applyJob", [JOB, { dryRun: false }]);
    await executor.execute("markApplied", ["job-fabrikam-systems", {}]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
    expect(eventSourceSpy).not.toHaveBeenCalled();
  });
});
