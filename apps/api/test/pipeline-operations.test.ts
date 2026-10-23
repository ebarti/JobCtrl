import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { PipelineOperationsSnapshotSchema } from "@jobctrl/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildPipelineOperationsSnapshot } from "../src/pipeline-operations.js";
import { initializeExactDatabase } from "./exact-schema.js";

const NOW = new Date("2026-07-14T12:00:00.000Z");
const DISCOVER_WORKFLOW_ID = "discover-local";
const DISCOVER_RUN_ID = "00000000-0000-4000-8000-000000000000";
const PREPARATION_RUN_ID = "00000000-0000-4000-8000-000000000010";
const SHARED_TENANT_JOB_ID = "99999999-9999-4999-8999-999999999999";
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
  it.each(["enrich", "score", "tailor", "cover"])("reports the %s recovery batch stage and exact execution without inventing job membership", (stageName) => {
    const fixture = createFixture();
    const workflowId = `prepare-auto-local-${stageName}-${"a".repeat(24)}`;
    insertHeartbeat(fixture, {
      activeSlots: 1, counts: { [stageName]: 1 },
      details: [activityDetail(stageName, "op_000000000000000000000042", workflowId, PREPARATION_RUN_ID)],
    });
    const result = snapshot(fixture);
    expect(result.activeStageCounts).toEqual([{ stage: stageName, count: 1 }]);
    expect(result.activeItems).toEqual([expect.objectContaining({
      kind: "unresolved_runtime_activity", activityType: stageName, stage: stageName,
      workflowId, executionId: PREPARATION_RUN_ID,
    })]);
    expect(result.activeItemsTotal).toBe(1);
    expect(result.projectionCoverage).toMatchObject({ persistedMembershipCount: 0 });
  });

  it("presents stages in dependency order with an explicit enrichment reconciliation label", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertMember(fixture, {
      key: "ordered-stages",
      requiredSteps: ["score", "tailor", "cover", "pdf"],
    });
    for (const stageName of ["score", "tailor", "cover"] as const) {
      insertStageState(fixture, "ordered-stages", stageName, "pending");
    }

    expect(
      snapshot(fixture).stages
        .filter((stageRow) => stageRow.scope === "current_execution")
        .map((stageRow) => [stageRow.stage, stageRow.label]),
    ).toEqual([
      ["source_planning", "Plan sources"],
      ["source_family", "Crawl sources"],
      ["enrich", "Enrich"],
      ["reconciliation", "Enrichment reconciliation"],
      ["score", "Score"],
      ["tailor", "Tailor"],
      ["cover", "Cover letter"],
      ["pdf_render", "Render PDF"],
    ]);
  });

  it("keeps projection coverage absent only when fresh telemetry proves no selected execution or runtime work", () => {
    const fixture = createFixture();
    insertHeartbeat(fixture, { activeSlots: 0, counts: {}, details: [] });

    const result = snapshot(fixture);
    expect(result.projectionCoverage).toBeNull();
    expect(result.activeItems).toEqual([]);
    expect(result.activeItemsTotal).toBe(0);
    expect(result.activeItemsTruncated).toBe(false);
  });

  it("reports recovering coverage when no selected execution has unavailable telemetry", () => {
    const fixture = createFixture();

    const result = snapshot(fixture);
    expect(result.projectionCoverage).toMatchObject({
      status: "recovering",
      persistedMembershipCount: 0,
      persistedStepCount: 0,
    });
    expect(result.activeItems).toEqual([]);
    expect(result.activeItemsTotal).toBeNull();
    expect(result.activeItemsTruncated).toBeNull();
  });

  it("reports recovering coverage when occupied slots have no allowlisted runtime details", () => {
    const fixture = createFixture();
    insertHeartbeat(fixture, { activeSlots: 1, counts: {}, details: [] });

    const result = snapshot(fixture);
    expect(result.projectionCoverage).toMatchObject({
      status: "recovering",
      persistedMembershipCount: 0,
      persistedStepCount: 0,
    });
    expect(result.activeItems).toEqual([]);
    expect(result.activeItemsTotal).toBe(0);
    expect(result.activeItemsTruncated).toBe(true);
  });

  it("reports four standalone URL imports without inventing pipeline stages or a Discover execution", () => {
    const fixture = createFixture();
    insertHeartbeat(fixture, {
      activeSlots: 4, counts: { job_url_import: 4 },
      details: Array.from({ length: 4 }, (_, index) => ({
        ...activityDetail("job_url_import", `op_${String(index).padStart(24, "0")}`, unmatchedWorkflowRef("intake")),
        workflowRef: null,
      })),
    });
    const result = snapshot(fixture);
    expect(result.execution).toBeNull();
    expect(result.capacity).toMatchObject({ activeSlots: 4 });
    expect(result.activeItemsTotal).toBe(4);
    expect(result.activeItemsTruncated).toBe(false);
    expect(result.activeStageCounts).toEqual([]);
    expect(result.activeItems).toHaveLength(4);
    for (const item of result.activeItems) {
      expect(item).toMatchObject({
        kind: "unresolved_runtime_activity", activityType: "job_url_import", stage: null,
        workflowId: null, attempt: 1,
      });
    }
    expect(result.projectionCoverage?.status).toBe("recovering");
  });

  it("reports recovering coverage when fresh runtime work has no selected execution", () => {
    const fixture = createFixture();
    insertHeartbeat(fixture, {
      activeSlots: 1,
      counts: { tailor_job: 1 },
      details: [
        activityDetail("tailor_job", "op_000000000000000000000041", unmatchedWorkflowRef("unselected")),
      ],
    });

    const result = snapshot(fixture);
    expect(result.projectionCoverage).toMatchObject({
      status: "recovering",
      persistedMembershipCount: 0,
      persistedStepCount: 0,
    });
    expect(result.activeStageCounts).toEqual([{ stage: "tailor", count: 1 }]);
    expect(result.activeItems).toEqual([{
      kind: "unresolved_runtime_activity",
      activityType: "tailor_job",
      workflowId: unmatchedWorkflowRef("unselected"),
      executionId: DISCOVER_RUN_ID,
      attempt: 1,
      startedAt: "2026-07-14T11:05:00.000Z",
      opaqueId: "op_000000000000000000000041",
      stage: "tailor",
    }]);
    expect(result.activeItemsTotal).toBe(1);
    expect(result.activeItemsTruncated).toBe(false);
  });

  it.each([
    ["score_job", "score"], ["tailor_job", "tailor"],
    ["cover_letter", "cover"], ["render_pdf", "pdf_render"],
  ])("labels standalone %s from its exact preparation execution without inventing a Discover", (activityType, expectedStage) => {
    const fixture = createFixture();
    const preparation = insertStandalonePreparation(fixture, "standalone-label");
    const opaqueId = "op_000000000000000000000044";
    insertHeartbeat(fixture, { activeSlots: 1, counts: { [activityType]: 1 }, details: [
      activityDetail(activityType, opaqueId, preparation.workflowId, PREPARATION_RUN_ID),
    ] });
    const writesBefore = fixture.db.prepare("SELECT total_changes() AS count").get();

    const result = snapshot(fixture);
    expect(result.execution).toBeNull();
    expect(result.activeItems).toEqual([expect.objectContaining({
      kind: "resolved_job", activityType, stage: expectedStage, jobKey: opaqueId,
      workflowId: preparation.workflowId, executionId: PREPARATION_RUN_ID,
      title: "Standalone role", company: "Standalone company",
    })]);
    expect(result.activeItemsTotal).toBe(1);
    expect(result.activeItemsTruncated).toBe(false);
    expect(result.projectionCoverage?.status).toBe("recovering");
    expect(fixture.db.prepare("SELECT total_changes() AS count").get()).toEqual(writesBefore);
    expect(JSON.stringify(result)).not.toContain("private-runtime-input-sentinel");
    expect(JSON.stringify(result)).not.toContain(preparation.jobId);
    expect(JSON.stringify(result)).not.toContain("https://private.invalid/");
  });

  it("hydrates global preparation labels without changing an unrelated selected Discover", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertMember(fixture, { key: "selected-unrelated", requiredSteps: ["score"] });
    insertStageState(fixture, "selected-unrelated", "score", "pending");
    const workflowId = unmatchedWorkflowRef("standalone-selected");
    insertHeartbeat(fixture, { activeSlots: 1, counts: { tailor_job: 1 }, details: [
      activityDetail("tailor_job", "op_000000000000000000000045", workflowId, PREPARATION_RUN_ID),
    ] });
    const before = snapshot(fixture);
    insertStandalonePreparation(fixture, "standalone-selected", workflowId);
    const after = snapshot(fixture);
    expect(after.activeItems[0]).toMatchObject({ kind: "resolved_job", title: "Standalone role" });
    expect(before.activeItems[0]).toMatchObject({ kind: "unresolved_runtime_activity" });
    const { activeItems: _beforeItems, ...beforeMetrics } = before;
    const { activeItems: _afterItems, ...afterMetrics } = after;
    expect(afterMetrics).toEqual(beforeMetrics);
  });

  it.each([
    "missing projection", "foreign workflow tenant", "foreign job tenant", "wrong workflow type",
    "stale run", "missing run", "malformed JSON", "missing job", "unknown job",
    "null job", "numeric job", "array job", "object job", "empty job", "padded job",
    "batch selection", "missing runtime run", "missing runtime workflow",
  ])("keeps standalone preparation %s unresolved", (fault) => {
    const fixture = createFixture();
    const preparation = insertStandalonePreparation(fixture, "invalid-standalone");
    const updateInput = (value: unknown) => fixture.db.prepare(
      "UPDATE workflow_run_projections SET input_summary_json = ? WHERE workflow_id = ?",
    ).run(JSON.stringify(value), preparation.workflowId);
    if (fault === "missing projection") fixture.db.prepare("DELETE FROM workflow_run_projections").run();
    if (fault === "foreign workflow tenant") fixture.db.prepare("UPDATE workflow_run_projections SET tenant_id = 'other'").run();
    if (fault === "foreign job tenant") fixture.db.prepare("UPDATE jobs SET tenant_id = 'other'").run();
    if (fault === "wrong workflow type") fixture.db.prepare("UPDATE workflow_run_projections SET workflow_type = 'JobPipelineWorkflow'").run();
    if (fault === "stale run") fixture.db.prepare("UPDATE workflow_run_projections SET temporal_run_id = ?").run(DISCOVER_RUN_ID);
    if (fault === "missing run") fixture.db.prepare("UPDATE workflow_run_projections SET temporal_run_id = NULL").run();
    if (fault === "malformed JSON") fixture.db.prepare("UPDATE workflow_run_projections SET input_summary_json = '{'").run();
    if (fault === "missing job") updateInput({});
    if (fault === "unknown job") updateInput({ jobId: jobIdFor("absent") });
    if (fault === "null job") updateInput({ jobId: null });
    if (fault === "numeric job") updateInput({ jobId: 123 });
    if (fault === "array job") updateInput({ jobId: [preparation.jobId] });
    if (fault === "object job") updateInput({ jobId: { id: preparation.jobId } });
    if (fault === "empty job") updateInput({ jobId: "" });
    if (fault === "padded job") updateInput({ jobId: ` ${preparation.jobId} ` });
    if (fault === "batch selection") updateInput({ jobIds: [preparation.jobId] });
    const detail = activityDetail("tailor_job", "op_000000000000000000000046", preparation.workflowId, PREPARATION_RUN_ID);
    if (fault === "missing runtime run") detail.executionRef = null;
    if (fault === "missing runtime workflow") detail.workflowRef = null;
    insertHeartbeat(fixture, { activeSlots: 1, counts: { tailor_job: 1 }, details: [detail] });
    const result = snapshot(fixture);
    expect(result.activeItems).toEqual([expect.objectContaining({ kind: "unresolved_runtime_activity" })]);
    expect(result.activeItemsTotal).toBe(1);
    expect(JSON.stringify(result)).not.toContain("Standalone role");
    expect(JSON.stringify(result)).not.toContain("private-runtime-input-sentinel");
  });

  it.each(["score", "tailor", "cover"])("does not assign a batch %s activity to one preparation job", (activityType) => {
    const fixture = createFixture();
    const preparation = insertStandalonePreparation(fixture, "batch-preparation");
    insertHeartbeat(fixture, { activeSlots: 1, counts: { [activityType]: 1 }, details: [
      activityDetail(activityType, "op_000000000000000000000050", preparation.workflowId, PREPARATION_RUN_ID),
    ] });
    expect(snapshot(fixture).activeItems).toEqual([expect.objectContaining({ kind: "unresolved_runtime_activity" })]);
  });

  it("fences selected membership labels to the exact preparation run", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    const member = insertMember(fixture, { key: "selected-run-label", requiredSteps: ["tailor"], title: "Selected role" });
    insertWorkflowProjection(fixture, member.preparationWorkflowId, "in_progress", PREPARATION_RUN_ID);
    insertHeartbeat(fixture, { activeSlots: 2, counts: { tailor_job: 2 }, details: [
      activityDetail("tailor_job", "op_000000000000000000000047", member.preparationWorkflowId, PREPARATION_RUN_ID),
      activityDetail("tailor_job", "op_000000000000000000000048", member.preparationWorkflowId, DISCOVER_RUN_ID),
    ] });
    expect(snapshot(fixture).activeItems).toEqual([
      expect.objectContaining({ kind: "resolved_job", title: "Selected role", executionId: PREPARATION_RUN_ID }),
      expect.objectContaining({ kind: "unresolved_runtime_activity", executionId: DISCOVER_RUN_ID }),
    ]);
  });

  it("does not hydrate stale preparation telemetry from a valid canonical binding", () => {
    const fixture = createFixture();
    const preparation = insertStandalonePreparation(fixture, "stale-bound-preparation");
    insertHeartbeat(fixture, { activeSlots: 1, counts: { tailor_job: 1 }, details: [
      activityDetail("tailor_job", "op_000000000000000000000049", preparation.workflowId, PREPARATION_RUN_ID),
    ] });
    fixture.db.prepare("UPDATE worker_runtime_heartbeats SET last_seen_at = ?").run(new Date(NOW.getTime() - 60_000).toISOString());
    const result = snapshot(fixture);
    expect(result.activeItems).toEqual([]);
    expect(result.activeItemsTotal).toBeNull();
    expect(JSON.stringify(result)).not.toContain("Standalone role");
  });

  it("preserves a truncated standalone runtime inventory without a selected execution", () => {
    const fixture = createFixture();
    insertHeartbeat(fixture, {
      activeSlots: 2,
      counts: { tailor_job: 2 },
      details: [activityDetail("tailor_job", "op_000000000000000000000042", unmatchedWorkflowRef("truncated"))],
    });

    const result = snapshot(fixture);
    expect(result.activeItems).toHaveLength(1);
    expect(result.activeItemsTotal).toBe(2);
    expect(result.activeItemsTruncated).toBe(true);
  });

  it("withholds stale standalone activity details without a selected execution", () => {
    const fixture = createFixture();
    insertHeartbeat(fixture, {
      activeSlots: 1,
      counts: { tailor_job: 1 },
      details: [activityDetail("tailor_job", "op_000000000000000000000043", unmatchedWorkflowRef("stale"))],
    });
    fixture.db.prepare("UPDATE worker_runtime_heartbeats SET last_seen_at = ?")
      .run(new Date(NOW.getTime() - 60_000).toISOString());

    const result = snapshot(fixture);
    expect(result.activeItems).toEqual([]);
    expect(result.activeItemsTotal).toBeNull();
    expect(result.activeItemsTruncated).toBeNull();
    expect(result.activeStageCounts).toBeNull();
  });

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

  it("uses exact-v7 tenant job ids", () => {
    const fixture = createFixture();
    const localUrl = "https://example.test/local/shared-job";
    const otherUrl = "https://example.test/other/shared-job";
    insertExecution(fixture, { status: "in_progress" });
    const member = insertMember(fixture, {
      key: "tenant-shared",
      jobId: SHARED_TENANT_JOB_ID,
      jobUrl: localUrl,
      title: "Local role",
      company: "Local company",
      requiredSteps: ["score"],
    });
    insertStageState(fixture, "tenant-shared", "score", "succeeded", null, null, 0, {
      jobId: SHARED_TENANT_JOB_ID,
    });
    fixture.db.prepare(
      `INSERT INTO jobs (tenant_id, job_id, url, title, company)
       VALUES ('other', ?, ?, 'Other role', 'Other company')`,
    ).run(SHARED_TENANT_JOB_ID, otherUrl);
    fixture.db.prepare(
      `INSERT INTO job_stage_states (
         tenant_id, job_id, stage, state, attempt_count, max_attempts, updated_at, retryable
       ) VALUES ('other', ?, 'score', 'failed', 1, 3, ?, 1)`,
    ).run(SHARED_TENANT_JOB_ID, NOW.toISOString());
    insertWorkflowProjection(fixture, member.preparationWorkflowId, "in_progress", PREPARATION_RUN_ID);
    insertHeartbeat(fixture, {
      activeSlots: 1,
      counts: { score_job: 1 },
      details: [activityDetail("score_job", "op_000000000000000000000777", member.preparationWorkflowId, PREPARATION_RUN_ID)],
    });

    const result = snapshot(fixture);

    expect(stage(result, "score", "current_execution").currentExecution).toMatchObject({
      eligible: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(stage(result, "score", "global_outside_execution").existingBacklog).toMatchObject({
      counts: { eligible: 0, failed: 0 },
    });
    expect(result.activeItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "resolved_job", title: "Local role", company: "Local company" }),
    ]));
    expect(fixture.db.prepare(
      "SELECT url FROM jobs WHERE tenant_id = 'local' AND job_id = ?",
    ).get(SHARED_TENANT_JOB_ID)).toEqual({ url: localUrl });
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

  it("reports a planned unscheduled source family as waiting while discovery is active", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertStep(fixture, {
      stepKind: "source_planning",
      itemKey: "plan",
      state: "succeeded",
      detailCount: 2,
    });
    insertStep(fixture, {
      stepKind: "source_family",
      itemKey: "family:jobspy",
      state: "running",
    });

    const active = snapshot(fixture);
    expect(active.sourceFamilies).toMatchObject({
      planned: 2,
      counts: { eligible: 2, waiting: 1, processing: 1, unknown: 0 },
    });
    expect(stage(active, "source_family", "current_execution").currentExecution).toMatchObject({
      eligible: 2,
      waiting: 1,
      processing: 1,
      unknown: 0,
    });

    fixture.db.prepare(
      `UPDATE pipeline_step_projections
          SET state = 'succeeded', finished_at = ?, duration_ms = 60000
        WHERE tenant_id = 'local'
          AND discover_workflow_id = ?
          AND discover_run_id = ?
          AND step_kind = 'source_family'
          AND item_key = 'family:jobspy'`,
    ).run(NOW.toISOString(), DISCOVER_WORKFLOW_ID, DISCOVER_RUN_ID);
    insertExecution(fixture, { status: "succeeded" });

    expect(snapshot(fixture).sourceFamilies).toMatchObject({
      planned: 2,
      counts: { eligible: 2, waiting: 0, succeeded: 1, unknown: 1 },
    });
  });

  it("projects exact-run JobStreaming traversal facts without provider cursors", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertStep(fixture, {
      stepKind: "source_planning",
      itemKey: "plan",
      state: "succeeded",
      detailCount: 1,
    });
    insertStep(fixture, {
      stepKind: "source_family",
      itemKey: "family:jobspy",
      state: "running",
    });
    const progressPayload = (runId: string, site: string, completedUnits: number) => ({
      workflowId: DISCOVER_WORKFLOW_ID,
      discoverRunId: runId,
      progress: {
        sourceProgress: {
          providerProgress: {
            site,
            phase: "search",
            unit: "page",
            completedUnits,
            totalUnits: null,
            rawItemsSeen: 42,
            jobsEmitted: 9,
            hasMore: true,
          },
        },
      },
    });
    fixture.db.prepare(
      `INSERT INTO job_events (
         tenant_id, job_id, identity_version, stage, event_type, level,
         message, occurred_at, payload_json
       ) VALUES ('local', NULL, 1, 'discover', 'StageProgress', 'info', ?, ?, ?)`,
    ).run(
      "current provider progress",
      "2026-07-14T11:58:00.000Z",
      JSON.stringify(progressPayload(DISCOVER_RUN_ID, "indeed", 3)),
    );
    fixture.db.prepare(
      `INSERT INTO job_events (
         tenant_id, job_id, identity_version, stage, event_type, level,
         message, occurred_at, payload_json
       ) VALUES ('local', NULL, 1, 'discover', 'StageProgress', 'info', ?, ?, ?)`,
    ).run(
      "newer progress from another run",
      "2026-07-14T11:59:00.000Z",
      JSON.stringify(progressPayload("different-temporal-run", "google", 99)),
    );

    const result = snapshot(fixture);

    expect(result.sourceFamilies?.providerProgress).toEqual({
      site: "indeed",
      phase: "search",
      unit: "page",
      completedUnits: 3,
      totalUnits: null,
      rawItemsSeen: 42,
      jobsEmitted: 9,
      hasMore: true,
    });
    expect(JSON.stringify(result)).not.toContain("resume_state");
    expect(JSON.stringify(result)).not.toContain("cursor");

    fixture.db.prepare(
      `UPDATE pipeline_step_projections
          SET state = 'succeeded', finished_at = ?, duration_ms = 60000
        WHERE tenant_id = 'local'
          AND discover_workflow_id = ?
          AND discover_run_id = ?
          AND step_kind = 'source_family'
          AND item_key = 'family:jobspy'`,
    ).run(NOW.toISOString(), DISCOVER_WORKFLOW_ID, DISCOVER_RUN_ID);
    expect(snapshot(fixture).sourceFamilies?.providerProgress).toBeUndefined();
  });

  it("folds attempt exhaustion into the public failed outcome", () => {
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
      failed: 2,
      exhausted: 0,
      canceled: 1,
      needsVerification: 1,
      stale: 1,
      unknown: 1,
    });
    expect(Object.entries(counts)
      .filter(([name]) => name !== "eligible")
      .reduce((total, [, value]) => total + value, 0)).toBe(counts.eligible);
  });

  it("reports newly linked pending members as waiting for enrichment", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    const member = insertMember(fixture, { key: "awaiting-enrichment", requiredSteps: ["score"] });
    fixture.db.prepare(
      `UPDATE discovery_execution_jobs
          SET preparation_workflow_id = NULL,
              work_plan_state = 'pending',
              required_steps_json = NULL
        WHERE tenant_id = 'local' AND job_id = ?`,
    ).run(member.jobId);

    expect(stage(snapshot(fixture), "enrich", "current_execution").currentExecution).toMatchObject({
      eligible: 1,
      waiting: 1,
      unknown: 0,
    });
  });

  it.each(["pending", "queued", "running"])("keeps unrecorded PDFs waiting while required scoring is %s in both cohorts", (state) => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    for (const cohort of ["observed_this_run", "existing_backlog"] as const) {
      const key = `pdf-awaits-${cohort}-${state}`;
      insertMember(fixture, { key, cohort, requiredSteps: ["score", "pdf"] });
      insertStageState(fixture, key, "score", state);
    }
    const result = snapshot(fixture);
    expect(stage(result, "pdf_render", "current_execution").currentExecution).toMatchObject({
      eligible: 1, waiting: 1, unknown: 0,
    });
    expect(stage(result, "pdf_render", "execution_sweep").existingBacklog).toMatchObject({
      kind: "domain_jobs", counts: { eligible: 1, waiting: 1, unknown: 0 },
    });
  });

  it.each(["tailor", "cover"])("keeps unrecorded PDFs waiting for required %s work", (upstream) => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertMember(fixture, { key: "pdf-awaits-material", requiredSteps: [upstream, "pdf"] });
    insertStageState(fixture, "pdf-awaits-material", upstream, "running");
    expect(stage(snapshot(fixture), "pdf_render", "current_execution").currentExecution).toMatchObject({
      eligible: 1, waiting: 1, unknown: 0,
    });
  });

  it.each(["succeeded", "failed", "blocked", "canceled"])("retains an unrecorded PDF gap after required scoring is %s", (state) => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertMember(fixture, { key: "pdf-gap", requiredSteps: ["score", "pdf"] });
    insertStageState(fixture, "pdf-gap", "score", state);
    expect(stage(snapshot(fixture), "pdf_render", "current_execution").currentExecution).toMatchObject({
      eligible: 1, waiting: 0, unknown: 1,
    });
  });

  it.each(["succeeded", "failed", "canceled"])("retains a PDF gap when its owner is %s despite stale pending prerequisites", (status) => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    const member = insertMember(fixture, { key: "pdf-closed-owner", requiredSteps: ["score", "pdf"] });
    insertStageState(fixture, "pdf-closed-owner", "score", "pending");
    insertWorkflowProjection(fixture, member.preparationWorkflowId, status);
    expect(stage(snapshot(fixture), "pdf_render", "current_execution").currentExecution).toMatchObject({
      eligible: 1, waiting: 0, unknown: 1,
    });
  });

  it("retains a PDF gap when its required prerequisite has no recorded state", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertMember(fixture, { key: "pdf-missing-prerequisite", requiredSteps: ["score", "pdf"] });
    expect(stage(snapshot(fixture), "pdf_render", "current_execution").currentExecution).toMatchObject({
      eligible: 1, waiting: 0, unknown: 1,
    });
  });

  it("does not use unrelated running work to explain an unrecorded PDF", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertMember(fixture, { key: "pdf-only", requiredSteps: ["pdf"] });
    insertStageState(fixture, "pdf-only", "score", "running");
    expect(stage(snapshot(fixture), "pdf_render", "current_execution").currentExecution).toMatchObject({
      eligible: 1, waiting: 0, unknown: 1,
    });
  });

  it.each([
    ["queued", "waiting"], ["running", "processing"], ["succeeded", "succeeded"], ["failed", "failed"],
  ])("keeps the recorded PDF %s state authoritative over pending prerequisites", (state, bucket) => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    const member = insertMember(fixture, { key: "pdf-recorded", requiredSteps: ["score", "pdf"] });
    insertStageState(fixture, "pdf-recorded", "score", "pending");
    insertStep(fixture, { stepKind: "pdf_render", itemKey: pdfItemKey(member.preparationWorkflowId), state });
    expect(stage(snapshot(fixture), "pdf_render", "current_execution").currentExecution).toMatchObject({
      eligible: 1, [bucket]: 1, unknown: 0,
    });
  });

  it("settles conditionally unexecuted PDFs from exact successful preparation results in both cohorts", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    insertStep(fixture, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });
    for (const cohort of ["observed_this_run", "existing_backlog"] as const) {
      const key = `pdf-skipped-${cohort}`;
      const member = insertMember(fixture, { key, cohort, requiredSteps: ["score", "tailor", "cover", "pdf"] });
      insertStageState(fixture, key, "score", "succeeded");
      insertStageState(fixture, key, "tailor", "skipped");
      insertStageState(fixture, key, "cover", "skipped");
      insertWorkflowProjection(fixture, member.preparationWorkflowId, "succeeded", PREPARATION_RUN_ID);
      insertPreparationOutcomeObservation(fixture, member);
    }
    const result = snapshot(fixture);
    expect(result.execution).toMatchObject({
      phase: "completed", currentExecution: { terminal: 1, remaining: 0 },
      sweptExistingBacklog: { terminal: 1, remaining: 0 },
    });
    expect(stage(result, "pdf_render", "current_execution").currentExecution).toMatchObject({
      eligible: 1, skipped: 1, succeeded: 0, waiting: 0, unknown: 0,
    });
    expect(stage(result, "pdf_render", "execution_sweep").existingBacklog).toMatchObject({
      kind: "domain_jobs", counts: { eligible: 1, skipped: 1, succeeded: 0, unknown: 0 },
    });
    expect(fixture.db.prepare("SELECT count(*) AS n FROM pipeline_step_projections WHERE step_kind = 'pdf_render'").get()).toEqual({ n: 0 });
    expect(fixture.db.prepare("SELECT DISTINCT required_steps_json FROM discovery_execution_jobs").all())
      .toEqual([{ required_steps_json: '["score","tailor","cover","pdf"]' }]);
  });

  it("resolves the complete 20-job cohort with nine material sets, nine threshold skips and two eligibility holds", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    insertStep(fixture, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });
    insertHeartbeat(fixture, { activeSlots: 0, counts: {}, details: [] });
    for (let index = 0; index < 18; index += 1) {
      const key = `complete-policy-cohort-${index}`;
      const member = insertMember(fixture, { key, requiredSteps: ["score", "tailor", "cover", "pdf"] });
      for (const stageName of ["enrich", "score", "tailor", "cover"]) {
        insertStageState(fixture, key, stageName, index < 9 || stageName === "score" || stageName === "enrich" ? "succeeded" : "skipped");
      }
      insertWorkflowProjection(fixture, member.preparationWorkflowId, "succeeded", PREPARATION_RUN_ID);
      if (index < 9) insertStep(fixture, { stepKind: "pdf_render", itemKey: pdfItemKey(member.preparationWorkflowId), state: "succeeded" });
      else insertPreparationOutcomeObservation(fixture, member);
    }
    for (let index = 0; index < 2; index += 1) insertEligibilityHold(fixture, `complete-eligibility-${index}`);
    insertReadyRecoveryCheckpoints(fixture);
    const before = fixture.db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    const stateBefore = fixture.db.prepare("SELECT * FROM job_stage_states ORDER BY job_id, stage").all();
    const planBefore = fixture.db.prepare("SELECT * FROM discovery_execution_jobs ORDER BY job_id").all();
    const result = snapshot(fixture);
    expect(result.execution).toMatchObject({ phase: "completed", currentExecution: { members: 20, terminal: 20, remaining: 0 } });
    for (const stageName of ["tailor", "cover"]) {
      const row = stage(result, stageName, "current_execution");
      expect(row.currentExecution).toMatchObject({ succeeded: 9, skipped: 9, blocked: 2, waiting: 0, unknown: 0 });
      expect(row.eta).toMatchObject({ status: "unavailable", reason: "no_work" });
    }
    expect(result.overallEta).toMatchObject({ status: "unavailable", reason: "no_work" });
    expect(stage(result, "pdf_render", "current_execution").currentExecution).toMatchObject({ succeeded: 9, skipped: 11, unknown: 0 });
    expect(fixture.db.prepare("SELECT * FROM job_stage_states ORDER BY job_id, stage").all()).toEqual(stateBefore);
    expect(fixture.db.prepare("SELECT * FROM discovery_execution_jobs ORDER BY job_id").all()).toEqual(planBefore);
    expect(fixture.db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()).toEqual(before);
  });

  it.each(["observed_this_run", "existing_backlog"] as const)("resolves an exact eligibility hold in the %s cohort", (cohort) => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    insertStep(fixture, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });
    insertEligibilityHold(fixture, "single-eligibility", cohort);
    insertHeartbeat(fixture, { activeSlots: 0, counts: {}, details: [] });
    const result = snapshot(fixture);
    const summary = cohort === "observed_this_run" ? result.execution?.currentExecution : result.execution?.sweptExistingBacklog;
    expect(summary).toMatchObject({ terminal: 1, remaining: 0 });
    expect(result.execution?.phase).toBe("completed");
    expect(stage(result, "tailor", cohort === "observed_this_run" ? "current_execution" : "execution_sweep").eta)
      .toMatchObject({ status: "unavailable", reason: "no_work" });
  });

  it.each(["cached score", "rescore", "no planned PDF"])("keeps canonical eligibility completion valid with %s", (variation) => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    insertStep(fixture, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });
    insertEligibilityHold(fixture, "eligibility-score-reuse");
    if (variation === "cached score") fixture.db.prepare("UPDATE job_stage_states SET metadata_json = json_set(metadata_json, '$.priorScoreVersion', 1) WHERE stage = 'score'").run();
    if (variation === "rescore") fixture.db.prepare("UPDATE job_stage_states SET metadata_json = json_set(metadata_json, '$.rescore', json('true')) WHERE stage = 'score'").run();
    if (variation === "no planned PDF") {
      const plan = JSON.stringify(["score", "tailor", "cover"]);
      fixture.db.prepare("UPDATE discovery_execution_jobs SET required_steps_json = ?").run(plan);
      fixture.db.prepare("UPDATE job_events SET payload_json = json_set(payload_json, '$.requiredSteps', json(?))").run(plan);
    }
    expect(snapshot(fixture).execution).toMatchObject({ phase: "completed", currentExecution: { terminal: 1, remaining: 0 } });
  });

  it("preserves an actually queued PDF after a valid eligibility hold", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    insertStep(fixture, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });
    const member = insertEligibilityHold(fixture, "eligibility-recorded-pdf");
    insertStep(fixture, { stepKind: "pdf_render", itemKey: pdfItemKey(member.preparationWorkflowId), state: "queued" });
    const result = snapshot(fixture);
    expect(result.execution).toMatchObject({ phase: "draining", currentExecution: { terminal: 0, remaining: 1 } });
    expect(stage(result, "pdf_render", "current_execution").currentExecution).toMatchObject({ waiting: 1, skipped: 0 });
  });

  it.each([
    "missing receipt", "foreign receipt run", "replacement owner", "wrong score owner", "missing accepted score",
    "newer accepted score", "different score version", "cleared eligibility", "score staleness", "generic block",
    "retryable block", "missing gate provenance", "different gate blockers", "refreshed cover", "pending score",
  ])("keeps an eligibility-like row unresolved with %s", (fault) => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    insertStep(fixture, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });
    const member = insertEligibilityHold(fixture, "invalid-eligibility");
    if (fault === "missing receipt") fixture.db.prepare("DELETE FROM job_events").run();
    if (fault === "foreign receipt run") fixture.db.prepare("UPDATE job_events SET payload_json = json_set(payload_json, '$.temporalRunId', 'other-run')").run();
    if (fault === "replacement owner") fixture.db.prepare("UPDATE workflow_run_projections SET temporal_run_id = 'replacement-run' WHERE workflow_id = ?").run(member.preparationWorkflowId);
    if (fault === "wrong score owner") fixture.db.prepare("UPDATE job_stage_states SET metadata_json = json_set(metadata_json, '$.activityOwner', 'other-run') WHERE stage = 'score'").run();
    if (fault === "missing accepted score") fixture.db.prepare("DELETE FROM job_scores").run();
    if (fault === "newer accepted score") fixture.db.prepare("UPDATE job_scores SET scored_at = ?").run(NOW.toISOString());
    if (fault === "different score version") fixture.db.prepare("UPDATE job_scores SET version = 3").run();
    if (fault === "cleared eligibility") fixture.db.prepare("UPDATE job_scores SET breakdown_json = ?").run(JSON.stringify({ eligibility: { status: "eligible", hard_blockers: [] } }));
    if (fault === "score staleness") fixture.db.prepare("INSERT INTO job_score_staleness (tenant_id,job_id,stale_reason,old_policy_version,new_policy_version,marked_at,resolved) VALUES ('local',?,'synthetic',1,2,?,0)").run(member.jobId, NOW.toISOString());
    if (fault === "generic block") fixture.db.prepare("UPDATE job_stage_states SET error_code = 'SETUP_REQUIRED' WHERE stage = 'tailor'").run();
    if (fault === "retryable block") fixture.db.prepare("UPDATE job_stage_states SET retryable = 1 WHERE stage = 'tailor'").run();
    if (fault === "missing gate provenance") fixture.db.prepare("UPDATE job_stage_states SET metadata_json = '{}' WHERE stage = 'tailor'").run();
    if (fault === "different gate blockers") fixture.db.prepare("UPDATE job_stage_states SET metadata_json = json_set(metadata_json, '$.hard_blockers', json(?)) WHERE stage = 'cover'").run(JSON.stringify(["another canonical blocker"]));
    if (fault === "refreshed cover") fixture.db.prepare("UPDATE job_stage_states SET state = 'pending' WHERE stage = 'cover'").run();
    if (fault === "pending score") fixture.db.prepare("UPDATE job_stage_states SET state = 'pending' WHERE stage = 'score'").run();
    const result = snapshot(fixture);
    expect(result.execution?.currentExecution).toMatchObject({ terminal: 0, remaining: 1 });
    expect(result.execution?.phase).toBe("draining");
  });

  it("does not reserve ETA contention for valid held sweep members while current scoring continues", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    insertStep(fixture, { stepKind: "preparation_fanout", itemKey: "terminal", state: "succeeded" });
    insertMember(fixture, { key: "active-score-with-held-sweep", requiredSteps: ["score"] });
    insertStageState(fixture, "active-score-with-held-sweep", "enrich", "succeeded");
    insertStageState(fixture, "active-score-with-held-sweep", "score", "pending");
    insertEligibilityHold(fixture, "held-sweep-contention", "existing_backlog");
    for (let index = 0; index < 5; index += 1) {
      insertStageState(fixture, `eligibility-history-${index}`, "score", "succeeded", 60_000, new Date(NOW.getTime() - index * 60_000).toISOString());
    }
    insertHeartbeat(fixture, {
      activeSlots: 1, counts: { score_job: 1 },
      details: [activityDetail("score_job", "op_000000000000000000000031", unmatchedWorkflowRef("active-eligibility-score"))],
    });
    const result = snapshot(fixture);
    expect(result.execution?.sweptExistingBacklog).toMatchObject({ terminal: 1, remaining: 0 });
    expect(stage(result, "score", "current_execution").eta).toMatchObject({ status: "available", caveat: null });
    expect(result.overallEta).toMatchObject({ status: "available", caveat: null });
  });

  it("does not infer a conditional PDF skip from current MIN_SCORE-like rows without an exact outcome receipt", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    const member = insertMember(fixture, { key: "pdf-no-outcome", requiredSteps: ["score", "tailor", "cover", "pdf"] });
    insertStageState(fixture, "pdf-no-outcome", "score", "succeeded");
    insertStageState(fixture, "pdf-no-outcome", "tailor", "skipped");
    insertStageState(fixture, "pdf-no-outcome", "cover", "skipped");
    insertWorkflowProjection(fixture, member.preparationWorkflowId, "succeeded", PREPARATION_RUN_ID);
    const result = snapshot(fixture);
    expect(stage(result, "pdf_render", "current_execution").currentExecution).toMatchObject({ skipped: 0, unknown: 1 });
    expect(result.execution?.currentExecution).toMatchObject({ terminal: 0, remaining: 1 });
  });

  it.each(["in_progress", "failed", "canceled", "timed_out", "terminated"])("rejects conditional PDF receipts while the current preparation owner is %s", (status) => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    const member = insertMember(fixture, { key: "pdf-owner-outcome", requiredSteps: ["score", "tailor", "cover", "pdf"] });
    insertWorkflowProjection(fixture, member.preparationWorkflowId, status, PREPARATION_RUN_ID);
    insertPreparationOutcomeObservation(fixture, member);
    expect(stage(snapshot(fixture), "pdf_render", "current_execution").currentExecution).toMatchObject({ skipped: 0, unknown: 1 });
  });

  it.each([
    ["decoder", { decoderVersion: 2 }],
    ["evidence", { evidenceKind: "request_intent" }],
    ["tenant", { tenantId: "other" }],
    ["workflow type", { workflowType: "ApplyWorkflow" }],
    ["workflow", { workflowId: "prep-other" }],
    ["run", { temporalRunId: "other-run" }],
    ["job", { jobId: "other-job" }],
    ["key", { idempotencyKey: "other-key" }],
    ["plan", { requiredSteps: ["score", "pdf"] }],
    ["discovery", { discoveryExecution: { tenantId: "local", workflowId: DISCOVER_WORKFLOW_ID, temporalRunId: "old-run" } }],
    ["terminal event", { terminalHistoryEventId: 0 }],
    ["failed result", { result: { stepsCompleted: ["score"], stepsSkipped: ["tailor"], stepsFailed: ["cover"], failure: "failed", errorCode: "failed" } }],
    ["unrelated skip", { result: { stepsCompleted: ["score"], stepsSkipped: ["apply"], stepsFailed: [], failure: null, errorCode: null } }],
    ["out-of-order result", { result: { stepsCompleted: ["cover"], stepsSkipped: ["tailor"], stepsFailed: [], failure: null, errorCode: null } }],
    ["no skip", { result: { stepsCompleted: ["score", "tailor", "cover", "pdf"], stepsSkipped: [], stepsFailed: [], failure: null, errorCode: null } }],
  ] as const)("keeps a missing PDF unknown for a foreign or invalid %s receipt", (_name, override) => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    const member = insertMember(fixture, { key: "pdf-invalid-outcome", requiredSteps: ["score", "tailor", "cover", "pdf"] });
    insertWorkflowProjection(fixture, member.preparationWorkflowId, "succeeded", PREPARATION_RUN_ID);
    insertPreparationOutcomeObservation(fixture, member, override);
    expect(stage(snapshot(fixture), "pdf_render", "current_execution").currentExecution).toMatchObject({ skipped: 0, unknown: 1 });
  });

  it.each([
    ["tailor", "score", "cover", "pdf"],
    ["score", "score", "tailor", "pdf"],
  ])("rejects a receipt whose frozen plan has a noncanonical step order (%j)", (...required) => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    const member = insertMember(fixture, { key: "pdf-noncanonical-plan", requiredSteps: required });
    insertWorkflowProjection(fixture, member.preparationWorkflowId, "succeeded", PREPARATION_RUN_ID);
    insertPreparationOutcomeObservation(fixture, member, {
      requiredSteps: required,
      result: { stepsCompleted: [], stepsSkipped: [required[0]], stepsFailed: [], failure: null, errorCode: null },
    });
    const result = snapshot(fixture);
    expect(stage(result, "pdf_render", "current_execution").currentExecution).toMatchObject({ skipped: 0, unknown: 1 });
    expect(result.execution?.currentExecution).toMatchObject({ terminal: 0, remaining: 1 });
  });

  it.each(["missing owner", "missing run", "foreign owner type", "foreign row job", "foreign row owner", "foreign row key", "malformed payload"])("keeps a missing PDF unknown with %s", (fault) => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    const member = insertMember(fixture, { key: "pdf-row-binding", requiredSteps: ["score", "tailor", "cover", "pdf"] });
    if (fault !== "missing owner") {
      insertWorkflowProjection(fixture, member.preparationWorkflowId, "succeeded", fault === "missing run" ? null : PREPARATION_RUN_ID);
    }
    insertPreparationOutcomeObservation(fixture, member);
    if (fault === "foreign owner type") fixture.db.prepare("UPDATE workflow_run_projections SET workflow_type = 'ApplyWorkflow' WHERE workflow_id = ?").run(member.preparationWorkflowId);
    if (fault === "foreign row job") {
      fixture.db.prepare("INSERT INTO jobs (tenant_id, job_id, url) VALUES ('local', ?, ?)")
        .run(jobIdFor("unrelated-outcome"), "https://private.invalid/unrelated-outcome");
      fixture.db.prepare("UPDATE job_events SET job_id = ?").run(jobIdFor("unrelated-outcome"));
    }
    if (fault === "foreign row owner") fixture.db.prepare("UPDATE job_events SET entity_ref = 'prep-other'").run();
    if (fault === "foreign row key") fixture.db.prepare("UPDATE job_events SET idempotency_key = 'unrelated-key'").run();
    if (fault === "malformed payload") fixture.db.prepare("UPDATE job_events SET payload_json = '{'").run();
    expect(stage(snapshot(fixture), "pdf_render", "current_execution").currentExecution).toMatchObject({ skipped: 0, unknown: 1 });
  });

  it("does not expose private observation payload fields in the progress response", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    const member = insertMember(fixture, { key: "pdf-private-outcome", requiredSteps: ["score", "tailor", "cover", "pdf"] });
    insertWorkflowProjection(fixture, member.preparationWorkflowId, "succeeded", PREPARATION_RUN_ID);
    insertPreparationOutcomeObservation(fixture, member, { privateNote: "private-receipt-content-sentinel" });
    const result = snapshot(fixture);
    expect(stage(result, "pdf_render", "current_execution").currentExecution).toMatchObject({ skipped: 1, unknown: 0 });
    expect(JSON.stringify(result)).not.toContain("private-receipt-content-sentinel");
  });

  it.each([
    ["queued", "waiting"], ["running", "processing"], ["succeeded", "succeeded"], ["failed", "failed"],
  ])("keeps recorded PDF %s authoritative over a conditional outcome receipt", (state, bucket) => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    const member = insertMember(fixture, { key: "pdf-observed-outcome", requiredSteps: ["score", "tailor", "cover", "pdf"] });
    insertWorkflowProjection(fixture, member.preparationWorkflowId, "succeeded", PREPARATION_RUN_ID);
    insertPreparationOutcomeObservation(fixture, member);
    insertStep(fixture, { stepKind: "pdf_render", itemKey: pdfItemKey(member.preparationWorkflowId), state });
    expect(stage(snapshot(fixture), "pdf_render", "current_execution").currentExecution).toMatchObject({ skipped: 0, [bucket]: 1, unknown: 0 });
  });

  it("keeps refreshed pending prerequisite work unresolved even when the prior owner skipped PDF", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "succeeded" });
    const member = insertMember(fixture, { key: "pdf-reset-prerequisite", requiredSteps: ["score", "tailor", "cover", "pdf"] });
    insertStageState(fixture, "pdf-reset-prerequisite", "score", "succeeded");
    insertStageState(fixture, "pdf-reset-prerequisite", "tailor", "pending");
    insertStageState(fixture, "pdf-reset-prerequisite", "cover", "skipped");
    insertWorkflowProjection(fixture, member.preparationWorkflowId, "succeeded", PREPARATION_RUN_ID);
    insertPreparationOutcomeObservation(fixture, member);
    const result = snapshot(fixture);
    expect(result.execution?.currentExecution).toMatchObject({ terminal: 0, remaining: 1 });
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
    insertStageState(fixture, "eta-current", "enrich", "succeeded");
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

  it("does not report no work when a legacy active execution has runtime work but no lineage projections", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertHeartbeat(fixture, {
      activeSlots: 4,
      counts: { discovery_source_family: 1, tailor_job: 3 },
      details: [
        activityDetail("discovery_source_family", "op_000000000000000000000021", DISCOVER_WORKFLOW_ID),
        activityDetail("tailor_job", "op_000000000000000000000022", unmatchedWorkflowRef("legacy-tailor-1")),
        activityDetail("tailor_job", "op_000000000000000000000023", unmatchedWorkflowRef("legacy-tailor-2")),
        activityDetail("tailor_job", "op_000000000000000000000024", unmatchedWorkflowRef("legacy-tailor-3")),
      ],
      queueObservation: availableObservation({ activityBacklog: 41 }),
    });

    const result = snapshot(fixture, { autoReadyCheckpoint: false });
    expect(result.execution).toMatchObject({
      phase: "discovering",
      membershipClosed: false,
      currentExecution: { members: 0 },
    });
    expect(result.projectionCoverage).toMatchObject({
      status: "recovering",
      persistedMembershipCount: 0,
      persistedStepCount: 0,
    });
    expect(result.activeStageCounts).toEqual([
      { stage: "source_family", count: 1 },
      { stage: "tailor", count: 3 },
    ]);
    expect(result.activeItemsTotal).toBe(4);
    expect(result.activeItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "unresolved_runtime_activity",
        activityType: "discovery_source_family",
        stage: "source_family",
      }),
      expect.objectContaining({
        kind: "unresolved_runtime_activity",
        activityType: "tailor_job",
        stage: "tailor",
      }),
    ]));
    expect(result.activeItems.filter((item) => item.activityType === "tailor_job")).toHaveLength(3);
    expect(result.overallEta).toMatchObject({ status: "unavailable", reason: "unknown_scope" });
    expectSelectedEtasNotNoWork(result);
  });

  it("does not infer selected-execution gaps or runtime work from unrelated preparation activity", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertMember(fixture, { key: "selected-complete", requiredSteps: ["score"] });
    insertStageState(fixture, "selected-complete", "score", "pending");
    insertStep(fixture, { stepKind: "source_planning", itemKey: "selected-plan", state: "succeeded" });
    const unrelatedWorkflowId = unmatchedWorkflowRef("other-prep");
    insertWorkflowProjection(fixture, unrelatedWorkflowId, "in_progress", PREPARATION_RUN_ID, {
      discoveryExecution: {
        tenantId: "local",
        workflowId: DISCOVER_WORKFLOW_ID,
        temporalRunId: "00000000-0000-4000-8000-000000000099",
      },
      discoveryCohortKind: "observed_this_run",
    });
    insertHeartbeat(fixture, {
      activeSlots: 1,
      counts: { tailor_job: 1 },
      details: [
        activityDetail("tailor_job", "op_000000000000000000000025", unrelatedWorkflowId, PREPARATION_RUN_ID),
      ],
    });

    const result = snapshot(fixture);
    expect(result.projectionCoverage).toMatchObject({ status: "ready" });
    expect(result.activeStageCounts).toEqual([{ stage: "tailor", count: 1 }]);
    expect(stage(result, "tailor", "current_execution").eta).toMatchObject({
      status: "unavailable",
      reason: "no_work",
    });
  });

  it("uses persisted preparation lineage to prove a missing selected membership", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    const preparationWorkflowId = unmatchedWorkflowRef("attributed-prep");
    insertWorkflowProjection(fixture, preparationWorkflowId, "in_progress", PREPARATION_RUN_ID, {
      discoveryExecution: {
        tenantId: "local",
        workflowId: DISCOVER_WORKFLOW_ID,
        temporalRunId: DISCOVER_RUN_ID,
      },
      discoveryCohortKind: "observed_this_run",
    });
    insertHeartbeat(fixture, {
      activeSlots: 1,
      counts: { tailor_job: 1 },
      details: [
        activityDetail("tailor_job", "op_000000000000000000000026", preparationWorkflowId, PREPARATION_RUN_ID),
      ],
    });

    const result = snapshot(fixture, { autoReadyCheckpoint: false });
    expect(result.projectionCoverage).toMatchObject({
      status: "recovering",
      persistedMembershipCount: 0,
      persistedStepCount: 0,
    });
    expectSelectedEtasNotNoWork(result);
  });

  it("keeps projection coverage recovering when runtime scope cannot be resolved", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertHeartbeat(fixture, {
      activeSlots: 1,
      counts: { tailor_job: 1 },
      details: [
        activityDetail("tailor_job", "op_000000000000000000000027", unmatchedWorkflowRef("unresolved-prep")),
      ],
    });

    const result = snapshot(fixture, { autoReadyCheckpoint: false });
    expect(result.projectionCoverage).toMatchObject({
      status: "recovering",
      persistedMembershipCount: 0,
      persistedStepCount: 0,
    });
    expectSelectedEtasNotNoWork(result);
  });

  it.each([
    ["truncated", { counts: { discovery_source_family: 1 }, details: [] }],
    ["unmapped", {
      counts: { derive_preparation_targets: 1 },
      details: [
        activityDetail(
          "derive_preparation_targets",
          "op_000000000000000000000028",
          DISCOVER_WORKFLOW_ID,
        ),
      ],
    }],
  ] as const)("degrades safely for %s runtime detail", (_name, telemetry) => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertHeartbeat(fixture, { activeSlots: 1, ...telemetry, details: [...telemetry.details] });

    const result = snapshot(fixture, { autoReadyCheckpoint: false });
    expect(result.projectionCoverage).toMatchObject({
      status: "recovering",
      persistedMembershipCount: 0,
      persistedStepCount: 0,
    });
    expectSelectedEtasNotNoWork(result);
    if (_name === "unmapped") {
      expect(result.activeStageCounts).toEqual([]);
      expect(result.activeItems).toEqual([
        expect.objectContaining({ kind: "unresolved_runtime_activity", stage: null }),
      ]);
    }
  });

  it("keeps a partial recovery checkpoint restoring instead of treating row counts as complete", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    for (let index = 0; index < 15; index += 1) {
      insertMember(fixture, { key: `partial-${index}`, requiredSteps: ["score"] });
    }
    for (let index = 0; index < 4; index += 1) {
      insertStep(fixture, { stepKind: "source_family", itemKey: `partial-${index}`, state: "succeeded" });
    }
    insertRecoveryCheckpoint(fixture, {
      state: "recovering",
      expectedMembershipCount: 72,
      persistedMembershipCount: 15,
      expectedStepCount: 8,
      persistedStepCount: 4,
    });

    expect(snapshot(fixture, { autoReadyCheckpoint: false }).projectionCoverage).toMatchObject({
      status: "recovering",
      expectedMembershipCount: 72,
      persistedMembershipCount: 15,
      expectedStepCount: 8,
      persistedStepCount: 4,
    });
  });

  it("refuses a source-family ETA while selected-run projection recovery is partial", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    for (let index = 0; index < 5; index += 1) {
      insertStep(fixture, {
        stepKind: "source_family",
        itemKey: `source-history-${index}`,
        state: "succeeded",
      });
    }
    insertStep(fixture, {
      stepKind: "source_family",
      itemKey: "source-still-running",
      state: "running",
    });
    insertRecoveryCheckpoint(fixture, {
      state: "recovering",
      expectedMembershipCount: 72,
      persistedMembershipCount: 0,
      expectedStepCount: 10,
      persistedStepCount: 6,
    });
    insertHeartbeat(fixture, { activeSlots: 0, counts: {}, details: [] });

    expect(snapshot(fixture, { autoReadyCheckpoint: false }).sourceFamilies?.eta).toMatchObject({
      status: "unavailable",
      reason: "unknown_scope",
    });
  });

  it("downgrades a stale ready checkpoint when the exact persisted key digest differs", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertMember(fixture, { key: "digest-mismatch", requiredSteps: ["score"] });
    insertRecoveryCheckpoint(fixture, {
      state: "ready",
      expectedMembershipCount: 1,
      persistedMembershipCount: 1,
      expectedStepCount: 0,
      persistedStepCount: 0,
      keyDigest: "0".repeat(64),
    });

    expect(snapshot(fixture, { autoReadyCheckpoint: false }).projectionCoverage).toMatchObject({
      status: "recovering",
      expectedMembershipCount: 1,
      persistedMembershipCount: 1,
    });
  });

  it("keeps a matching decoder-v1 checkpoint recovering", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertMember(fixture, { key: "legacy-decoder", requiredSteps: [] });
    insertRecoveryCheckpoint(fixture, {
      state: "ready",
      decoderVersion: 1,
      expectedMembershipCount: 1,
      persistedMembershipCount: 1,
      expectedStepCount: 0,
      persistedStepCount: 0,
      keyDigest: recoveryKeyDigest([jobIdFor("legacy-decoder")], []),
    });

    expect(snapshot(fixture, { autoReadyCheckpoint: false }).projectionCoverage).toMatchObject({
      status: "recovering",
      decoderVersion: 1,
      expectedMembershipCount: 1,
      persistedMembershipCount: 1,
      expectedStepCount: 0,
      persistedStepCount: 0,
    });
  });

  it("accepts the cross-runtime non-ASCII recovery digest golden vector", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertMember(fixture, { key: "café", jobUrl: "café", requiredSteps: [] });
    insertMember(fixture, { key: "求人/東京", jobUrl: "求人/東京", requiredSteps: [] });
    insertStep(fixture, {
      stepKind: "source_family",
      itemKey: "família:日本",
      state: "succeeded",
    });
    insertStep(fixture, {
      stepKind: "enrichment_pass",
      itemKey: "étape:😀",
      state: "succeeded",
    });
    insertRecoveryCheckpoint(fixture, {
      state: "ready",
      expectedMembershipCount: 2,
      persistedMembershipCount: 2,
      expectedStepCount: 2,
      persistedStepCount: 2,
      keyDigest: "cf2bd8a207321752da638a0fe9c77bb9c6cb1ac51074454d8335fdc2af1b58b8",
    });

    expect(snapshot(fixture, { autoReadyCheckpoint: false }).projectionCoverage).toMatchObject({
      status: "ready",
      membershipCount: 2,
      stepCount: 2,
    });
  });

  it("reports a retrying checkpoint without exposing runtime telemetry as recovery proof", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertHeartbeat(fixture, {
      activeSlots: 4,
      counts: { tailor_job: 4 },
      details: [
        activityDetail("tailor_job", "op_000000000000000000000031", unmatchedWorkflowRef("one")),
        activityDetail("tailor_job", "op_000000000000000000000032", unmatchedWorkflowRef("two")),
        activityDetail("tailor_job", "op_000000000000000000000033", unmatchedWorkflowRef("three")),
        activityDetail("tailor_job", "op_000000000000000000000034", unmatchedWorkflowRef("four")),
      ],
    });
    insertRecoveryCheckpoint(fixture, {
      state: "retrying",
      expectedMembershipCount: 72,
      persistedMembershipCount: 15,
      expectedStepCount: 8,
      persistedStepCount: 4,
      lastErrorCode: "history-read-transient",
    });

    expect(snapshot(fixture, { autoReadyCheckpoint: false }).projectionCoverage).toMatchObject({
      status: "retrying",
      errorCode: "history-read-transient",
      persistedMembershipCount: 0,
      persistedStepCount: 0,
    });
  });

  it("reports a terminal incomplete checkpoint without pretending recovery will retry", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "failed" });
    insertMember(fixture, { key: "partial-terminal", requiredSteps: [] });
    insertStep(fixture, {
      stepKind: "preparation_fanout",
      itemKey: "terminal-failure",
      state: "failed",
    });
    insertRecoveryCheckpoint(fixture, {
      state: "incomplete",
      expectedMembershipCount: 1,
      persistedMembershipCount: 1,
      expectedStepCount: 1,
      persistedStepCount: 1,
      lastErrorCode: "legacy-fanout-terminal-failed",
    });

    expect(snapshot(fixture, { autoReadyCheckpoint: false }).projectionCoverage).toMatchObject({
      status: "incomplete",
      errorCode: "legacy-fanout-terminal-failed",
      expectedMembershipCount: null,
      persistedMembershipCount: 1,
      expectedStepCount: null,
      persistedStepCount: 1,
    });
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
    insertStageState(fixture, "eta-current-scope", "enrich", "succeeded");
    insertStageState(fixture, "eta-sweep-scope", "enrich", "succeeded");
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

  it("withholds source and current-stage ETAs when sweep demand exceeds spare capacity", () => {
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
      activeSlots: 4,
      counts: { score_job: 4 },
      details: [
        activityDetail("score_job", "op_000000000000000000000018", unmatchedWorkflowRef("cross-stage-1")),
        activityDetail("score_job", "op_000000000000000000000019", unmatchedWorkflowRef("cross-stage-2")),
        activityDetail("score_job", "op_000000000000000000000020", unmatchedWorkflowRef("cross-stage-3")),
        activityDetail("score_job", "op_000000000000000000000021", unmatchedWorkflowRef("cross-stage-4")),
      ],
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

  it("prices source history when one sweep workflow fits spare capacity and global rows stay dormant", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertStep(fixture, { stepKind: "source_planning", itemKey: "global-plan", state: "succeeded", detailCount: 2 });
    insertStep(fixture, { stepKind: "source_family", itemKey: "family:jobspy", state: "running" });
    insertMember(fixture, {
      key: "spare-sweep",
      cohort: "existing_backlog",
      requiredSteps: ["score", "tailor", "cover"],
    });
    insertStageState(fixture, "spare-sweep", "enrich", "succeeded");
    insertStageState(fixture, "spare-sweep", "score", "pending");
    insertStageState(fixture, "spare-sweep", "tailor", "pending");
    insertStageState(fixture, "spare-sweep", "cover", "pending");
    insertStageState(fixture, "global-outside", "score", "pending");
    for (let index = 0; index < 5; index += 1) {
      insertHistoricalStep(fixture, {
        stepKind: "source_family",
        itemKey: `global-source-history-${index}`,
        durationMs: 600_000,
        index,
      });
    }
    fixture.db.prepare(
      `INSERT INTO job_events (
         tenant_id, job_id, identity_version, stage, event_type, level,
         message, occurred_at, payload_json
       ) VALUES ('local', NULL, 1, 'discover', 'StageProgress', 'info', ?, ?, ?)`,
    ).run(
      "current provider progress",
      "2026-07-14T11:59:00.000Z",
      JSON.stringify({
        workflowId: DISCOVER_WORKFLOW_ID,
        discoverRunId: DISCOVER_RUN_ID,
        progress: {
          sourceProgress: {
            providerProgress: {
              site: "linkedin",
              phase: "search",
              unit: "page",
              completedUnits: 39,
              totalUnits: null,
              rawItemsSeen: 390,
              jobsEmitted: 371,
              hasMore: null,
            },
          },
        },
      }),
    );
    insertHeartbeat(fixture, {
      activeSlots: 2,
      counts: { discovery_source_family: 1, discovery_enrichment: 1 },
      details: [
        activityDetail("discovery_source_family", "op_000000000000000000000015", DISCOVER_WORKFLOW_ID),
        activityDetail("discovery_enrichment", "op_000000000000000000000016", DISCOVER_WORKFLOW_ID),
      ],
    });

    const result = snapshot(fixture);
    expect(result.sourceFamilies).toMatchObject({
      counts: { eligible: 2, waiting: 1, processing: 1, unknown: 0 },
      providerProgress: { completedUnits: 39, totalUnits: null },
      eta: {
        status: "available",
        lowSeconds: 1_200,
        highSeconds: 1_260,
        confidence: "low",
        basis: "source_rate",
        sampleSize: 5,
      },
    });
    expect(stage(result, "source_family", "current_execution").eta).toEqual(
      result.sourceFamilies?.eta,
    );
    expect(result.sourceFamilies?.eta).toMatchObject({
      caveat: "Provider total is unavailable; range uses recent whole-family duration and bounded live capacity.",
    });
  });

  it("withholds source history when global job-stage work is queued before telemetry observes it", () => {
    const fixture = createFixture();
    insertExecution(fixture, { status: "in_progress" });
    insertStep(fixture, {
      stepKind: "source_planning",
      itemKey: "queued-global-plan",
      state: "succeeded",
      detailCount: 1,
    });
    insertStep(fixture, {
      stepKind: "source_family",
      itemKey: "queued-global-source",
      state: "running",
    });
    insertStageState(fixture, "queued-global-outside", "score", "queued");
    for (let index = 0; index < 5; index += 1) {
      insertHistoricalStep(fixture, {
        stepKind: "source_family",
        itemKey: `queued-global-source-history-${index}`,
        durationMs: 600_000,
        index,
      });
    }
    insertHeartbeat(fixture, {
      activeSlots: 1,
      counts: { discovery_source_family: 1 },
      details: [
        activityDetail(
          "discovery_source_family",
          "op_000000000000000000000021",
          DISCOVER_WORKFLOW_ID,
        ),
      ],
    });

    const result = snapshot(fixture);
    expect(result.sourceFamilies?.eta).toMatchObject({
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
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  const fixture = { directory, dbPath, configPath, db };
  fixtures.push(fixture);
  return fixture;
}

function snapshot(fixture: Fixture, options: { autoReadyCheckpoint?: boolean } = {}) {
  if (options.autoReadyCheckpoint !== false) insertReadyRecoveryCheckpoints(fixture);
  return PipelineOperationsSnapshotSchema.parse(buildPipelineOperationsSnapshot(fixture.db, {
    dbPath: fixture.dbPath,
    configPath: fixture.configPath,
    now: NOW,
  }));
}

function insertReadyRecoveryCheckpoints(fixture: Fixture): void {
  const executions = fixture.db.prepare(
    `SELECT workflow_id, temporal_run_id FROM workflow_run_projections
      WHERE tenant_id = 'local' AND workflow_type = 'DiscoverWorkflow'
        AND temporal_run_id IS NOT NULL`,
  ).all() as Array<{ workflow_id: string; temporal_run_id: string }>;
  for (const execution of executions) {
    const memberships = (fixture.db.prepare(
    `SELECT job_id FROM discovery_execution_jobs
        WHERE tenant_id = 'local' AND discover_workflow_id = ? AND discover_run_id = ?
        ORDER BY job_id`,
    ).all(execution.workflow_id, execution.temporal_run_id) as Array<{ job_id: string }>)
      .map((row) => row.job_id);
    const steps = (fixture.db.prepare(
      `SELECT step_kind, item_key FROM pipeline_step_projections
        WHERE tenant_id = 'local' AND discover_workflow_id = ? AND discover_run_id = ?
        ORDER BY step_kind, item_key`,
    ).all(execution.workflow_id, execution.temporal_run_id) as Array<{ step_kind: string; item_key: string }>)
      .map((row): [string, string] => [row.step_kind, row.item_key]);
    const keyDigest = recoveryKeyDigest(memberships, steps);
    fixture.db.prepare(
      `INSERT OR REPLACE INTO discovery_execution_recoveries (
         tenant_id, discover_workflow_id, discover_run_id, state, mode,
         decoder_version, history_event_id, expected_membership_count,
         persisted_membership_count, expected_step_count, persisted_step_count,
         key_digest, last_error_code, updated_at
       ) VALUES ('local', ?, ?, 'ready', 'native', 3, 100, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      execution.workflow_id,
      execution.temporal_run_id,
      memberships.length,
      memberships.length,
      steps.length,
      steps.length,
      keyDigest,
      NOW.toISOString(),
    );
  }
}

function insertRecoveryCheckpoint(
  fixture: Fixture,
  input: {
    state: "incomplete" | "recovering" | "ready" | "retrying";
    expectedMembershipCount: number;
    persistedMembershipCount: number;
    expectedStepCount: number;
    persistedStepCount: number;
    decoderVersion?: number;
    keyDigest?: string;
    lastErrorCode?: string | null;
  },
): void {
  fixture.db.prepare(
    `INSERT OR REPLACE INTO discovery_execution_recoveries (
       tenant_id, discover_workflow_id, discover_run_id, state, mode,
       decoder_version, history_event_id, expected_membership_count,
       persisted_membership_count, expected_step_count, persisted_step_count,
       key_digest, last_error_code, updated_at
     ) VALUES ('local', ?, ?, ?, 'reconstructed', ?, 119, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    DISCOVER_WORKFLOW_ID,
    DISCOVER_RUN_ID,
    input.state,
    input.decoderVersion ?? 3,
    input.expectedMembershipCount,
    input.persistedMembershipCount,
    input.expectedStepCount,
    input.persistedStepCount,
    input.keyDigest ?? recoveryKeyDigest([], []),
    input.lastErrorCode ?? null,
    NOW.toISOString(),
  );
}

function recoveryKeyDigest(
  membershipKeys: readonly string[],
  stepKeys: ReadonlyArray<readonly [string, string]>,
): string {
  const memberships = membershipKeys.map((value) => Buffer.from(value, "utf8").toString("hex")).sort();
  const steps = stepKeys
    .map((value) => Buffer.from(JSON.stringify(value), "utf8").toString("hex"))
    .sort();
  return createHash("sha256")
    .update(JSON.stringify({ memberships, steps }))
    .digest("hex");
}

function insertStandalonePreparation(
  fixture: Fixture,
  key: string,
  workflowId = unmatchedWorkflowRef(key),
): { workflowId: string; jobId: string } {
  const jobId = jobIdFor(key);
  fixture.db.prepare(
    "INSERT INTO jobs (tenant_id, job_id, url, title, company) VALUES ('local', ?, ?, 'Standalone role', 'Standalone company')",
  ).run(jobId, `https://private.invalid/${key}`);
  insertWorkflowProjection(fixture, workflowId, "in_progress", PREPARATION_RUN_ID, {
    jobId, privateNote: "private-runtime-input-sentinel",
  });
  return { workflowId, jobId };
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
  inputSummary: Record<string, unknown> = {},
): void {
  fixture.db.prepare(
    `INSERT OR REPLACE INTO workflow_run_projections (
       workflow_id, tenant_id, workflow_type, status, input_summary_json, temporal_run_id, started_at, finished_at
     ) VALUES (?, 'local', 'JobPreparationWorkflow', ?, ?, ?, ?, ?)`,
  ).run(
    workflowId,
    status,
    JSON.stringify(inputSummary),
    runId,
    "2026-07-14T11:00:00.000Z",
    "2026-07-14T11:30:00.000Z",
  );
}

function insertMember(
  fixture: Fixture,
  input: {
    key: string;
    cohort?: "observed_this_run" | "existing_backlog";
    requiredSteps: string[];
    workflowId?: string;
    runId?: string;
    jobUrl?: string;
    jobId?: string;
    title?: string;
    company?: string;
  },
): { preparationWorkflowId: string; jobId: string } {
  const preparationWorkflowId = `prep-preparation:${createHash("sha256").update(input.key).digest("hex")}`;
  const jobId = input.jobId ?? jobIdFor(input.key);
  const jobUrl = input.jobUrl ?? `https://private.invalid/${input.key}`;
  fixture.db.prepare(
    `INSERT INTO jobs (tenant_id, job_id, url, title, company)
     VALUES ('local', ?, ?, ?, ?)`,
  ).run(jobId, jobUrl, input.title ?? null, input.company ?? null);
  fixture.db.prepare(
    `INSERT INTO discovery_execution_jobs (
       tenant_id, discover_workflow_id, discover_run_id, job_id, cohort_kind,
       preparation_workflow_id, work_plan_state, required_steps_json, linked_at
     ) VALUES ('local', ?, ?, ?, ?, ?, 'planned', ?, ?)`,
  ).run(
    input.workflowId ?? DISCOVER_WORKFLOW_ID,
    input.runId ?? DISCOVER_RUN_ID,
    jobId,
    input.cohort ?? "observed_this_run",
    preparationWorkflowId,
    JSON.stringify(input.requiredSteps),
    NOW.toISOString(),
  );
  return { preparationWorkflowId, jobId };
}

function insertPreparationOutcomeObservation(
  fixture: Fixture,
  member: { preparationWorkflowId: string; jobId: string },
  override: Record<string, unknown> = {},
): void {
  const workflowId = member.preparationWorkflowId;
  const payload = {
    tenantId: "local", decoderVersion: 1, evidenceKind: "temporal_history", workflowType: "JobPreparationWorkflow",
    workflowId, temporalRunId: PREPARATION_RUN_ID, jobId: member.jobId,
    idempotencyKey: workflowId.slice("prep-".length), requiredSteps: ["score", "tailor", "cover", "pdf"],
    discoveryExecution: { tenantId: "local", workflowId: DISCOVER_WORKFLOW_ID, temporalRunId: DISCOVER_RUN_ID },
    terminalHistoryEventId: 42,
    result: { stepsCompleted: ["score"], stepsSkipped: ["tailor"], stepsFailed: [], failure: null, errorCode: null },
    ...override,
  };
  fixture.db.prepare(
    `INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message,
        occurred_at, payload_json, entity_kind, entity_ref, idempotency_key)
     VALUES ('local', ?, 1, 'workflow', 'PreparationWorkflowOutcomeObserved', 'info',
        'Preparation outcome observed.', ?, ?, 'workflow_run', ?, ?)`,
  ).run(member.jobId, NOW.toISOString(), JSON.stringify(payload), workflowId,
    `preparation-outcome:1:local:${workflowId}:${PREPARATION_RUN_ID}`);
}

function insertEligibilityHold(
  fixture: Fixture,
  key: string,
  cohort: "observed_this_run" | "existing_backlog" = "observed_this_run",
): { preparationWorkflowId: string; jobId: string } {
  const member = insertMember(fixture, { key, cohort, requiredSteps: ["score", "tailor", "cover", "pdf"] });
  insertWorkflowProjection(fixture, member.preparationWorkflowId, "succeeded", PREPARATION_RUN_ID);
  insertPreparationOutcomeObservation(fixture, member);
  insertStageState(fixture, key, "enrich", "succeeded");
  insertStageState(fixture, key, "score", "succeeded", 60_000, "2026-07-14T11:30:00.000Z");
  fixture.db.prepare("UPDATE job_stage_states SET metadata_json = ? WHERE job_id = ? AND stage = 'score'").run(
    JSON.stringify({ activityOwner: PREPARATION_RUN_ID, priorScoreVersion: 0, rescore: false }), member.jobId,
  );
  const blockers = ["Explicit synthetic eligibility decision"];
  for (const stageName of ["tailor", "cover"]) {
    insertStageState(fixture, key, stageName, "blocked");
    fixture.db.prepare("UPDATE job_stage_states SET error_code = 'SCORE_ELIGIBILITY_BLOCKED', attempt_count = 0, metadata_json = ? WHERE job_id = ? AND stage = ?")
      .run(JSON.stringify({ reason: "score_eligibility_blocked", hard_blockers: blockers }), member.jobId, stageName);
  }
  fixture.db.prepare("INSERT INTO job_scores (tenant_id,job_id,version,fit_score,breakdown_json,keywords_json,scored_at,criteria_json,trace_json) VALUES ('local',?,1,6,?,'[]',?,'{}','{}')")
    .run(member.jobId, JSON.stringify({ eligibility: { status: "blocked", hard_blockers: blockers } }), "2026-07-14T11:29:00.000Z");
  return member;
}

function insertStageState(
  fixture: Fixture,
  key: string,
  stage: string,
  state: string,
  durationMs: number | null = null,
  finishedAt: string | null = null,
  retryable = 0,
  identity: { jobId?: string } = {},
): void {
  const jobId = identity.jobId ?? jobIdFor(key);
  fixture.db.prepare(
    `INSERT OR IGNORE INTO jobs (tenant_id, job_id, url)
     VALUES ('local', ?, ?)`,
  ).run(jobId, `https://private.invalid/${key}`);
  fixture.db.prepare(
    `INSERT INTO job_stage_states (
       tenant_id, job_id, stage, state, attempt_count, max_attempts, updated_at, finished_at, duration_ms, retryable
     ) VALUES ('local', ?, ?, ?, 1, 3, ?, ?, ?, ?)`,
  ).run(jobId, stage, state, NOW.toISOString(), finishedAt, durationMs, retryable);
}

function jobIdFor(key: string): string {
  return `job-${createHash("sha256").update(key).digest("hex")}`;
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

function insertHistoricalStep(
  fixture: Fixture,
  input: { stepKind: string; itemKey: string; durationMs: number; index: number },
): void {
  fixture.db.prepare(
    `INSERT INTO pipeline_step_projections (
       tenant_id, discover_workflow_id, discover_run_id, step_kind, item_key, state, attempt,
       queued_at, started_at, finished_at, duration_ms, retryable, detail_count, last_event_id, last_updated_at
     ) VALUES ('local', ?, ?, ?, ?, 'succeeded', 1, ?, ?, ?, ?, 0, NULL, 0, ?)`,
  ).run(
    `history-workflow-${input.index}`,
    `history-run-${input.index}`,
    input.stepKind,
    input.itemKey,
    "2026-07-14T10:00:00.000Z",
    "2026-07-14T10:00:00.000Z",
    new Date(NOW.getTime() - input.index * 60_000).toISOString(),
    input.durationMs,
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
    job_url_import: "job-url-import",
    enrich: "enrichment",
    render_pdf: "job-pdf-render",
    score_job: "job-scoring",
    tailor_job: "job-tailoring",
    cover_letter: "job-cover-letter",
    score: "scoring-batch",
    tailor: "tailoring-batch",
    cover: "cover-letter-batch",
    discovery_source_family: "discovery-source-family",
    discovery_enrichment: "discovery-enrichment",
    discovery_preparation_fanout: "discovery-preparation-fanout",
    plan_discovery_sources: "discovery-plan",
    derive_preparation_targets: "preparation-targets",
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

function expectSelectedEtasNotNoWork(result: ReturnType<typeof snapshot>): void {
  for (const entry of result.stages.filter(
    (candidate) => candidate.scope === "current_execution" || candidate.scope === "execution_sweep",
  )) {
    expect(entry.eta, `${entry.stage}/${entry.scope}`).not.toMatchObject({
      status: "unavailable",
      reason: "no_work",
    });
  }
}
