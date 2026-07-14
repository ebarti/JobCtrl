import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { PipelineOperationsSnapshotSchema } from "@jobctrl/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildPipelineOperationsSnapshot } from "../src/pipeline-operations.js";
import { ensureProjectionTables } from "../src/projections.js";

const NOW = new Date("2026-07-14T12:00:00.000Z");
const DISCOVER_WORKFLOW_ID = "discover-local";
const DISCOVER_RUN_ID = "00000000-0000-4000-8000-000000000000";
const PREPARATION_RUN_ID = "00000000-0000-4000-8000-000000000010";
const fixtures: Fixture[] = [];

interface Fixture {
  directory: string;
  dbPath: string;
  configPath: string;
  db: Database.Database;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("pipeline operations read model", () => {
  it.each([
    ["in_progress", "discovering", false, "pending"],
    ["canceled", "canceled", false, "pending"],
    ["failed", "failed", false, "pending"],
    ["succeeded", "draining", true, "pending"],
    ["succeeded", "completed", true, "succeeded"],
    ["succeeded", "completed_with_issues", true, "failed"],
  ] as const)("selects the %s execution phase", (status, phase, terminalFanout, scoreState) => {
    const fixture = createFixture();
    insertExecution(fixture, { status });
    insertMember(fixture, { key: "phase", requiredSteps: ["score"] });
    insertStageState(fixture, "phase", "score", scoreState);
    if (terminalFanout) insertStep(fixture, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });

    expect(snapshot(fixture).execution).toMatchObject({ phase, membershipClosed: terminalFanout });
  });

  it("does not terminalize retryable fanout, stage, or PDF failures", () => {
    const terminalFanout = createFixture();
    insertExecution(terminalFanout, { status: "succeeded" });
    insertMember(terminalFanout, { key: "fanout-retry", requiredSteps: ["score"] });
    insertStageState(terminalFanout, "fanout-retry", "score", "succeeded");
    insertStep(terminalFanout, {
      stepKind: "preparation_fanout",
      itemKey: "terminal",
      state: "failed",
      retryable: 1,
    });
    const terminalFanoutResult = snapshot(terminalFanout);
    expect(terminalFanoutResult.execution).toMatchObject({
      membershipClosed: true,
      phase: "completed_with_issues",
    });

    const retryingFanout = createFixture();
    insertExecution(retryingFanout, { status: "in_progress" });
    insertMember(retryingFanout, { key: "fanout-backoff", requiredSteps: ["score"] });
    insertStageState(retryingFanout, "fanout-backoff", "score", "succeeded");
    insertStep(retryingFanout, {
      stepKind: "preparation_fanout",
      itemKey: "terminal",
      state: "failed",
      retryable: 1,
    });
    insertHeartbeat(retryingFanout, {
      activeSlots: 1,
      counts: { discovery_preparation_fanout: 1 },
      details: [activityDetail("discovery_preparation_fanout", "op_000000000000000000000010", "discover-local")],
    });
    const fanoutResult = snapshot(retryingFanout);
    expect(fanoutResult.execution).toMatchObject({
      membershipClosed: false,
      phase: "discovering",
    });
    expect(fanoutResult.overallEta).not.toMatchObject({ status: "unavailable", reason: "no_work" });

    const retryableStage = createFixture();
    insertExecution(retryableStage, { status: "succeeded" });
    insertMember(retryableStage, { key: "stage-retry", requiredSteps: ["score"] });
    insertStageState(retryableStage, "stage-retry", "score", "failed", null, null, 1);
    insertStep(retryableStage, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });
    insertHeartbeat(retryableStage, {
      activeSlots: 1,
      counts: { score_job: 1 },
      details: [activityDetail("score_job", "op_000000000000000000000011", unmatchedWorkflowRef("retry-stage"))],
    });
    const stageResult = snapshot(retryableStage);
    expect(stageResult.execution).toMatchObject({ phase: "draining" });
    expect(stageResult.overallEta).not.toMatchObject({ status: "unavailable", reason: "no_work" });

    const retryableSource = createFixture();
    insertExecution(retryableSource, { status: "in_progress" });
    insertStep(retryableSource, {
      stepKind: "source_planning",
      itemKey: "retry-plan",
      state: "failed",
      retryable: 1,
    });
    insertHeartbeat(retryableSource, {
      activeSlots: 1,
      counts: { plan_discovery_sources: 1 },
      details: [activityDetail("plan_discovery_sources", "op_000000000000000000000013", "discover-local")],
    });
    expect(stage(snapshot(retryableSource), "source_planning", "current_execution").eta)
      .not.toMatchObject({ status: "unavailable", reason: "no_work" });

    const retryablePdf = createFixture();
    const current = insertMember(retryablePdf, { key: "pdf-current-retry", requiredSteps: ["pdf"] });
    const sweep = insertMember(retryablePdf, {
      key: "pdf-sweep-retry",
      cohort: "existing_backlog",
      requiredSteps: ["pdf"],
    });
    insertExecution(retryablePdf, { status: "succeeded" });
    insertStep(retryablePdf, {
      stepKind: "pdf_render",
      itemKey: pdfItemKey(current.preparationWorkflowId),
      state: "failed",
      retryable: 1,
    });
    insertStep(retryablePdf, {
      stepKind: "pdf_render",
      itemKey: pdfItemKey(sweep.preparationWorkflowId),
      state: "failed",
      retryable: 1,
    });
    insertStep(retryablePdf, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });
    insertHeartbeat(retryablePdf, {
      activeSlots: 1,
      counts: { render_pdf: 1 },
      details: [activityDetail("render_pdf", "op_000000000000000000000012", current.preparationWorkflowId)],
    });

    const result = snapshot(retryablePdf);
    expect(result.execution).toMatchObject({ phase: "draining" });
    expect(result.overallEta).not.toMatchObject({ status: "unavailable", reason: "no_work" });
    expect(stage(result, "pdf_render", "current_execution").currentExecution).toMatchObject({ failed: 1 });
    expect(stage(result, "pdf_render", "execution_sweep").existingBacklog).toMatchObject({
      kind: "domain_jobs",
      counts: { failed: 1 },
    });

    const exhausted = createFixture();
    const exhaustedMember = insertMember(exhausted, { key: "exhausted-stage", requiredSteps: ["score"] });
    insertExecution(exhausted, { status: "succeeded" });
    insertStageState(exhausted, "exhausted-stage", "score", "failed", null, null, 1);
    insertWorkflowProjection(exhausted, exhaustedMember.preparationWorkflowId, "failed");
    insertStep(exhausted, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });
    expect(snapshot(exhausted).execution).toMatchObject({
      phase: "completed_with_issues",
      currentExecution: { terminal: 1, remaining: 0 },
    });

