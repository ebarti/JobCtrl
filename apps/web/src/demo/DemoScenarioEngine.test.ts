import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DemoScenarioEngine } from "./DemoScenarioEngine.js";
import {
  DemoWorkspaceRepository,
  DemoWorkspaceScheduler,
  InMemoryDemoWorkspaceStore,
  type DemoSchedulerClock,
  type DemoWorkspaceClock,
} from "./workspace/index.js";

describe("DemoScenarioEngine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rescores through durable queued, running, and succeeded projections with event parity", async () => {
    const fixture = await buildEngine();
    const before = await fixture.repository.snapshot();
    const oldVersion = before.state.readModel.jobs.details["job-fabrikam-systems"]!.job.scoreVersion!;

    await expect(
      fixture.engine.execute("rescoreJob", ["job-fabrikam-systems", {}]),
    ).resolves.toMatchObject({
      ok: true,
      action: "rescore_job",
      status: "queued",
      jobKey: "job-fabrikam-systems",
    });
    let snapshot = await fixture.repository.snapshot();
    expect(snapshot.state.readModel.runs.list.items[0]).toMatchObject({
      status: "starting",
    });
    const workflowId = snapshot.state.readModel.runs.list.items[0]!.workflowId;
    expect(
      snapshot.state.readModel.dashboard.activity.items.filter(
        (event) => event.workflowId === workflowId,
      ),
    ).toEqual([
      expect.objectContaining({ eventType: "WorkflowQueued", workflowId }),
    ]);

    await fixture.advance(150);
    snapshot = await fixture.repository.snapshot();
    expect(snapshot.state.readModel.jobs.details["job-fabrikam-systems"]!.stages).toContainEqual(
      expect.objectContaining({ stage: "score", state: "running" }),
    );
    expect(
      snapshot.state.readModel.dashboard.activity.items
        .filter((event) => event.workflowId === workflowId)
        .map((event) => event.eventType),
    ).toEqual(["WorkflowStarted", "WorkflowQueued"]);
    await fixture.advance(550);

    snapshot = await fixture.repository.snapshot();
    const job = snapshot.state.readModel.jobs.details["job-fabrikam-systems"]!.job;
    expect(job.scoreVersion).toBe(oldVersion + 1);
    expect(job.scoreStaleness).toMatchObject({ isStale: false, pendingExplicitRescore: false });
    const scored = snapshot.eventLog.find((record) => record.event.eventType === "JobScored")?.event;
    expect(scored?.payload).toMatchObject({
      jobId: "job-fabrikam-systems",
      version: job.scoreVersion,
    });
    expect(snapshot.state.readModel.runs.list.items[0]).toMatchObject({ status: "succeeded", result: "scored" });
    const workflowActivity = snapshot.state.readModel.dashboard.activity.items.filter(
      (event) => event.workflowId === workflowId,
    );
    expect(workflowActivity.map((event) => event.eventType)).toEqual([
      "WorkflowCompleted",
      "WorkflowStarted",
      "WorkflowQueued",
    ]);
    expect(
      workflowActivity.every(
        (event) => snapshot.state.readModel.dashboard.activityEvents[event.eventId]?.event === event,
      ),
    ).toBe(true);
    fixture.dispose();
  });

  it("preserves accepted Contoso g1 on fail-first and atomically accepts g2 on retry", async () => {
    const fixture = await buildEngine();
    const initial = await fixture.repository.snapshot();
    const initialG1 = structuredClone(
      initial.state.readModel.materials.details["artifact-contoso-resume-g1"],
    );

    await fixture.engine.execute("tailorJob", ["job-contoso-reliability", {}]);
    await fixture.advance(150);
    await fixture.advance(850);
    let snapshot = await fixture.repository.snapshot();
    expect(snapshot.state.readModel.materials.details["artifact-contoso-resume-g1"]).toEqual(initialG1);
    expect(snapshot.state.readModel.materials.details["artifact-contoso-resume-pdf-g1"]!.artifact.status).toBe("accepted");
    expect(snapshot.state.readModel.jobs.details["job-contoso-reliability"]!.stages).toContainEqual(
      expect.objectContaining({ stage: "tailor", state: "failed", retryable: true, errorCode: "demo_grounding_gate" }),
    );

    await fixture.engine.execute("retryStage", [
      "job-contoso-reliability",
      { stage: "tailor", resetAttempts: true, runAfter: true, dryRun: false },
    ]);
    await fixture.advance(150);
    await fixture.advance(650);
    snapshot = await fixture.repository.snapshot();
    expect(snapshot.state.readModel.materials.details["artifact-contoso-resume-g1"]!.artifact.status).toBe("suppressed");
    expect(snapshot.state.readModel.materials.details["artifact-contoso-resume-pdf-g1"]!.artifact.status).toBe("suppressed");
    expect(snapshot.state.readModel.materials.details["artifact-contoso-resume-g2"]!.artifact.status).toBe("accepted");
    expect(snapshot.state.readModel.materials.details["artifact-contoso-resume-pdf-g2"]!.artifact.status).toBe("accepted");
    expect(snapshot.state.readModel.jobs.details["job-contoso-reliability"]!.job.artifactCount).toBe(2);
    expect(snapshot.eventLog.filter((record) => record.event.eventType === "TailoredArtifactsSuppressed")).toHaveLength(1);
    fixture.dispose();
  });

  it("runs Discover as a successful deterministic Q/R/T workflow and updates the source projection", async () => {
    const fixture = await buildEngine();
    const response = await fixture.engine.execute("runPipelineStages", [{
      stages: ["discover"],
      limit: 25,
      workers: 1,
      minScore: 7,
      validationMode: "normal",
      dryRun: true,
      rescore: false,
      retailor: false,
      headless: false,
      model: "default",
      llmModel: "simulated",
      tailorModels: [],
      continuous: false,
    }]);
    expect(response).toMatchObject({
      ok: true,
      action: "run_stage",
      status: "queued",
      jobKey: "pipeline",
      command: {
        stages: ["discover"],
        jobIds: [],
      },
      actions: [expect.objectContaining({ status: "queued" })],
    });
    expect(response).not.toHaveProperty("command.jobKeys");
    await fixture.advance(150);
    await fixture.advance(650);

    const snapshot = await fixture.repository.snapshot();
    expect(snapshot.state.readModel.runs.list.items[0]).toMatchObject({ status: "succeeded", result: "discovered" });
    expect(snapshot.state.readModel.discovery.sources.sources.every((source) => source.lastRunId === snapshot.state.readModel.runs.list.items[0]!.runId)).toBe(true);
    expect(snapshot.eventLog.map((record) => record.event.eventType)).toEqual(
      [
        "WorkflowStarted",
        "StageStarted",
        "WorkflowCompleted",
        "StageCompleted",
        "DiscoveryRunCompleted",
      ],
    );
    fixture.dispose();
  });

  it("recovers a running outreach revision after reload and persists the bounded edited body", async () => {
    const store = new InMemoryDemoWorkspaceStore();
    const fixture = await buildEngine(store);
    void fixture.engine.execute("reviseOutreachDraft", [
      "thread-demo",
      { editedBodyText: "A bounded synthetic revision.", kind: "follow_up" },
    ]);
    await fixture.advance(150);
    let snapshot = await fixture.repository.snapshot();
    expect(snapshot.pendingScenarios).toContainEqual(
      expect.objectContaining({
        phase: "running",
        recoveryInput: expect.objectContaining({
          kind: "outreach_revise",
          editedBodyText: "A bounded synthetic revision.",
        }),
      }),
    );
    const schedulerDispose = vi.spyOn(fixture.scheduler, "dispose");
    fixture.dispose();
    expect(schedulerDispose).toHaveBeenCalledTimes(1);

    const reloaded = await buildEngine(store, fixture.time);
    await reloaded.engine.initialize();
    await reloaded.advance(700);
    snapshot = await reloaded.repository.snapshot();
    const thread = snapshot.state.readModel.outreach.thread.thread!;
    const created = thread.drafts.at(-1)!;
    expect(created).toMatchObject({
      bodyText: "A bounded synthetic revision.",
      generation: thread.latestGeneration,
      status: "candidate",
    });
    const revised = snapshot.eventLog.find((record) => record.event.eventType === "OutreachDraftRevised")?.event;
    expect(revised?.payload).toMatchObject({ generation: created.generation });
    expect(snapshot.state.receipts.at(-1)).toMatchObject({
      kind: "llm",
      operation: "reviseOutreachDraft",
      externalEffectOccurred: false,
    });
    reloaded.dispose();
  });

  it("returns production-shaped results for every simulated-async operation", async () => {
    const cases = [
      { name: "renderResumeReviewDraft", delay: 600, invoke: (engine: DemoScenarioEngine) => engine.execute("renderResumeReviewDraft", ["draft-tailored-resume", {}]) },
      { name: "ensureCurrentResumeMaterials", delay: 750, invoke: (engine: DemoScenarioEngine) => engine.execute("ensureCurrentResumeMaterials", ["6e2f4a10-20be-4d5f-98a4-a4bb9a877a35", { force: true }]) },
      { name: "retryFailedJobs", delay: 0, invoke: (engine: DemoScenarioEngine) => engine.execute("retryFailedJobs", [{ jobKeys: ["job-contoso-reliability"], allMatching: false, runAfter: false, workers: 1, minScore: 7, validationMode: "normal", dryRun: false, llmModel: "simulated" }]) },
      { name: "runPendingPreparation", delay: 0, invoke: (engine: DemoScenarioEngine) => engine.execute("runPendingPreparation", [{ jobKeys: ["job-contoso-reliability"], allMatching: false, workers: 1, minScore: 7, validationMode: "normal", dryRun: false, llmModel: "simulated" }]) },
      { name: "rescoreJob", delay: 550, invoke: (engine: DemoScenarioEngine) => engine.execute("rescoreJob", ["job-fabrikam-systems", {}]) },
      { name: "rescoreJobsNotOnCurrentScoringPolicy", delay: 700, invoke: (engine: DemoScenarioEngine) => engine.execute("rescoreJobsNotOnCurrentScoringPolicy", [{ limit: 100, jobKeys: ["job-fabrikam-systems"], dryRun: false }]) },
      { name: "retailorJob", delay: 850, invoke: (engine: DemoScenarioEngine) => engine.execute("retailorJob", ["6e2f4a10-20be-4d5f-98a4-a4bb9a877a35", {}]) },
      { name: "tailorJob", delay: 850, invoke: (engine: DemoScenarioEngine) => engine.execute("tailorJob", ["6e2f4a10-20be-4d5f-98a4-a4bb9a877a35", {}]) },
      { name: "retailorCurrentPolicy", delay: 900, invoke: (engine: DemoScenarioEngine) => engine.execute("retailorCurrentPolicy", [{ limit: 100, jobKeys: ["6e2f4a10-20be-4d5f-98a4-a4bb9a877a35"], dryRun: false, suppressExistingArtifacts: true, tailorModels: [] }]) },
      { name: "runPipelineStages", delay: 650, invoke: (engine: DemoScenarioEngine) => engine.execute("runPipelineStages", [{ stages: ["discover"], limit: 25, workers: 1, minScore: 7, validationMode: "normal", dryRun: true, rescore: false, retailor: false, headless: false, model: "default", llmModel: "simulated", tailorModels: [], continuous: false }]) },
      { name: "generateOutreachDraft", delay: 700, invoke: (engine: DemoScenarioEngine) => engine.execute("generateOutreachDraft", ["contact-demo-hiring-partner", { jobId: "6e2f4a10-20be-4d5f-98a4-a4bb9a877a35", kind: "intro_request" }]) },
      { name: "reviseOutreachDraft", delay: 700, invoke: (engine: DemoScenarioEngine) => engine.execute("reviseOutreachDraft", ["thread-demo", { editedBodyText: "Bounded revision." }]) },
      { name: "retryStage", delay: 650, invoke: (engine: DemoScenarioEngine) => engine.execute("retryStage", ["job-fabrikam-systems", { stage: "score", resetAttempts: false, runAfter: true, dryRun: false }]) },
      { name: "runJobStage", delay: 650, invoke: (engine: DemoScenarioEngine) => engine.execute("runJobStage", ["job-fabrikam-systems", { stage: "score", dryRun: false, limit: 1, workers: 1, minScore: 7, validationMode: "normal", llmModel: "simulated" }]) },
      { name: "generateMaterials", delay: 850, invoke: (engine: DemoScenarioEngine) => engine.execute("generateMaterials", ["6e2f4a10-20be-4d5f-98a4-a4bb9a877a35", { stages: ["tailor"], dryRun: false, limit: 1 }]) },
      { name: "generateInterviewPrep", delay: 800, invoke: (engine: DemoScenarioEngine) => engine.execute("generateInterviewPrep", ["6e2f4a10-20be-4d5f-98a4-a4bb9a877a35", {}]) },
    ] as const;

    expect(cases.map((entry) => entry.name)).toEqual([
      "renderResumeReviewDraft",
      "ensureCurrentResumeMaterials",
      "retryFailedJobs",
      "runPendingPreparation",
      "rescoreJob",
      "rescoreJobsNotOnCurrentScoringPolicy",
      "retailorJob",
      "tailorJob",
      "retailorCurrentPolicy",
      "runPipelineStages",
      "generateOutreachDraft",
      "reviseOutreachDraft",
      "retryStage",
      "runJobStage",
      "generateMaterials",
      "generateInterviewPrep",
    ]);
    const actionKeys = [
      "action",
      "actionId",
      "command",
      "jobKey",
      "message",
      "ok",
      "runId",
      "status",
      "workflowId",
    ];
    const expectedKeys: Record<(typeof cases)[number]["name"], string[]> = {
      renderResumeReviewDraft: ["artifacts", "draft", "layoutBoxCount", "ok", "validation"],
      ensureCurrentResumeMaterials: ["attempt", "generation", "jobKey", "message", "ok", "status", "templateState"],
      retryFailedJobs: ["actions", "count", "jobKeys", "ok", "runAfter", "stageCounts", "status"],
      runPendingPreparation: ["actions", "count", "jobKeys", "message", "ok", "stageCounts", "status"],
      rescoreJob: actionKeys,
      rescoreJobsNotOnCurrentScoringPolicy: actionKeys,
      retailorJob: actionKeys,
      tailorJob: actionKeys,
      retailorCurrentPolicy: actionKeys,
      runPipelineStages: ["action", "actions", "command", "count", "jobKey", "message", "ok", "status"],
      generateOutreachDraft: ["ok", "thread"],
      reviseOutreachDraft: ["ok", "thread"],
      retryStage: actionKeys,
      runJobStage: actionKeys,
      generateMaterials: actionKeys,
      generateInterviewPrep: actionKeys,
    };
    const expectedActions: Partial<Record<(typeof cases)[number]["name"], string>> = {
      rescoreJob: "rescore_job",
      rescoreJobsNotOnCurrentScoringPolicy: "rescore_jobs_not_on_current_scoring_policy",
      retailorJob: "retailor_job",
      tailorJob: "tailor_job",
      retailorCurrentPolicy: "retailor_current_policy",
      runPipelineStages: "run_stage",
      retryStage: "retry_stage",
      runJobStage: "run_stage",
      generateMaterials: "generate_materials",
      generateInterviewPrep: "generate_interview_prep",
    };

    for (const entry of cases) {
      const fixture = await buildEngine();
      const promise = entry.invoke(fixture.engine);
      await vi.advanceTimersByTimeAsync(0);
      const terminalResponse = [
        "renderResumeReviewDraft",
        "ensureCurrentResumeMaterials",
        "generateOutreachDraft",
        "reviseOutreachDraft",
      ].includes(entry.name);
      if (terminalResponse && entry.delay > 0) {
        await fixture.advance(150);
        await fixture.advance(entry.delay);
      }
      const result = await promise;
      expect(result, entry.name).toMatchObject({ ok: true });
      expect(Object.keys(result as object).toSorted(), entry.name).toEqual(
        expectedKeys[entry.name].toSorted(),
      );
      const expectedAction = expectedActions[entry.name];
      if (expectedAction) {
        expect(result, entry.name).toMatchObject({ action: expectedAction });
      }
      if (entry.name === "runPipelineStages") {
        expect(result, entry.name).toMatchObject({ count: 1 });
        expect((result as { actions: unknown[] }).actions).toHaveLength(1);
      }
      if (entry.name === "retryFailedJobs" || entry.name === "runPendingPreparation") {
        expect((result as { actions: unknown[] }).actions).toHaveLength(0);
      }
      if (!terminalResponse && (await fixture.repository.snapshot()).pendingScenarios.length > 0) {
        await fixture.advance(150);
        await fixture.advance(entry.delay);
      }
      expect((await fixture.repository.snapshot()).pendingScenarios, entry.name).toEqual([]);
      fixture.dispose();
    }
  });

  it("keeps synchronous no-op/reset branches out of the scheduler", async () => {
    const fixture = await buildEngine();
    const initialRevision = (await fixture.repository.snapshot()).revision;
    await expect(
      fixture.engine.execute("ensureCurrentResumeMaterials", [
        "6e2f4a10-20be-4d5f-98a4-a4bb9a877a35",
        { force: false },
      ]),
    ).resolves.toMatchObject({ status: "not_required", generation: 1 });
    expect((await fixture.repository.snapshot()).revision).toBe(initialRevision);

    await expect(
      fixture.engine.execute("retryStage", [
        "job-fabrikam-systems",
        { stage: "score", resetAttempts: true, runAfter: false, dryRun: false },
      ]),
    ).resolves.toMatchObject({ status: "reset", action: "retry_stage" });
    const reset = await fixture.repository.snapshot();
    expect(reset.pendingScenarios).toEqual([]);
    expect(reset.state.readModel.jobs.details["job-fabrikam-systems"]!.stages).toContainEqual(
      expect.objectContaining({ stage: "score", state: "pending", attemptCount: 0 }),
    );

    await expect(
      fixture.engine.execute("runJobStage", [
        "job-contoso-reliability",
        { stage: "tailor", dryRun: false, limit: 1, workers: 1, minScore: 7, validationMode: "normal", llmModel: "simulated" },
      ]),
    ).resolves.toMatchObject({ status: "blocked", action: "run_stage" });
    expect((await fixture.repository.snapshot()).pendingScenarios).toEqual([]);
    fixture.dispose();
  });

  it("blocks re-tailoring when no accepted source artifact exists", async () => {
    const fixture = await buildEngine();

    await expect(
      fixture.engine.execute("retailorJob", ["job-fabrikam-systems", {}]),
    ).resolves.toMatchObject({
      status: "blocked",
      action: "retailor_job",
      message: "Re-tailoring requires an accepted source artifact in the demo workspace.",
    });
    expect((await fixture.repository.snapshot()).pendingScenarios).toEqual([]);
    fixture.dispose();
  });

  it("blocks retry-and-run unless the selected stage is retryable and failed", async () => {
    const fixture = await buildEngine();

    await expect(
      fixture.engine.execute("retryStage", [
        "job-contoso-reliability",
        { stage: "tailor", resetAttempts: false, runAfter: true, dryRun: false },
      ]),
    ).resolves.toMatchObject({
      status: "blocked",
      action: "retry_stage",
      message: "Only a retryable failed stage can be retried in the demo workspace.",
    });
    expect((await fixture.repository.snapshot()).pendingScenarios).toEqual([]);
    fixture.dispose();
  });
});

async function buildEngine(
  store = new InMemoryDemoWorkspaceStore(),
  startingTime = 0,
) {
  let now = startingTime;
  let id = 0;
  const workspaceClock: DemoWorkspaceClock = { now: () => new Date(now) };
  const schedulerClock: DemoSchedulerClock = {
    now: () => now,
    setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
    clearTimeout: (timer) => clearTimeout(timer),
  };
  const repository = new DemoWorkspaceRepository({
    store,
    clock: workspaceClock,
    createWorkspaceId: () => "workspace-scenarios",
  });
  await repository.initialize();
  const scheduler = new DemoWorkspaceScheduler(repository, schedulerClock);
  const engine = new DemoScenarioEngine(repository, {
    scheduler,
    clock: workspaceClock,
    createId: (prefix) => `demo-${prefix}-${++id}`,
  });
  await engine.initialize();
  return {
    repository,
    scheduler,
    engine,
    get time() {
      return now;
    },
    advance: async (milliseconds: number) => {
      now += milliseconds;
      await vi.advanceTimersByTimeAsync(milliseconds);
    },
    dispose: () => {
      engine.dispose();
      scheduler.dispose();
      repository.dispose();
    },
  };
}
