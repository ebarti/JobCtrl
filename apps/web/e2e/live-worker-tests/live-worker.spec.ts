import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const JOB_ID = "abaf847c-43cd-40ad-8dc3-76685694ff29";
const JOB_TITLE = "Director of Platform Engineering";
const EVENT_TYPES = [
  "WorkflowStarted",
  "WorkflowCompleted",
  "WorkflowFailed",
  "StageStarted",
  "StageCompleted",
  "StageFailed",
] as const;

interface RecordedEvent {
  readonly type: string;
  readonly data: {
    readonly jobId?: string;
    readonly tenantId?: string;
    readonly payload?: Record<string, unknown>;
  };
}

interface WorkflowDetail {
  readonly workflowId: string;
  readonly temporalRunId: string | null;
  readonly workflowType: string;
  readonly status: string;
  readonly jobKey: string;
  readonly inputSummary: Record<string, unknown>;
}

async function control(
  pathname: string,
  method = "GET",
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `http://127.0.0.1:${process.env["JOBCTRL_LIVE_WORKER_CONTROL_PORT"]}${pathname}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${process.env["JOBCTRL_LIVE_WORKER_SMOKE_TOKEN"]}`,
      },
    },
  );
  const value = (await response.json()) as Record<string, unknown>;
  expect(response.ok, JSON.stringify(value)).toBe(true);
  return value;
}

async function workflowDetail(workflowId: string): Promise<WorkflowDetail> {
  const response = await fetch(
    `http://127.0.0.1:${process.env["JOBCTRL_E2E_API_PORT"]}/v1/workflow-runs/${encodeURIComponent(workflowId)}`,
  );
  const body = await response.text();
  expect(response.ok, body).toBe(true);
  return JSON.parse(body) as WorkflowDetail;
}

async function startBrowserEventObservation(page: Page): Promise<void> {
  await page.evaluate((eventTypes) => {
    const state = window as typeof window & {
      __liveWorkerEvents?: RecordedEvent[];
      __liveWorkerEventSource?: EventSource;
      __liveWorkerEventSourceReady?: boolean;
    };
    state.__liveWorkerEvents = [];
    const source = new EventSource("/v1/events/stream?tenantId=local");
    state.__liveWorkerEventSource = source;
    source.onopen = () => {
      state.__liveWorkerEventSourceReady = true;
    };
    for (const type of eventTypes) {
      source.addEventListener(type, (event) => {
        const message = event as MessageEvent<string>;
        state.__liveWorkerEvents?.push({
          type,
          data: JSON.parse(message.data) as RecordedEvent["data"],
        });
      });
    }
  }, EVENT_TYPES);
  await page.waitForFunction(() => {
    const state = window as typeof window & {
      __liveWorkerEventSourceReady?: boolean;
    };
    return state.__liveWorkerEventSourceReady === true;
  });
}

async function recordedEvents(page: Page): Promise<RecordedEvent[]> {
  return page.evaluate(() => {
    const state = window as typeof window & {
      __liveWorkerEvents?: RecordedEvent[];
    };
    return state.__liveWorkerEvents ?? [];
  });
}

function temporalExecution(
  output: unknown,
): { workflowId: string; runId: string } | null {
  if (typeof output !== "object" || output === null) return null;
  if (Array.isArray(output)) {
    for (const item of output) {
      const found = temporalExecution(item);
      if (found) return found;
    }
    return null;
  }
  const record = output as Record<string, unknown>;
  if (
    typeof record.workflowId === "string" &&
    typeof record.runId === "string"
  ) {
    return { workflowId: record.workflowId, runId: record.runId };
  }
  for (const value of Object.values(record)) {
    const found = temporalExecution(value);
    if (found) return found;
  }
  return null;
}