    const exhaustedPdf = createFixture();
    const exhaustedPdfMember = insertMember(exhaustedPdf, { key: "exhausted-pdf", requiredSteps: ["pdf"] });
    insertExecution(exhaustedPdf, { status: "succeeded" });
    insertStep(exhaustedPdf, {
      stepKind: "pdf_render",
      itemKey: pdfItemKey(exhaustedPdfMember.preparationWorkflowId),
      state: "failed",
      retryable: 1,
    });
    insertWorkflowProjection(exhaustedPdf, exhaustedPdfMember.preparationWorkflowId, "timed_out");
    insertStep(exhaustedPdf, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });
    expect(snapshot(exhaustedPdf).execution).toMatchObject({
      phase: "completed_with_issues",
      currentExecution: { terminal: 1, remaining: 0 },
    });
  });

  it("keeps promoted members current and swept members separate while excluding both from global backlog", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    insertMember(fixture, { key: "promoted", cohort: "observed_this_run", requiredSteps: ["score"] });
    insertMember(fixture, { key: "swept", cohort: "existing_backlog", requiredSteps: ["score"] });
    insertMember(fixture, {
      key: "outside",
      cohort: "observed_this_run",
      requiredSteps: [],
      workflowId: "other",
      runId: "other-run",
    });
    insertStageState(fixture, "promoted", "score", "succeeded");
    insertStageState(fixture, "swept", "score", "pending");
    insertStageState(fixture, "outside", "score", "succeeded");
    insertStep(fixture, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });

    const result = snapshot(fixture);
    expect(result.execution).toMatchObject({
      phase: "draining",
      currentExecution: { members: 1, planned: 1, terminal: 1, remaining: 0 },
      sweptExistingBacklog: { members: 1, planned: 1, terminal: 0, remaining: 1 },
    });
    expect(stage(result, "score", "current_execution").currentExecution).toMatchObject({ eligible: 1, succeeded: 1 });
    expect(stage(result, "score", "execution_sweep").existingBacklog).toMatchObject({
      kind: "domain_jobs",
      counts: { eligible: 1, waiting: 1 },
    });
    expect(stage(result, "score", "global_outside_execution").existingBacklog).toMatchObject({
      kind: "domain_jobs",
      counts: { eligible: 1, succeeded: 1, waiting: 0 },
    });
  });

  it("selects the latest persisted terminal execution when no run is active or draining", () => {
    const fixture = createFixture();
    insertExecution(fixture, { workflowId: "discover-old", runId: "run-old", status: "succeeded" });
    insertExecution(fixture, { workflowId: "discover-z-latest", runId: "run-latest", status: "canceled" });

    expect(snapshot(fixture).execution).toMatchObject({
      discoverWorkflowId: "discover-z-latest",
      discoverRunId: "run-latest",
      selectedAs: "latest_terminal",
      phase: "canceled",
    });
  });

  it("reports source-family 4/4 independently from reconciliation fanout", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertStep(fixture, { stepKind: "source_planning", itemKey: "plan", state: "succeeded", detailCount: 4 });
    for (let index = 1; index <= 4; index += 1) {
      insertStep(fixture, { stepKind: "source_family", itemKey: `source-${index}`, state: "succeeded" });
    }
    insertStep(fixture, { stepKind: "enrichment_pass", itemKey: "current", state: "queued" });
    insertStep(fixture, { stepKind: "preparation_fanout", itemKey: "current", state: "queued" });

    const result = snapshot(fixture);
    expect(result.sourceFamilies).toMatchObject({
      planned: 4,
      counts: { eligible: 4, succeeded: 4 },
    });
    expect(result.reconciliation).toMatchObject({
      enrichment: { eligible: 1, waiting: 1 },
      preparationFanout: { eligible: 1, waiting: 1 },
    });
    expect(stage(result, "source_family", "current_execution").currentExecution).toMatchObject({
      eligible: 4,
      succeeded: 4,
    });
  });

  it("uses every bucket exactly once for the current execution stage scope", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    const states = [
      "pending",
      "running",
      "succeeded",
      "skipped",
      "blocked",
      "failed",
      "exhausted",
      "canceled",
      "needs_verification",
      "stale",
      null,
    ];
    for (const [index, state] of states.entries()) {
      const key = `bucket-${index}`;
      insertMember(fixture, { key, requiredSteps: ["score"] });
      if (state !== null) insertStageState(fixture, key, "score", state);
    }

    const counts = stage(snapshot(fixture), "score", "current_execution").currentExecution;
    expect(counts).toMatchObject({
      eligible: 11,
      waiting: 1,
      processing: 1,
      succeeded: 1,
      skipped: 1,
      blocked: 1,
      failed: 1,
      exhausted: 1,
      canceled: 1,
      needsVerification: 1,
      stale: 1,
      unknown: 1,
    });
    expect(Object.entries(counts)
      .filter(([name]) => name !== "eligible")
      .reduce((total, [, value]) => total + value, 0)).toBe(counts.eligible);
  });

  it("uses exact PDF joins, merges safe runtime activity inventory, and omits private input data", () => {
    const fixture = createFixture();
    const current = insertMember(fixture, { key: "pdf-current", requiredSteps: ["pdf"] });
    const sweep = insertMember(fixture, { key: "pdf-sweep", cohort: "existing_backlog", requiredSteps: ["pdf"] });
    insertExecution(fixture, {
      status: "succeeded",
      inputSummary: { secret: "do-not-expose", resumeUrl: "https://private.invalid/resume" },
    });
    insertStep(fixture, { stepKind: "pdf_render", itemKey: pdfItemKey(current.preparationWorkflowId), state: "succeeded" });
    insertStep(fixture, { stepKind: "pdf_render", itemKey: pdfItemKey(sweep.preparationWorkflowId), state: "running" });
    insertStep(fixture, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });
    insertStep(fixture, { stepKind: "source_family", itemKey: "source-alpha", state: "running" });
    insertWorkflowProjection(fixture, sweep.preparationWorkflowId, "in_progress", PREPARATION_RUN_ID);
    insertHeartbeat(fixture, {
      activeSlots: 3,
      counts: { render_pdf: 1, discovery_source_family: 1, score_job: 1 },
      details: [
        activityDetail("render_pdf", "op_000000000000000000000001", sweep.preparationWorkflowId, PREPARATION_RUN_ID),
        activityDetail("discovery_source_family", "op_000000000000000000000004", "discover-local"),
        activityDetail("score_job", "op_000000000000000000000002", unmatchedWorkflowRef("pdf-score")),
      ],
    });

    const result = snapshot(fixture);
    expect(result.execution).toMatchObject({ phase: "draining" });
    expect(stage(result, "pdf_render", "current_execution").currentExecution).toMatchObject({
      eligible: 1,
      succeeded: 1,
    });
    expect(stage(result, "pdf_render", "execution_sweep").existingBacklog).toMatchObject({
      kind: "domain_jobs",
      counts: { eligible: 1, processing: 1 },
    });
    expect(result.capacity).toMatchObject({ status: "available", configuredSlots: 4, activeSlots: 3 });
    expect(result.activeItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "resolved_job",
        activityType: "render_pdf",
        stage: "pdf_render",
        workflowId: sweep.preparationWorkflowId,
        executionId: PREPARATION_RUN_ID,
      }),
      expect.objectContaining({ kind: "source_family", sourceFamily: "source-alpha" }),
      expect.objectContaining({ kind: "unresolved_runtime_activity", activityType: "score_job" }),
    ]));
    expect(result.activeItemsTotal).toBe(3);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("do-not-expose");
    expect(serialized).not.toContain("https://private.invalid");
  });

  it("keeps inventory null when telemetry is unavailable and prefers primary ETA evidence over metrics", () => {
    const unavailable = createFixture();
    insertExecution(unavailable, { status: "in_progress" });
    expect(snapshot(unavailable)).toMatchObject({ activeItems: [], activeItemsTotal: null, activeItemsTruncated: null });

    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    insertMember(fixture, { key: "eta-current", requiredSteps: ["score"] });
    insertStageState(fixture, "eta-current", "score", "pending");
    insertStep(fixture, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });
    insertHeartbeat(fixture, {
      activeSlots: 1,
      counts: { score_job: 1 },
      details: [activityDetail("score_job", "op_000000000000000000000003", unmatchedWorkflowRef("eta"))],
    });
    for (let index = 0; index < 5; index += 1) {
      const key = `eta-history-${index}`;
      insertStageState(fixture, key, "score", "succeeded", 60_000, new Date(NOW.getTime() - index * 60_000).toISOString());
    }
    fixture.db.prepare(
      `INSERT INTO operational_attempt_metrics (
         tenant_id, occurred_at, stage, attempt_kind, outcome, duration_ms
       ) VALUES ('local', ?, 'score', 'worker', 'succeeded', 7200000)`,
    ).run(NOW.toISOString());

    const eta = snapshot(fixture).overallEta;
    expect(eta).toMatchObject({ status: "available", basis: "stage_throughput" });
    if (eta.status === "available") expect(eta.highSeconds).toBeLessThan(1_000);
  });

  it("keeps pooled capacity visible but refuses an ETA when multi-worker slots cannot be fully inventoried", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    insertMember(fixture, { key: "unexplained", requiredSteps: ["score"] });
    insertStageState(fixture, "unexplained", "score", "pending");
    insertStep(fixture, { stepKind: "source_planning", itemKey: "unexplained-plan", state: "succeeded", detailCount: 1 });
    insertStep(fixture, { stepKind: "source_family", itemKey: "unexplained-source", state: "running" });
    insertStep(fixture, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });
    for (let index = 0; index < 5; index += 1) {
      insertStageState(
        fixture,
        `unexplained-history-${index}`,
        "score",
        "succeeded",
        60_000,
        new Date(NOW.getTime() - index * 60_000).toISOString(),
      );
    }
    insertHeartbeat(fixture, {
      workerId: "worker-a",
      activeSlots: 1,
      counts: { discovery_source_family: 1 },
      details: [activityDetail("discovery_source_family", "op_000000000000000000000005", DISCOVER_WORKFLOW_ID)],
    });
    insertHeartbeat(fixture, {
      workerId: "worker-b",
      activeSlots: 2,
      counts: { score_job: 1 },
      details: [activityDetail("score_job", "op_000000000000000000000006", unmatchedWorkflowRef("worker-b"))],
    });

    const result = snapshot(fixture);
    expect(result.capacity).toMatchObject({
      status: "available",
      configuredSlots: 8,
      activeSlots: 3,
      availableSlots: 5,
    });
    expect(result.activeItemsTruncated).toBe(true);
    expect(result.overallEta).toMatchObject({ status: "unavailable", reason: "contention_unbounded" });
    expect(result.sourceFamilies?.eta).toMatchObject({ status: "unavailable", reason: "contention_unbounded" });
    expect(stage(result, "source_family", "current_execution").eta).toMatchObject({
      status: "unavailable",
      reason: "contention_unbounded",
    });
    expect(stage(result, "score", "current_execution").eta).toMatchObject({
      status: "unavailable",
      reason: "contention_unbounded",
    });
  });

  it("does not promote a running projection into fresh zero-active runtime inventory", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertStep(fixture, { stepKind: "source_family", itemKey: "stale-projection", state: "running" });
    insertHeartbeat(fixture, { activeSlots: 0, counts: {}, details: [] });

    const result = snapshot(fixture);
    expect(result.freshness).toMatchObject({ status: "fresh" });
    expect(result.sourceFamilies).toMatchObject({ counts: { eligible: 1, processing: 1 } });
    expect(result.activeItems).toEqual([]);
    expect(result.activeItemsTotal).toBe(0);
    expect(result.activeItemsTruncated).toBe(false);
  });

  it("does not enrich an unrelated runtime activity that shares a projection activity type", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertStep(fixture, { stepKind: "source_family", itemKey: "collision-source", state: "running" });
    insertHeartbeat(fixture, {
      activeSlots: 1,
      counts: { discovery_source_family: 1 },
      details: [
        activityDetail(
          "discovery_source_family",
          "op_000000000000000000000014",
          "discover-local",
          "00000000-0000-4000-8000-000000000099",
        ),
      ],
    });

    const result = snapshot(fixture);
    expect(result.activeItems).toEqual([
      expect.objectContaining({ kind: "unresolved_runtime_activity", activityType: "discovery_source_family" }),
    ]);
    expect(result.activeItems).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "source_family" }),
    ]));
  });

  it("does not hydrate a PDF runtime activity from a different Temporal run", () => {
    const fixture = createFixture();
    const member = insertMember(fixture, { key: "pdf-run-collision", requiredSteps: ["pdf"] });
    insertExecution(fixture, { status: "succeeded" });
    insertStep(fixture, { stepKind: "pdf_render", itemKey: pdfItemKey(member.preparationWorkflowId), state: "running" });
    insertStep(fixture, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });
    insertWorkflowProjection(fixture, member.preparationWorkflowId, "in_progress", PREPARATION_RUN_ID);
    insertHeartbeat(fixture, {
      activeSlots: 1,
      counts: { render_pdf: 1 },
      details: [
        activityDetail(
          "render_pdf",
          "op_000000000000000000000016",
          member.preparationWorkflowId,
          "00000000-0000-4000-8000-000000000099",
        ),
      ],
    });

    const result = snapshot(fixture);
    expect(result.activeItems).toEqual([
      expect.objectContaining({ kind: "unresolved_runtime_activity", activityType: "render_pdf" }),
    ]);
    expect(result.activeItems).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "resolved_job", stage: "pdf_render" }),
    ]));
  });

  it("includes same-pool sweep retries and global demand in the current stage ETA only", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    insertMember(fixture, { key: "eta-current-scope", requiredSteps: ["score"] });
    insertMember(fixture, { key: "eta-sweep-scope", cohort: "existing_backlog", requiredSteps: ["score"] });
    insertStageState(fixture, "eta-current-scope", "score", "pending");
    insertStageState(fixture, "eta-sweep-scope", "score", "failed", null, null, 1);
    insertStageState(fixture, "eta-global-scope", "score", "pending");
    insertStep(fixture, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });
    for (let index = 0; index < 5; index += 1) {
      insertStageState(
        fixture,
        `eta-same-pool-history-${index}`,
        "score",
        "succeeded",
        60_000,
        new Date(NOW.getTime() - index * 60_000).toISOString(),
      );
    }
    insertHeartbeat(fixture, {
      activeSlots: 1,
      counts: { score_job: 1 },
      details: [activityDetail("score_job", "op_000000000000000000000017", unmatchedWorkflowRef("same-pool"))],
    });

    const result = snapshot(fixture);
    expect(stage(result, "score", "current_execution").eta).toMatchObject({
      status: "available",
      caveat: "Includes bounded external backlog, retry, or queue contention.",
    });
    expect(stage(result, "score", "execution_sweep").eta).toMatchObject({
      status: "available",
      caveat: null,
    });
  });

  it("does not price source or a current stage as isolated from a retryable sweep stage", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    insertMember(fixture, { key: "cross-stage-current", requiredSteps: ["score"] });
    insertMember(fixture, { key: "cross-stage-sweep", cohort: "existing_backlog", requiredSteps: ["tailor"] });
    insertStageState(fixture, "cross-stage-current", "score", "pending");
    insertStageState(fixture, "cross-stage-sweep", "tailor", "failed", null, null, 1);
    insertStep(fixture, { stepKind: "source_planning", itemKey: "cross-stage-plan", state: "succeeded", detailCount: 1 });
    insertStep(fixture, { stepKind: "source_family", itemKey: "cross-stage-source", state: "running" });
    insertStep(fixture, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });
    for (let index = 0; index < 5; index += 1) {
      insertStageState(
        fixture,
        `cross-stage-history-${index}`,
        "score",
        "succeeded",
        60_000,
        new Date(NOW.getTime() - index * 60_000).toISOString(),
      );
    }
    insertHeartbeat(fixture, {
      activeSlots: 1,
      counts: { score_job: 1 },
      details: [activityDetail("score_job", "op_000000000000000000000018", unmatchedWorkflowRef("cross-stage"))],
    });

    const result = snapshot(fixture);
    expect(stage(result, "score", "current_execution").eta).toMatchObject({
      status: "unavailable",
      reason: "contention_unbounded",
    });
    expect(result.sourceFamilies?.eta).toMatchObject({
      status: "unavailable",
      reason: "contention_unbounded",
    });
  });

  it.each([
    ["with a unique nonterminal preparation owner", true],
    ["without a resolvable preparation owner", false],
  ] as const)("treats global retryable demand %s as unbounded overall and current contention", (_name, hasOwner) => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    insertMember(fixture, { key: "global-retry-current", requiredSteps: ["score"] });
    insertStageState(fixture, "global-retry-current", "score", "pending");
    const globalKey = hasOwner ? "global-retry-owned" : "global-retry-unowned";
    if (hasOwner) {
      const owner = insertMember(fixture, {
        key: globalKey,
        requiredSteps: ["tailor"],
        workflowId: "other-discovery",
        runId: "other-run",
      });
      insertWorkflowProjection(fixture, owner.preparationWorkflowId, "in_progress", PREPARATION_RUN_ID);
    }
    insertStageState(fixture, globalKey, "tailor", "failed", null, null, 1);
    insertStep(fixture, { stepKind: "source_planning", itemKey: "global-retry-plan", state: "succeeded", detailCount: 1 });
    insertStep(fixture, { stepKind: "source_family", itemKey: "global-retry-source", state: "running" });
    insertStep(fixture, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });
    for (let index = 0; index < 5; index += 1) {
      insertStageState(
        fixture,
        `global-retry-history-${index}`,
        "score",
        "succeeded",
        60_000,
        new Date(NOW.getTime() - index * 60_000).toISOString(),
      );
    }
    insertHeartbeat(fixture, {
      activeSlots: 1,
      counts: { discovery_source_family: 1 },
      details: [activityDetail("discovery_source_family", "op_000000000000000000000019", DISCOVER_WORKFLOW_ID)],
    });

    const result = snapshot(fixture);
    expect(stage(result, "score", "current_execution").eta).toMatchObject({
      status: "unavailable",
      reason: "contention_unbounded",
    });
    expect(result.sourceFamilies?.eta).toMatchObject({
      status: "unavailable",
      reason: "contention_unbounded",
    });
    expect(result.overallEta).toMatchObject({
      status: "unavailable",
      reason: "contention_unbounded",
    });
  });

  it("accepts a global retryable failure owned by a terminal JobPreparationWorkflow", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    insertMember(fixture, { key: "global-terminal-current", requiredSteps: ["score"] });
    insertStageState(fixture, "global-terminal-current", "score", "pending");
    const owner = insertMember(fixture, {
      key: "global-terminal-owner",
      requiredSteps: ["tailor"],
      workflowId: "other-discovery-terminal",
      runId: "other-run-terminal",
    });
    insertStageState(fixture, "global-terminal-owner", "tailor", "failed", null, null, 1);
    insertWorkflowProjection(fixture, owner.preparationWorkflowId, "failed", PREPARATION_RUN_ID);
    insertStep(fixture, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });
    for (let index = 0; index < 5; index += 1) {
      insertStageState(
        fixture,
        `global-terminal-history-${index}`,
        "score",
        "succeeded",
        60_000,
        new Date(NOW.getTime() - index * 60_000).toISOString(),
      );
    }
    insertHeartbeat(fixture, {
      activeSlots: 1,
      counts: { score_job: 1 },
      details: [activityDetail("score_job", "op_000000000000000000000020", unmatchedWorkflowRef("global-terminal"))],
    });

    const result = snapshot(fixture);
    expect(stage(result, "score", "current_execution").eta).toMatchObject({ status: "available" });
    expect(result.overallEta).not.toMatchObject({
      status: "unavailable",
      reason: "contention_unbounded",
    });
  });

  it("does not price source work as isolated when global preparation work shares the activity pool", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertStep(fixture, { stepKind: "source_planning", itemKey: "global-plan", state: "succeeded", detailCount: 1 });
    insertStep(fixture, { stepKind: "source_family", itemKey: "global-source", state: "running" });
    insertStageState(fixture, "global-outside", "score", "pending");
    insertHeartbeat(fixture, {
      activeSlots: 1,
      counts: { discovery_source_family: 1 },
      details: [activityDetail("discovery_source_family", "op_000000000000000000000015", DISCOVER_WORKFLOW_ID)],
    });

    expect(snapshot(fixture).sourceFamilies?.eta).toMatchObject({
      status: "unavailable",
      reason: "contention_unbounded",
    });
  });

  it.each([
    ["unsupported queue observation", {
      status: "unsupported",
      observedAt: NOW.toISOString(),
      reasonCode: "describe_task_queue_stats_unsupported",
    }],
    ["unavailable queue observation", {
      status: "unavailable",
      observedAt: NOW.toISOString(),
      reasonCode: "not_sampled",
    }],
    ["stale queue observation", availableObservation({ observedAt: "2026-07-14T11:58:00.000Z" })],
    ["workflow queue backlog", availableObservation({ workflowBacklog: 1 })],
    ["activity queue backlog", availableObservation({ activityBacklog: 1 })],
  ] as const)("treats %s as unbounded contention for overall, source, and stage ETAs", (_name, queueObservation) => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertMember(fixture, { key: "queue-score", requiredSteps: ["score"] });
    insertStageState(fixture, "queue-score", "score", "pending");
    insertStep(fixture, { stepKind: "source_planning", itemKey: "queue-plan", state: "succeeded", detailCount: 1 });
    insertStep(fixture, { stepKind: "source_family", itemKey: "queue-source", state: "running" });
    insertHeartbeat(fixture, {
      activeSlots: 1,
      counts: { discovery_source_family: 1 },
      details: [activityDetail("discovery_source_family", "op_000000000000000000000007", "discover-local")],
      queueObservation,
    });

    const result = snapshot(fixture);
    expect(result.overallEta).toMatchObject({ status: "unavailable", reason: "contention_unbounded" });
    expect(result.sourceFamilies?.eta).toMatchObject({ status: "unavailable", reason: "contention_unbounded" });
    expect(stage(result, "score", "current_execution").eta).toMatchObject({
      status: "unavailable",
      reason: "contention_unbounded",
    });
  });
});

