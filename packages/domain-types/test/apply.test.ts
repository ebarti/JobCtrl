/**
 * Phase 8 / S-28: TypeScript ApplyRun + apply value objects.
 */

import { describe, it, expect } from "vitest";
import { LOCAL_TENANT } from "../src/tenant.js";
import { generateJobId } from "../src/identifiers.js";
import {
  APPLY_RUN_STATUSES,
  APPLY_RUN_TERMINAL_STATUSES,
  APPLY_RUN_EVENT_LEVELS,
  SUBMISSION_RESULT_KINDS,
  createApplyRunId,
  isApplyRunStatus,
  type ApplyPrompt,
  type ApplyRun,
  type ApplyRunEvent,
  type ApplyRunId,
  type ApplyRunStatus,
  type AppliedResult,
  type BrowserWorkerConfig,
  type CaptchaResult,
  type DryRunCompleteResult,
  type ExpiredResult,
  type FailedResult,
  type LoginIssueResult,
  type ManualResult,
  type SubmissionResult,
  type TokenUsage,
} from "../src/apply/index.js";

describe("Apply types", () => {
  it("ApplyRunStatus covers the §4.6 lifecycle", () => {
    expect(APPLY_RUN_STATUSES).toEqual([
      "starting",
      "in_progress",
      "succeeded",
      "failed",
      "captcha",
      "login_issue",
      "expired",
      "manual",
      "dry_run_complete",
    ]);
  });

  it("APPLY_RUN_TERMINAL_STATUSES excludes the two non-terminal states", () => {
    expect(APPLY_RUN_TERMINAL_STATUSES).not.toContain("starting");
    expect(APPLY_RUN_TERMINAL_STATUSES).not.toContain("in_progress");
    expect(APPLY_RUN_TERMINAL_STATUSES).toHaveLength(7);
  });

  it("SUBMISSION_RESULT_KINDS lists the seven §4.6 variants", () => {
    expect(SUBMISSION_RESULT_KINDS).toEqual([
      "applied",
      "failed",
      "captcha",
      "login_issue",
      "expired",
      "manual",
      "dry_run_complete",
    ]);
  });

  it("APPLY_RUN_EVENT_LEVELS covers the four levels", () => {
    expect(APPLY_RUN_EVENT_LEVELS).toEqual(["info", "warn", "error", "debug"]);
  });

  it("createApplyRunId rejects empty strings", () => {
    expect(() => createApplyRunId("")).toThrow(/non-empty/);
    const id = createApplyRunId("abc");
    expect(id).toBe("abc");
  });

  it("isApplyRunStatus narrows correctly", () => {
    expect(isApplyRunStatus("succeeded")).toBe(true);
    expect(isApplyRunStatus("not-a-status")).toBe(false);
    expect(isApplyRunStatus(42)).toBe(false);
  });

  it("a fully specified ApplyRun is structurally constructable", () => {
    const tokenUsage: TokenUsage = {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheCreate: 0,
      costUsd: 0.012,
    };
    const event: ApplyRunEvent = {
      eventId: 1,
      eventType: "AssistantText",
      level: "info",
      message: "started",
      payload: { textChars: 7 },
      occurredAt: "2026-05-01T00:00:00+00:00",
    };
    const config: BrowserWorkerConfig = {
      workerId: 0,
      cdpPort: 9222,
      headless: false,
      userDataDir: null,
    };
    const prompt: ApplyPrompt = {
      text: "hello",
      mcpConfig: { playwright: { port: 9222 } },
    };
    const result: AppliedResult = {
      kind: "applied",
      appliedAt: "2026-05-01T00:01:00+00:00",
      verificationConfidence: 0.95,
    };
    const status: ApplyRunStatus = "succeeded";
    const runId: ApplyRunId = createApplyRunId("run-123");
    const run: ApplyRun = {
      tenantId: LOCAL_TENANT,
      runId,
      jobId: generateJobId(),
      status,
      startedAt: "2026-05-01T00:00:00+00:00",
      finishedAt: "2026-05-01T00:01:00+00:00",
      submissionResult: result,
      events: [event],
      tokenUsage,
      dryRun: false,
      headless: false,
      attempts: 1,
      model: "sonnet",
      workerId: 0,
      durationMs: 60000,
    };
    expect(run.events.length).toBe(1);
    expect(run.submissionResult?.kind).toBe("applied");
    expect(config.cdpPort).toBe(9222);
    expect(prompt.text).toBe("hello");
  });

  it("each SubmissionResult variant carries the expected kind discriminator", () => {
    const variants: SubmissionResult[] = [
      { kind: "applied", appliedAt: "t", verificationConfidence: 1 } satisfies AppliedResult,
      { kind: "failed", error: "x", retryable: true } satisfies FailedResult,
      { kind: "captcha", details: "x" } satisfies CaptchaResult,
      { kind: "login_issue", details: "x" } satisfies LoginIssueResult,
      { kind: "expired" } satisfies ExpiredResult,
      { kind: "manual", reason: "x" } satisfies ManualResult,
      { kind: "dry_run_complete", navigatedTo: "x" } satisfies DryRunCompleteResult,
    ];
    expect(variants.map((v) => v.kind).sort()).toEqual([
      "applied",
      "captcha",
      "dry_run_complete",
      "expired",
      "failed",
      "login_issue",
      "manual",
    ]);
  });
});
