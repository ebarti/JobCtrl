import type { PipelineOperationsSnapshot } from "@jobctrl/contracts";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useStageTriggerStore } from "../../contexts/pipeline/stores/stage-trigger-store.js";
import { renderWithProviders } from "../../test/render.js";
import { buildTestPorts } from "../../test/testPorts.js";
import {
  pipelinesCalibratingSnapshot,
  pipelinesCompletedWithIssuesSnapshot,
  pipelinesDiscoveringSnapshot,
  pipelinesFailedHistorySnapshot,
  pipelinesMixedFailureSnapshot,
  pipelinesMultiWorkerCapacitySnapshot,
  pipelinesThreeSourceSixStepSnapshot,
  pipelinesUnavailableTelemetrySnapshot,
} from "./PipelinesView.fixtures.js";
import { PipelinesView } from "./PipelinesView.js";

async function renderPipelineOperations(snapshot: PipelineOperationsSnapshot) {
  const pipelineOperations = vi.fn(async () => snapshot);
  const view = renderWithProviders(<PipelinesView />, {
    ports: buildTestPorts({ api: { pipelineOperations } }),
  });

  await screen.findByRole("heading", { name: "Live pipeline" });
  return { ...view, pipelineOperations };
}

describe("PipelinesView", () => {
  beforeEach(() => {
    window.location.hash = "";
    window.localStorage.removeItem?.("jh:stage-trigger-config");
    useStageTriggerStore.getState().reset();
  });

  it("keeps the Operations read hook at the view-composition boundary", () => {
    const viewSource = fs.readFileSync(
      path.join(process.cwd(), "src/views/pipelines/PipelinesView.tsx"),
      "utf8",
    );

    expect(viewSource).toContain("usePipelineOperationsQuery");
    expect(viewSource).toContain("<RouteWorkspace");
    expect(viewSource).toContain("<InspectorLedger");
    expect(viewSource).toContain("<DisclosureSection");
    expect(viewSource).toContain("<ToolRow");
    expect(viewSource).not.toContain("apiClient");
    expect(viewSource).not.toContain("queryClient");
  });

  it("keeps every pipeline action inside the shared tool row", async () => {
    const user = userEvent.setup();
    await renderPipelineOperations(pipelinesDiscoveringSnapshot);

    const tools = screen.getByRole("group", { name: "Pipeline action tools" });
    expect(tools).toHaveClass("tool-row", "pipelines-workspace__controls");
    expect(
      within(tools).getByRole("heading", { name: "Pipeline actions" }),
    ).toBeInTheDocument();
    expect(
      await within(tools).findByRole("button", { name: "Run Discover" }),
    ).toBeEnabled();
    expect(within(tools).getByLabelText("Limit")).toBeInTheDocument();
    expect(within(tools).getByLabelText("Internal concurrency")).toBeInTheDocument();
    expect(within(tools).getByLabelText("Source")).toBeInTheDocument();
    expect(within(tools).getByLabelText("Dry run")).toBeChecked();

    await user.click(within(tools).getByRole("tab", { name: "Apply" }));

    expect(within(tools).getByLabelText("Minimum score")).toBeInTheDocument();
    expect(within(tools).getByLabelText("Internal concurrency")).toBeInTheDocument();
    expect(within(tools).getByLabelText("Apply model")).toBeInTheDocument();
    expect(within(tools).getByLabelText("Headless browser")).toBeInTheDocument();
    expect(within(tools).getByLabelText("Continuous")).toBeInTheDocument();
    expect(within(tools).queryByLabelText("Source")).not.toBeInTheDocument();
  });

  it("renders current execution as visual stage cards and keeps secondary ledgers collapsed", async () => {
    const user = userEvent.setup();
    await renderPipelineOperations(pipelinesDiscoveringSnapshot);

    const crawl = screen.getByRole("region", { name: "Crawl sources stage" });
    expect(
      within(crawl).getByLabelText("Crawl sources stage summary"),
    ).toBeInTheDocument();
    expect(crawl).toHaveTextContent("Active2");
    expect(crawl).toHaveTextContent("Waiting0");
    expect(crawl).toHaveTextContent("Processing2");
    expect(crawl).toHaveTextContent("Terminal1");
    expect(crawl).toHaveTextContent("Attention0");
    expect(
      within(crawl).getByRole("progressbar", { name: "Stage progress" }),
    ).toHaveAttribute("aria-valuenow", "33");

    expect(
      screen.queryByRole("region", { name: "Execution sweep ledger table" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Backlog and diagnostics/i }));

    const sweep = screen.getByRole("region", {
      name: "Execution sweep ledger table",
    });
    const global = screen.getByRole("region", {
      name: "Global outside execution ledger table",
    });

    expect(sweep).toHaveAttribute("tabindex", "0");
    expect(global).toHaveAttribute("tabindex", "0");
    expect(
      within(sweep).getByRole("table", { name: /execution sweep stage state/i }),
    ).toBeInTheDocument();
    expect(
      within(global).getByRole("table", { name: /global outside execution stage state/i }),
    ).toBeInTheDocument();
    expect(within(global).getAllByText("Global backlog").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("table")).toHaveLength(2);
  });

  it("keeps terminal outcomes honest and exposes every exact stage-state count", async () => {
    const user = userEvent.setup();
    await renderPipelineOperations(pipelinesMixedFailureSnapshot);

    const crawl = screen.getByRole("region", { name: "Crawl sources stage" });
    expect(crawl).toHaveTextContent("Terminal6");
    expect(crawl).not.toHaveTextContent("Done6");
    expect(crawl).toHaveTextContent("Attention3");
    await user.click(
      within(crawl).getByRole("button", { name: /All stage outcomes/i }),
    );
    const outcomes = within(crawl).getByLabelText(
      "Crawl sources current-execution outcome counts",
    );
    expect(outcomes).toHaveTextContent("Eligible8");
    expect(outcomes).toHaveTextContent("Waiting1");
    expect(outcomes).toHaveTextContent("Processing1");
    expect(outcomes).toHaveTextContent("Succeeded2");
    expect(outcomes).toHaveTextContent("Skipped0");
    expect(outcomes).toHaveTextContent("Blocked1");
    expect(outcomes).toHaveTextContent("Failed1");
    expect(outcomes).toHaveTextContent("Exhausted0");
    expect(outcomes).toHaveTextContent("Canceled1");
    expect(outcomes).toHaveTextContent("Needs verification1");
    expect(outcomes).toHaveTextContent("Stale0");
    expect(outcomes).toHaveTextContent("Unknown0");
  });

  it("makes shared worker capacity and active runtime work immediately legible", async () => {
    await renderPipelineOperations(pipelinesMultiWorkerCapacitySnapshot);

    expect(screen.getByRole("region", { name: "Workers online" })).toHaveTextContent(
      "Workers online3",
    );
    expect(
      screen.getByRole("region", { name: "Worker slots in use" }),
    ).toHaveTextContent("Worker slots in use9 of 12");
    expect(screen.getByRole("region", { name: "Active work" })).toHaveTextContent(
      "Active work9",
    );
    expect(screen.getByRole("region", { name: "Crawl sources stage" })).toHaveTextContent(
      "Shared pool · 3 of 12 slots available",
    );
  });

  it("explains missing Temporal history and clearly reports that no work is active", async () => {
    const user = userEvent.setup();
    const pipelineOperations = vi.fn(async () => pipelinesFailedHistorySnapshot);
    const runPipelineStages = vi.fn();
    useStageTriggerStore.getState().setActiveStage("apply");
    renderWithProviders(<PipelinesView />, {
      ports: buildTestPorts({ api: { pipelineOperations, runPipelineStages } }),
    });
    await screen.findByRole("heading", { name: "Live pipeline" });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Previous discovery history is unavailable");
    expect(alert).toHaveTextContent("No work is running");
    expect(alert).toHaveTextContent("Start Discover again below");
    expect(alert).toHaveTextContent("survive normal app restarts");
    const restart = within(alert).getByRole("link", {
      name: "Set up a new Discover run",
    });
    expect(restart).toHaveAttribute(
      "href",
      "#pipeline-actions",
    );
    const tools = screen.getByRole("group", { name: "Pipeline action tools" });
    expect(tools).toHaveAttribute(
      "id",
      "pipeline-actions",
    );
    expect(within(tools).getByRole("tab", { name: "Apply" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await within(tools).findByRole("button", { name: "Run Apply" })).toBeEnabled();
    await user.click(restart);
    expect(runPipelineStages).not.toHaveBeenCalled();
    expect(within(tools).getByRole("tab", { name: "Discover" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await within(tools).findByRole("button", { name: "Run Discover" })).toBeEnabled();
    expect(alert).not.toHaveTextContent("reconciled_not_found");
    expect(screen.getByRole("region", { name: "Active work" })).toHaveTextContent(
      "No active work",
    );
    expect(screen.queryByRole("button", { name: "Stop discovery" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Technical details/i }));
    expect(screen.getAllByText("reconciled_not_found").length).toBeGreaterThan(0);
  });

  it("does not claim a failed execution is idle while active work remains", async () => {
    await renderPipelineOperations({
      ...pipelinesFailedHistorySnapshot,
      activeItemsTotal: 2,
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("2 active work items remain");
    expect(alert).toHaveTextContent("Review active work before restarting discovery");
    expect(alert).not.toHaveTextContent("No work is running");
    expect(
      within(alert).queryByRole("link", { name: "Set up a new Discover run" }),
    ).not.toBeInTheDocument();
  });

  it("states when a failed execution has no trustworthy active-work inventory", async () => {
    await renderPipelineOperations({
      ...pipelinesFailedHistorySnapshot,
      activeItemsTotal: null,
      activeItemsTruncated: null,
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("runtime inventory is unavailable");
    expect(alert).toHaveTextContent("cannot confirm whether work remains active");
    expect(alert).not.toHaveTextContent("No work is running");
    expect(
      within(alert).queryByRole("link", { name: "Set up a new Discover run" }),
    ).not.toBeInTheDocument();
  });

  it("explains retry-exhausted source work and offers a safe new-run setup", async () => {
    const user = userEvent.setup();
    const pipelineOperations = vi.fn(async () => ({
      ...pipelinesCompletedWithIssuesSnapshot,
      activeItemsTotal: 0,
      activeItemsTruncated: false,
    }));
    const runPipelineStages = vi.fn();
    useStageTriggerStore.getState().setActiveStage("apply");
    renderWithProviders(<PipelinesView />, {
      ports: buildTestPorts({ api: { pipelineOperations, runPipelineStages } }),
    });
    await screen.findByRole("heading", { name: "Live pipeline" });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Discovery completed with source issues");
    expect(alert).toHaveTextContent("exhausted their automatic retries");
    expect(alert).toHaveTextContent("exact stage outcomes");
    expect(alert).not.toHaveTextContent("source_retry_exhausted");

    const restart = within(alert).getByRole("link", {
      name: "Set up a new Discover run",
    });
    await user.click(restart);
    expect(runPipelineStages).not.toHaveBeenCalled();
    expect(
      screen.getByRole("tab", { name: "Discover" }),
    ).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("button", { name: /Technical details/i }));
    expect(screen.getAllByText("source_retry_exhausted").length).toBeGreaterThan(0);
  });

  it("lets the user stop the currently active discovery by its workflow id", async () => {
    const user = userEvent.setup();
    const cancelWorkflowRun = vi.fn(async (runId: string) => ({
      ok: true as const,
      runId,
      actionId: runId,
      action: "cancel" as const,
      status: "cancel_requested",
      jobKey: "pipeline",
      command: { action: "cancel" as const, jobKey: "pipeline", runId },
    }));
    const pipelineOperations = vi.fn(async () => pipelinesDiscoveringSnapshot);
    renderWithProviders(<PipelinesView />, {
      ports: buildTestPorts({ api: { cancelWorkflowRun, pipelineOperations } }),
    });

    await screen.findByRole("heading", { name: "Live pipeline" });
    await user.click(screen.getByRole("button", { name: "Stop discovery" }));

    expect(cancelWorkflowRun).toHaveBeenCalledWith("discover-local");
  });

  it("does not offer Stop for a closed workflow that still projects a draining phase", async () => {
    await renderPipelineOperations({
      ...pipelinesDiscoveringSnapshot,
      execution: {
        ...pipelinesDiscoveringSnapshot.execution!,
        workflowStatus: "succeeded",
        phase: "draining",
      },
    });

    expect(screen.queryByRole("button", { name: "Stop discovery" })).not.toBeInTheDocument();
  });

  it("keeps source-family progress separate from exactly two reconciliation ledgers", async () => {
    await renderPipelineOperations(pipelinesThreeSourceSixStepSnapshot);

    const sourceHeading = screen.getByRole("heading", {
      name: "Source families and reconciliation",
    });
    const sourceLedger =
      sourceHeading.closest<HTMLElement>(".pipeline-source-ledger");
    if (!sourceLedger) throw new Error("Expected source and reconciliation ledger.");

    expect(sourceLedger).toHaveTextContent("3/3 succeeded");
    expect(
      within(sourceLedger).getByRole("progressbar", {
        name: "Source-family progress",
      }),
    ).toHaveAttribute("aria-valuenow", "100");
    expect(sourceLedger).toHaveTextContent("Exactly two post-source operations");
    expect(sourceLedger).toHaveTextContent("Enrichment pass");
    expect(sourceLedger).toHaveTextContent("Preparation fanout");
    expect(sourceLedger).toHaveTextContent("2 steps");
  });

  it("announces only the stable phase while keeping calibration provenance inspectable", async () => {
    const { container } = await renderPipelineOperations(
      pipelinesCalibratingSnapshot,
    );

    const liveMessage = container.querySelector(".pipeline-phase-message");
    if (!liveMessage) throw new Error("Expected the compact phase message.");

    expect(liveMessage).toHaveAttribute("aria-live", "polite");
    expect(liveMessage).toHaveTextContent("Discovering");
    expect(liveMessage).not.toHaveTextContent("Calibrating");
    expect(screen.getAllByText(/Calibrating · 2\/8/).length).toBeGreaterThan(0);
  });

  it("exposes queue, capacity, and ETA provenance from a stage disclosure", async () => {
    const user = userEvent.setup();
    await renderPipelineOperations(pipelinesDiscoveringSnapshot);

    await user.click(screen.getByRole("button", { name: /Backlog and diagnostics/i }));
    const trigger = screen.getByRole("button", {
      name: /Inspect Score — Execution sweep/i,
    });
    const disclosure = trigger.closest<HTMLElement>(".pipeline-stage-details");
    if (!disclosure) throw new Error("Expected the Score stage disclosure.");

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const activityQueue = within(disclosure).getByRole("region", {
      name: "Activity task queue",
    });
    const eta = within(disclosure).getByLabelText("Score ETA facts");
    const capacity = within(disclosure).getByRole("region", {
      name: "Worker capacity facts",
    });

    expect(activityQueue).toHaveTextContent("Approximate backlog2");
    expect(activityQueue).toHaveTextContent("Approximate backlog age18 sec");
    expect(activityQueue).toHaveTextContent("Add rate0.4/sec");
    expect(activityQueue).toHaveTextContent("Dispatch rate0.5/sec");
    expect(capacity).toHaveTextContent("Configured slots4");
    expect(capacity).toHaveTextContent("Active slots2");
    expect(capacity).toHaveTextContent("Available slots2");
    expect(capacity).toHaveTextContent("Internal concurrency2");
    expect(eta).toHaveTextContent("ConfidenceMedium");
    expect(eta).toHaveTextContent("BasisStage throughput");
    expect(eta).toHaveTextContent(
      "Estimate excludes unrelated backlog outside this discovery run.",
    );
  });

  it("labels unavailable telemetry without inventing a numeric ETA", async () => {
    await renderPipelineOperations(pipelinesUnavailableTelemetrySnapshot);

    const capacity = screen.getByRole("region", {
      name: "Worker capacity facts",
    });
    const freshness = screen.getByRole("region", {
      name: "Read-model freshness",
    });

    expect(capacity).toHaveTextContent("Unavailable");
    expect(capacity).toHaveTextContent("No worker runtime telemetry");
    expect(freshness).toHaveTextContent("Unavailable");
    expect(screen.queryByText(/estimate:.*min/i)).not.toBeInTheDocument();
  });

  it("reports active inventory truth and multi-worker internal concurrency", async () => {
    await renderPipelineOperations(pipelinesMultiWorkerCapacitySnapshot);

    const activeWorkHeading = screen.getByRole("heading", { name: "Active work" });
    const activeWork = activeWorkHeading.closest<HTMLElement>(".configuration-section");
    const capacity = screen.getByRole("region", {
      name: "Worker capacity facts",
    });
    if (!activeWork) throw new Error("Expected active-work disclosure.");

    expect(activeWork).toHaveTextContent("Inventory total9");
    expect(activeWork).toHaveTextContent("Inventory truncatedYes");
    expect(
      within(activeWork).getAllByText("Staff Platform Engineer").length,
    ).toBeGreaterThan(0);
    expect(within(activeWork).getAllByText("activity-opaque-17").length).toBeGreaterThan(0);
    expect(capacity).toHaveTextContent("Fresh workers3");
    expect(capacity).toHaveTextContent("Configured slots12");
    expect(capacity).toHaveTextContent("Active slots9");
    expect(capacity).toHaveTextContent("Available slots3");
    expect(capacity).toHaveTextContent("Internal concurrency3");
  });

  it("withholds URL-shaped job keys from active-work provenance", async () => {
    const sensitiveJobKey = "https://jobs.example.test/private/123";
    await renderPipelineOperations({
      ...pipelinesDiscoveringSnapshot,
      activeItems: [
        {
          kind: "resolved_job",
          activityType: "score_job",
          workflowId: "prep-opaque",
          executionId: "run-opaque",
          attempt: 1,
          startedAt: "2026-07-14T11:59:00.000Z",
          jobKey: sensitiveJobKey,
          title: "Private role",
          company: "Private employer",
          stage: "score",
        },
      ],
      activeItemsTotal: 1,
      activeItemsTruncated: false,
    });

    expect(screen.queryByText(sensitiveJobKey)).not.toBeInTheDocument();
    expect(
      screen.getAllByText("Sensitive identifier withheld").length,
    ).toBeGreaterThan(0);
  });

  it("keeps pipeline actions available when the operations read fails", async () => {
    const pipelineOperations = vi.fn(async () => {
      throw new Error("Operations snapshot failed.");
    });
    renderWithProviders(<PipelinesView />, {
      ports: buildTestPorts({ api: { pipelineOperations } }),
    });

    const errorTitle = await screen.findByText("Pipeline operations unavailable");
    const operationsAlert = errorTitle.closest<HTMLElement>("[role='alert']");
    if (!operationsAlert) throw new Error("Expected operations error alert.");
    expect(operationsAlert).toHaveTextContent("Operations snapshot failed.");
    const tools = screen.getByRole("group", { name: "Pipeline action tools" });
    expect(within(tools).getByRole("button", { name: "Run Discover" })).toBeEnabled();
  });

  it("does not show secondary discovery navigation inside pipeline actions", async () => {
    await renderPipelineOperations(pipelinesDiscoveringSnapshot);

    expect(
      screen.queryByRole("heading", { name: "Discovery" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open Discovery" }),
    ).not.toBeInTheDocument();
  });
});