function createFixture(): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-pipeline-operations-"));
  const dbPath = path.join(directory, "jobctrl.db");
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ daily_budget_usd: 25 }));
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE job_stage_states (
      job_url TEXT NOT NULL,
      stage TEXT NOT NULL,
      state TEXT,
      attempt_count INTEGER,
      max_attempts INTEGER,
      started_at TEXT,
      updated_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      error_code TEXT,
      error_message TEXT,
      retryable INTEGER,
      blocked_by_json TEXT,
      next_action TEXT
    );
    CREATE TABLE discovery_execution_jobs (
      tenant_id TEXT NOT NULL,
      discover_workflow_id TEXT NOT NULL,
      discover_run_id TEXT NOT NULL,
      job_url TEXT NOT NULL,
      cohort_kind TEXT NOT NULL,
      preparation_workflow_id TEXT,
      work_plan_state TEXT NOT NULL,
      required_steps_json TEXT
    );
    CREATE TABLE worker_runtime_heartbeats (
      worker_id TEXT PRIMARY KEY,
      component TEXT NOT NULL,
      pid INTEGER NOT NULL,
      hostname TEXT NOT NULL,
      app_dir TEXT NOT NULL,
      db_path TEXT NOT NULL,
      task_queue TEXT NOT NULL,
      started_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      max_concurrent_activities INTEGER,
      activity_executor_max_workers INTEGER,
      active_activity_count INTEGER NOT NULL DEFAULT 0,
      active_activity_counts_json TEXT NOT NULL DEFAULT '{}',
      active_activity_details_json TEXT NOT NULL DEFAULT '[]',
      active_activity_details_total INTEGER NOT NULL DEFAULT 0,
      active_activity_details_truncated INTEGER NOT NULL DEFAULT 0,
      activity_duration_summary_json TEXT NOT NULL DEFAULT '{}',
      task_queue_observation_json TEXT,
      heartbeat_schema_version INTEGER NOT NULL DEFAULT 2
    );
  `);
  ensureProjectionTables(db);
  const fixture = { directory, dbPath, configPath, db };
  fixtures.push(fixture);
  return fixture;
}

function snapshot(fixture: Fixture) {
  return PipelineOperationsSnapshotSchema.parse(buildPipelineOperationsSnapshot(fixture.db, {
    dbPath: fixture.dbPath,
    configPath: fixture.configPath,
    now: NOW,
  }));
}

function insertExecution(
  fixture: Fixture,
  input: { status: string; workflowId?: string; runId?: string; inputSummary?: Record<string, unknown> },
): void {
  fixture.db.prepare(
    `INSERT OR REPLACE INTO workflow_run_projections (
       workflow_id, tenant_id, workflow_type, status, input_summary_json, temporal_run_id, started_at, finished_at
     ) VALUES (?, 'local', 'DiscoverWorkflow', ?, ?, ?, ?, ?)`,
  ).run(
    input.workflowId ?? DISCOVER_WORKFLOW_ID,
    input.status,
    JSON.stringify(input.inputSummary ?? { workers: 2 }),
    input.runId ?? DISCOVER_RUN_ID,
    "2026-07-14T11:00:00.000Z",
    input.status === "in_progress" ? null : "2026-07-14T11:30:00.000Z",
  );
}

function insertWorkflowProjection(
  fixture: Fixture,
  workflowId: string,
  status: string,
  runId: string | null = null,
): void {
  fixture.db.prepare(
    `INSERT OR REPLACE INTO workflow_run_projections (
       workflow_id, tenant_id, workflow_type, status, input_summary_json, temporal_run_id, started_at, finished_at
     ) VALUES (?, 'local', 'JobPreparationWorkflow', ?, '{}', ?, ?, ?)`,
  ).run(workflowId, status, runId, "2026-07-14T11:00:00.000Z", "2026-07-14T11:30:00.000Z");
}

function insertMember(
  fixture: Fixture,
  input: {
    key: string;
    cohort?: "observed_this_run" | "existing_backlog";
    requiredSteps: string[];
    workflowId?: string;
    runId?: string;
  },
): { preparationWorkflowId: string } {
  const preparationWorkflowId = `prep-preparation:${createHash("sha256").update(input.key).digest("hex")}`;
  fixture.db.prepare(
    `INSERT INTO discovery_execution_jobs (
       tenant_id, discover_workflow_id, discover_run_id, job_url, cohort_kind,
       preparation_workflow_id, work_plan_state, required_steps_json
     ) VALUES ('local', ?, ?, ?, ?, ?, 'planned', ?)`,
  ).run(
    input.workflowId ?? DISCOVER_WORKFLOW_ID,
    input.runId ?? DISCOVER_RUN_ID,
    `https://private.invalid/${input.key}`,
    input.cohort ?? "observed_this_run",
    preparationWorkflowId,
    JSON.stringify(input.requiredSteps),
  );
  return { preparationWorkflowId };
}