test("real cover workflow reaches worker running and terminal state in the browser", async ({
  page,
  context,
}) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/jobs");
  await startBrowserEventObservation(page);

  const row = page
    .locator("table.jobs-data-grid-table tbody tr")
    .filter({ hasText: JOB_TITLE });
  await expect(row).toBeVisible({ timeout: 30_000 });
  const rowActivation = row.getByRole("button", {
    name: new RegExp(`^Open job ${JOB_TITLE}`),
  });
  await rowActivation.focus();
  await rowActivation.press("Enter");

  const drawer = page.getByRole("article", { name: "Job details" });
  const coverStage = drawer
    .locator(".stage-timeline__item")
    .filter({ hasText: "Cover letter" });
  await expect(coverStage).toHaveAttribute("data-stage-state", "pending");
  await drawer.getByRole("button", { name: "More job actions" }).click();

  const dispatchPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/v1/jobs/${JOB_ID}/actions/run-stage`) &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("toolbar", { name: "Job actions" })
    .getByRole("button", { name: "Run current stage", exact: true })
    .click();
  const dispatch = await dispatchPromise;
  expect(dispatch.status()).toBe(202);
  const dispatchBody = (await dispatch.json()) as {
    status?: string;
    workflowId?: string;
    firstExecutionRunId?: string;
    runId?: string;
    jobKey?: string;
    command?: { stage?: string; jobId?: string };
  };
  expect(dispatchBody).toMatchObject({
    status: "queued",
    jobKey: JOB_ID,
    command: { stage: "cover", jobId: JOB_ID },
  });
  expect(dispatchBody.workflowId).toBeTruthy();
  expect(dispatchBody.firstExecutionRunId).toBeTruthy();
  const workflowId = dispatchBody.workflowId!;
  const temporalRunId = dispatchBody.firstExecutionRunId!;

  const pausedState = await control("/state");
  expect(pausedState).toMatchObject({
    workerPaused: true,
    workerResumed: false,
    providerCalls: 0,
  });

  const temporalRaw = execFileSync(
    process.env["JOBCTRL_TEMPORAL_BINARY"] ?? "/opt/homebrew/bin/temporal",
    [
      "--output",
      "json",
      "--address",
      process.env["TEMPORAL_ADDRESS"]!,
      "workflow",
      "describe",
      "--workflow-id",
      workflowId,
      "--run-id",
      temporalRunId,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(temporalExecution(JSON.parse(temporalRaw))).toEqual({
    workflowId,
    runId: temporalRunId,
  });

  const runsPage = await context.newPage();
  await runsPage.goto("/runs");
  await control("/worker/resume", "POST");

  await expect
    .poll(async () => (await control("/state")).providerWaiting, {
      timeout: 60_000,
      message:
        "the real cover activity should reach the fixture provider boundary",
    })
    .toBe(true);

  const runLink = runsPage.getByRole("link", {
    name: `Open workflow ${workflowId} in Temporal Web UI`,
  });
  await expect(runLink).toBeVisible({ timeout: 30_000 });
  const runRow = runLink.locator("xpath=ancestor::tr");
  await expect(runRow.getByText("in progress", { exact: true })).toBeVisible();
  await expect(coverStage).toHaveAttribute("data-stage-state", "running", {
    timeout: 30_000,
  });

  const running = await workflowDetail(workflowId);
  expect(running).toMatchObject({
    workflowId,
    temporalRunId,
    workflowType: "JobPipelineWorkflow",
    status: "in_progress",
    jobKey: JOB_ID,
    inputSummary: { jobId: JOB_ID },
  });
  await expect
    .poll(
      async () =>
        (await recordedEvents(page)).some(
          (event) =>
            event.type === "WorkflowStarted" &&
            event.data.tenantId === "local" &&
            event.data.payload?.workflowId === workflowId &&
            event.data.payload?.temporalRunId === temporalRunId,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);

  await control("/provider/release", "POST");
  await expect(runRow.getByText("succeeded", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(coverStage).toHaveAttribute("data-stage-state", "succeeded", {
    timeout: 60_000,
  });

  const terminal = await workflowDetail(workflowId);
  expect(terminal).toMatchObject({
    workflowId,
    temporalRunId,
    workflowType: "JobPipelineWorkflow",
    status: "succeeded",
    jobKey: JOB_ID,
  });
  await expect
    .poll(
      async () =>
        (await recordedEvents(page)).some(
          (event) =>
            event.type === "WorkflowCompleted" &&
            event.data.tenantId === "local" &&
            event.data.payload?.workflowId === workflowId &&
            event.data.payload?.temporalRunId === temporalRunId,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);

  const finalState = await control("/state");
  expect(finalState).toMatchObject({
    workerPaused: false,
    workerResumed: true,
    providerCalls: 1,
    providerReleased: true,
    unexpectedProviderCalls: 0,
  });

  const events = await recordedEvents(page);
  const evidenceDir = process.env["JOBCTRL_LIVE_WORKER_EVIDENCE_DIR"]!;
  fs.writeFileSync(
    path.join(evidenceDir, "observed-transition.json"),
    JSON.stringify(
      {
        tenantId: "local",
        jobId: JOB_ID,
        workflowId,
        temporalRunId,
        dispatchStatus: dispatchBody.status,
        browserStatuses: ["in_progress", "succeeded"],
        apiStatuses: [running.status, terminal.status],
        eventTypes: events.map((event) => event.type),
        providerCalls: finalState.providerCalls,
        unexpectedProviderCalls: finalState.unexpectedProviderCalls,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await page.screenshot({
    path: path.join(evidenceDir, "browser-terminal.png"),
    fullPage: true,
  });

  await page.evaluate(() => {
    const state = window as typeof window & {
      __liveWorkerEventSource?: EventSource;
    };
    state.__liveWorkerEventSource?.close();
  });
});