function insertStageState(
  fixture: Fixture,
  key: string,
  stage: string,
  state: string,
  durationMs: number | null = null,
  finishedAt: string | null = null,
  retryable = 0,
): void {
  fixture.db.prepare(
    `INSERT INTO job_stage_states (
       job_url, stage, state, attempt_count, max_attempts, updated_at, finished_at, duration_ms, retryable
     ) VALUES (?, ?, ?, 1, 3, ?, ?, ?, ?)`,
  ).run(`https://private.invalid/${key}`, stage, state, NOW.toISOString(), finishedAt, durationMs, retryable);
}

function insertStep(
  fixture: Fixture,
  input: { stepKind: string; itemKey: string; state: string; detailCount?: number | null; retryable?: number },
): void {
  fixture.db.prepare(
    `INSERT INTO pipeline_step_projections (
       tenant_id, discover_workflow_id, discover_run_id, step_kind, item_key, state, attempt,
       queued_at, started_at, finished_at, duration_ms, retryable, detail_count, last_event_id, last_updated_at
     ) VALUES ('local', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    DISCOVER_WORKFLOW_ID,
    DISCOVER_RUN_ID,
    input.stepKind,
    input.itemKey,
    input.state,
    "2026-07-14T11:00:00.000Z",
    input.state === "running" ? "2026-07-14T11:05:00.000Z" : null,
    input.state === "succeeded" || input.state === "failed" ? "2026-07-14T11:30:00.000Z" : null,
    input.state === "succeeded" ? 60_000 : null,
    input.retryable ?? 0,
    input.detailCount ?? null,
    NOW.toISOString(),
  );
}

function insertHeartbeat(
  fixture: Fixture,
  input: {
    workerId?: string;
    activeSlots: number;
    counts: Record<string, number>;
    details: Record<string, unknown>[];
    queueObservation?: unknown;
  },
): void {
  fixture.db.prepare(
    `INSERT INTO worker_runtime_heartbeats (
       worker_id, component, pid, hostname, app_dir, db_path, task_queue, started_at, last_seen_at,
       max_concurrent_activities, activity_executor_max_workers, active_activity_count,
       active_activity_counts_json, active_activity_details_json, active_activity_details_total,
       active_activity_details_truncated, activity_duration_summary_json, task_queue_observation_json,
       heartbeat_schema_version
     ) VALUES (?, 'temporal-worker', 1, 'localhost', ?, ?, 'jobctrl-default', ?, ?, 4, 6, ?, ?, ?, ?, 0, '{}', ?, 2)`,
  ).run(
    input.workerId ?? "worker",
    fixture.directory,
    fixture.dbPath,
    NOW.toISOString(),
    NOW.toISOString(),
    input.activeSlots,
    JSON.stringify(input.counts),
    JSON.stringify(input.details),
    Object.values(input.counts).reduce((total, count) => total + count, 0),
    JSON.stringify(input.queueObservation ?? availableObservation()),
  );
}

function activityDetail(
  activityType: string,
  opaqueId: string,
  workflowRef: string,
  executionRef = DISCOVER_RUN_ID,
): Record<string, unknown> {
  const kinds: Record<string, string> = {
    render_pdf: "job-pdf-render",
    score_job: "job-scoring",
    discovery_source_family: "discovery-source-family",
    discovery_preparation_fanout: "discovery-preparation-fanout",
    plan_discovery_sources: "discovery-plan",
  };
  return {
    activityType,
    operationalRef: { kind: kinds[activityType], opaqueId },
    workflowRef,
    executionRef,
    attempt: 1,
    startedAt: "2026-07-14T11:05:00.000Z",
  };
}

function availableObservation(options: { observedAt?: string; workflowBacklog?: number; activityBacklog?: number } = {}): Record<string, unknown> {
  const stats = {
    pollerCount: 1,
    approximateBacklogCount: options.activityBacklog ?? 0,
    approximateBacklogAgeSeconds: 0,
    tasksAddRate: 1,
    tasksDispatchRate: 1,
  };
  return {
    status: "available",
    observedAt: options.observedAt ?? NOW.toISOString(),
    workflow: { ...stats, approximateBacklogCount: options.workflowBacklog ?? 0 },
    activity: stats,
  };
}

function pdfItemKey(preparationWorkflowId: string): string {
  return `pdf:${createHash("sha256").update(preparationWorkflowId.slice("prep-".length)).digest("hex")}`;
}

function unmatchedWorkflowRef(key: string): string {
  return `prep-preparation:${createHash("sha256").update(`unmatched:${key}`).digest("hex")}`;
}

function stage(
  result: ReturnType<typeof snapshot>,
  name: string,
  scope: "current_execution" | "execution_sweep" | "global_outside_execution",
) {
  const entry = result.stages.find((candidate) => candidate.stage === name && candidate.scope === scope);
  if (!entry) throw new Error(`Missing ${name}/${scope} stage`);
  return entry;
}
