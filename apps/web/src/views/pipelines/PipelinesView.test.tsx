import type { PipelineOperationsSnapshot } from "@jobctrl/contracts";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DemoFeatureFlagAdapter } from "../../demo/ports.js";
import { useStageTriggerStore } from "../../contexts/pipeline/stores/stage-trigger-store.js";
import { renderWithProviders } from "../../test/render.js";
import { buildTestPorts } from "../../test/testPorts.js";
import {
  pipelinesCalibratingSnapshot,
  pipelinesCompletedWithIssuesSnapshot,
  pipelinesDiscoveringSnapshot,
  pipelinesFailedHistorySnapshot,
  pipelinesIdleSnapshot,
  pipelinesIncompleteProjectionSnapshot,
  pipelinesPartialSweepRecoveringSnapshot,
  pipelinesRecoveringProjectionSnapshot,
  pipelinesRetryingProjectionSnapshot,
  pipelinesTerminalRecoveringProjectionSnapshot,
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

function getLivePipelineMetrics() {
  const metrics = screen.getByLabelText("Live pipeline metrics");
  expect(metrics.tagName).toBe("SECTION");
  return metrics;
}

function getLivePipelineMetric(label: string) {
  const labelElement = within(getLivePipelineMetrics()).getByText(label, {
    selector: 'p[data-typography="label"]',
  });
  const metric = labelElement.closest<HTMLElement>(".pipeline-overview-fact");
  if (!metric) throw new Error(`Expected ${label} pipeline metric.`);
  expect(
    metric.querySelector('p[data-typography="metric"]'),
  ).toBeInTheDocument();
  expect(
    metric.querySelector('p[data-typography="metadata"]'),
  ).toBeInTheDocument();
  return metric;
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
    expect(within(tools).getByLabelText("Sources")).toBeInTheDocument();
    expect(within(tools).getByRole("checkbox", { name: "Dry run" })).toBeChecked();

    await user.click(within(tools).getByRole("tab", { name: "Apply" }));

    expect(within(tools).getByLabelText("Minimum score")).toBeInTheDocument();
    expect(within(tools).getByLabelText("Internal concurrency")).toBeInTheDocument();
    expect(within(tools).getByLabelText("Apply model")).toBeInTheDocument();
    expect(within(tools).getByRole("checkbox", { name: "Headless browser" })).toBeInTheDocument();
    expect(within(tools).getByRole("checkbox", { name: "Continuous" })).toBeInTheDocument();
    expect(within(tools).queryByLabelText("Sources")).not.toBeInTheDocument();
  });

  it("renders current execution as status-first stage rows and keeps details collapsed", async () => {
    const user = userEvent.setup();
    await renderPipelineOperations(pipelinesDiscoveringSnapshot);

    const crawl = screen.getByRole("region", { name: "Crawl sources stage" });
    const crawlTrigger = within(crawl).getByRole("button", {
      name: /Crawl sources/i,
    });
    expect(crawlTrigger).toHaveAttribute("aria-expanded", "false");
    expect(crawlTrigger).toHaveTextContent(
      "Source family · 2 running · 0 waiting · 1 finished · 0 attention",
    );
    expect(crawlTrigger).toHaveTextContent("20 min–21 min");
    await user.click(crawlTrigger);
    expect(crawlTrigger).toHaveAttribute("aria-expanded", "true");
    expect(
      within(crawl).getByLabelText("Crawl sources stage summary"),
    ).toBeInTheDocument();
    expect(crawl).toHaveTextContent("Running2");
    expect(crawl).toHaveTextContent("Waiting0");
    expect(crawl).toHaveTextContent("Finished1");
    expect(crawl).toHaveTextContent("Attention0");
    expect(
      within(crawl).getByRole("progressbar", { name: "Stage completion" }),
    ).toHaveAttribute("aria-valuenow", "33");
    expect(
      within(crawl).getByRole("progressbar", { name: "Stage completion" }),
    ).toHaveAttribute("aria-valuetext", "1 of 3 finished");
    expect(crawl).toHaveTextContent("1 of 3 finished");
    expect(crawl).not.toHaveTextContent(/terminal/i);
    expect(
      within(crawl).getByRole("heading", { name: "Provider traversal" }),
    ).toBeInTheDocument();
    expect(
      within(crawl)
        .getByRole("heading", { name: "Provider traversal" })
        .closest("section"),
    ).toHaveClass("pipeline-stage-row__provider-progress");
    expect(
      within(crawl)
        .getByRole("heading", { name: "Exact outcomes" })
        .closest("section"),
    ).toHaveClass("pipeline-stage-row__outcomes");
    expect(crawl).toHaveTextContent(
      "Indeed · 3 pages completed; provider total unavailable · 42 raw listings seen · 9 jobs emitted · more pages available",
    );
    expect(within(crawl).getAllByText("20 min–21 min").length).toBeGreaterThan(0);

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

  it("uses one flat metric strip and a repeatable, text-labelled stage grammar", async () => {
    await renderPipelineOperations(pipelinesDiscoveringSnapshot);

    const metrics = getLivePipelineMetrics();
    expect(metrics.querySelectorAll(".pipeline-overview-fact")).toHaveLength(4);
    expect(within(metrics).queryAllByRole("region")).toHaveLength(0);
    expect(metrics.querySelector("[data-slot='card']")).not.toBeInTheDocument();

    const planned = screen.getByRole("region", { name: "Plan sources stage" });
    const crawling = screen.getByRole("region", { name: "Crawl sources stage" });
    const reconciling = screen.getByRole("region", { name: "Enrichment reconciliation stage" });

    expect(planned).toHaveAttribute("data-stage-status", "completed");
    expect(within(planned).getByText("Completed")).toHaveAttribute(
      "data-status-tone",
      "ok",
    );
    expect(crawling).toHaveAttribute("data-stage-status", "processing");
    expect(within(crawling).getByText("In progress")).toHaveAttribute(
      "data-status-tone",
      "info",
    );
    expect(reconciling).toHaveAttribute("data-stage-status", "pending");
    expect(within(reconciling).getByText("Waiting to start")).toHaveAttribute(
      "data-status-tone",
      "muted",
    );
  });

  it("makes blocked stages explicit without relying on color alone", async () => {
    await renderPipelineOperations(pipelinesMixedFailureSnapshot);

    const attentionSummary = within(
      screen.getByLabelText("Pipeline operations summary"),
    ).getByText("1 stage");
    expect(attentionSummary).toHaveAttribute("data-status-tone", "warn");
    const crawl = screen.getByRole("region", { name: "Crawl sources stage" });
    expect(crawl).toHaveAttribute("data-stage-status", "blocked");
    expect(within(crawl).getByText("Attention required")).toHaveAttribute(
      "data-status-tone",
      "warn",
    );
    expect(
      within(crawl).getByText("Attention required").querySelector(
        "[data-status-icon='true']",
      ),
    ).toBeInTheDocument();
  });

  it("keeps finished outcomes honest and exposes every public stage-state count", async () => {
    const user = userEvent.setup();
    await renderPipelineOperations(pipelinesMixedFailureSnapshot);

    const crawl = screen.getByRole("region", { name: "Crawl sources stage" });
    expect(crawl).toHaveTextContent("Finished6");
    expect(crawl).not.toHaveTextContent("Done6");
    expect(crawl).toHaveTextContent("Attention3");
    await user.click(
      within(crawl).getByRole("button", { name: /Crawl sources/i }),
    );
    const outcomes = within(crawl).getByLabelText(
      "Crawl sources current-execution outcome counts",
    );
    expect(outcomes).toHaveTextContent("Eligible8");
    expect(outcomes).toHaveTextContent("Waiting1");
    expect(outcomes).toHaveTextContent("Running1");
    expect(outcomes).toHaveTextContent("Succeeded2");
    expect(outcomes).toHaveTextContent("Skipped0");
    expect(outcomes).toHaveTextContent("Blocked1");
    expect(outcomes).toHaveTextContent("Failed1");
    expect(outcomes).not.toHaveTextContent("Exhausted");
    expect(outcomes).toHaveTextContent("Canceled1");
    expect(outcomes).toHaveTextContent("Needs verification1");
    expect(outcomes).toHaveTextContent("Stale0");
    expect(outcomes).toHaveTextContent("Unknown0");
  });

  it("renders a closed timed-out crawl as a finished failure instead of active work", async () => {
    const user = userEvent.setup();
    const closedTimeoutSnapshot: PipelineOperationsSnapshot = {
      ...pipelinesCompletedWithIssuesSnapshot,
      sourceFamilies: {
        ...pipelinesCompletedWithIssuesSnapshot.sourceFamilies!,
        counts: {
          ...pipelinesCompletedWithIssuesSnapshot.sourceFamilies!.counts,
          failed: 1,
          exhausted: 0,
        },
      },
      stages: pipelinesCompletedWithIssuesSnapshot.stages.map((entry) =>
        entry.stage === "source_family" && entry.scope === "current_execution"
          ? {
              ...entry,
              currentExecution: {
                ...entry.currentExecution,
                eligible: 2,
                waiting: 0,
                processing: 0,
                succeeded: 1,
                failed: 1,
              },
            }
          : entry,
      ),
    };
    await renderPipelineOperations(closedTimeoutSnapshot);

    const crawl = screen.getByRole("region", { name: "Crawl sources stage" });
    expect(crawl).toHaveAttribute("data-stage-status", "blocked");
    expect(within(crawl).getByText("Attention required")).toBeInTheDocument();
    expect(within(crawl).queryByText("In progress")).not.toBeInTheDocument();
    expect(crawl).not.toHaveTextContent("1 of 2 finished");

    await user.click(within(crawl).getByRole("button", { name: /Crawl sources/i }));
    expect(within(crawl).getByRole("progressbar", { name: "Stage completion" })).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    expect(crawl).toHaveTextContent("2 of 2 finished");
    expect(crawl).not.toHaveTextContent(/terminal/i);
    expect(crawl).toHaveTextContent("Failed1");
    expect(crawl).not.toHaveTextContent("Exhausted");
  });

  it("prioritizes four status facts and moves snapshot provenance to the inspector", async () => {
    await renderPipelineOperations(pipelinesDiscoveringSnapshot);

    const summary = screen.getByLabelText("Pipeline operations summary");
    expect(
      summary.querySelectorAll('[data-summary-priority="primary"]'),
    ).toHaveLength(4);
    expect(
      summary.querySelectorAll('[data-summary-priority="secondary"]'),
    ).toHaveLength(2);
    expect(summary).toHaveTextContent("Execution sweep");
    expect(summary).toHaveTextContent("Source families");
    expect(summary).toHaveTextContent("Attention");
    expect(summary).not.toHaveTextContent("Snapshot");
    expect(document.getElementById("pipeline-inspector-surface")).toHaveTextContent(
      "Snapshot generated",
    );
  });

  it("offers a labelled Pipeline and Inspector mobile surface control", async () => {
    const user = userEvent.setup();
    await renderPipelineOperations(pipelinesDiscoveringSnapshot);

    const control = screen.getByRole("group", { name: "Pipeline view" });
    const pipeline = within(control).getByRole("button", { name: "Pipeline" });
    const inspector = within(control).getByRole("button", { name: "Inspector" });
    const workspace = control.closest<HTMLElement>(".pipeline-operations-workspace");
    if (!workspace) throw new Error("Expected the pipeline workspace.");

    expect(pipeline).toHaveAttribute("aria-pressed", "true");
    expect(pipeline).toHaveAttribute("aria-controls", "pipeline-primary-surface");
    expect(inspector).toHaveAttribute("aria-pressed", "false");
    expect(inspector).toHaveAttribute(
      "aria-controls",
      "pipeline-inspector-surface",
    );
    expect(workspace).toHaveAttribute("data-mobile-surface", "pipeline");
    expect(document.getElementById("pipeline-primary-surface")).toBeInTheDocument();
    expect(document.getElementById("pipeline-inspector-surface")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Freshness and capacity/i }),
    ).toHaveAttribute("aria-expanded", "false");

    await user.click(inspector);
    expect(pipeline).toHaveAttribute("aria-pressed", "false");
    expect(inspector).toHaveAttribute("aria-pressed", "true");
    expect(workspace).toHaveAttribute("data-mobile-surface", "inspector");
  });

  it("makes shared worker capacity and active runtime work immediately legible", async () => {
    await renderPipelineOperations(pipelinesMultiWorkerCapacitySnapshot);

    expect(getLivePipelineMetric("Workers online")).toHaveTextContent(
      "Workers online3",
    );
    expect(getLivePipelineMetric("Worker slots in use")).toHaveTextContent(
      "Worker slots in use9 of 12",
    );
    expect(getLivePipelineMetric("Active work")).toHaveTextContent(
      "Active work9Crawl sources 2 · Score 7",
    );
    expect(getLivePipelineMetric("Queue backlog")).toHaveTextContent(
      "Queue backlog2 queuedOldest queued task 18 sec",
    );
    expect(screen.queryByText(/Shared pool ·/)).not.toBeInTheDocument();
  });

  it("renders nullable idle coverage as no selected execution without degrading telemetry", async () => {
    await renderPipelineOperations(pipelinesIdleSnapshot);

    expect(
      screen.getByText("Idle", {
        selector: ".pipeline-phase-message [data-slot='status-badge']",
      }),
    ).toBeInTheDocument();

    const summary = screen.getByLabelText("Pipeline operations summary");
    expect(summary).toHaveTextContent("Current cohortNo selected execution");
    expect(summary).toHaveTextContent("Execution sweepNo selected execution");
    expect(summary).toHaveTextContent("Source familiesNo selected execution");
    expect(summary).toHaveTextContent("Overall ETANo work remaining");
    expect(summary).toHaveTextContent("TelemetryFresh");

    expect(getLivePipelineMetric("Workers online")).toHaveTextContent(
      "Workers online1",
    );
    expect(getLivePipelineMetric("Worker slots in use")).toHaveTextContent(
      "Worker slots in use0 of 4",
    );
    expect(getLivePipelineMetric("Active work")).toHaveTextContent(
      "Active workNo active workNo active stages",
    );
    expect(getLivePipelineMetric("Queue backlog")).toHaveTextContent(
      "Queue backlog0 queuedOldest queued task 0 sec",
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/restoring history/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/tracking unavailable/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Overall completion estimate" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("No current-execution stages are available."),
    ).toBeInTheDocument();
  });

  it("keeps live runtime truth visible while the previous run is checked", async () => {
    await renderPipelineOperations(pipelinesRecoveringProjectionSnapshot);

    const coverageAlert = screen.getByRole("alert");
    expect(coverageAlert).toHaveTextContent("Checking previous run records");
    expect(coverageAlert).toHaveTextContent(
      "15 of 72 linked jobs checked",
    );
    expect(coverageAlert).toHaveTextContent(
      "3 of 8 stage records checked",
    );
    expect(coverageAlert).toHaveTextContent("needs no restart");
    expect(coverageAlert).toHaveTextContent(
      "Live worker, queue, and activity facts remain visible below",
    );
    expect(coverageAlert.querySelector("svg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop discovery" })).toBeEnabled();

    const summary = screen.getByLabelText("Pipeline operations summary");
    expect(summary).toHaveTextContent("Current cohortChecking previous run");
    expect(summary).toHaveTextContent("Execution sweepChecking previous run");
    expect(summary).toHaveTextContent("Source familiesChecking previous run");
    expect(summary).toHaveTextContent("Overall ETAChecking previous run");
    expect(summary).toHaveTextContent("TelemetryFresh");

    expect(getLivePipelineMetric("Workers online")).toHaveTextContent(
      "Workers online1",
    );
    expect(getLivePipelineMetric("Worker slots in use")).toHaveTextContent(
      "Worker slots in use4 of 4",
    );
    expect(getLivePipelineMetric("Active work")).toHaveTextContent(
      "Active work4Crawl sources 1 · Tailor 3",
    );
    expect(getLivePipelineMetric("Queue backlog")).toHaveTextContent(
      "Queue backlog41 queuedOldest queued task 2 min",
    );

    expect(coverageAlert).not.toHaveTextContent(/terminal/i);
    expect(screen.queryByText("No work remaining")).not.toBeInTheDocument();
    expect(screen.queryByText(/tracking unavailable/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Overall completion estimate" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Plan sources stage" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Backlog and diagnostics/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Source families and enrichment reconciliation/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Pipeline action tools" }),
    ).not.toBeInTheDocument();

    const activeWorkHeading = screen.getByRole("heading", { name: "Active work" });
    const activeWork = activeWorkHeading.closest<HTMLElement>(
      ".configuration-section",
    );
    if (!activeWork) throw new Error("Expected active-work disclosure.");
    expect(within(activeWork).getAllByRole("heading", { name: "Tailor" })).toHaveLength(3);
    expect(within(activeWork).getAllByRole("heading", { name: "Crawl sources" })).toHaveLength(1);
    expect(activeWork).toHaveTextContent("source_family");
    expect(activeWork).toHaveTextContent("source-family-runtime-1");
    expect(activeWork).toHaveTextContent("tailor-runtime-3");
  });

  it("retries the previous-run check automatically without hiding live telemetry", async () => {
    const user = userEvent.setup();
    await renderPipelineOperations(pipelinesRetryingProjectionSnapshot);

    const coverageAlert = screen.getByRole("alert");
    expect(coverageAlert).toHaveTextContent(
      "Previous run check will retry automatically",
    );
    expect(coverageAlert).toHaveTextContent(
      "Last check result: Recovery manifest set mismatch",
    );
    expect(coverageAlert).toHaveTextContent(
      "This check finishes automatically and needs no restart",
    );
    expect(coverageAlert.querySelector("svg")).toBeInTheDocument();

    const summary = screen.getByLabelText("Pipeline operations summary");
    expect(summary).toHaveTextContent("Current cohortCheck will retry");
    expect(summary).toHaveTextContent("Execution sweepCheck will retry");
    expect(summary).toHaveTextContent("Source familiesCheck will retry");
    expect(summary).toHaveTextContent("Overall ETACheck will retry");
    expect(summary).toHaveTextContent("TelemetryFresh");

    expect(getLivePipelineMetric("Workers online")).toHaveTextContent(
      "Workers online1",
    );
    expect(getLivePipelineMetric("Queue backlog")).toHaveTextContent(
      "Queue backlog41 queuedOldest queued task 2 min",
    );
    expect(getLivePipelineMetric("Active work")).toHaveTextContent(
      "Active work4Crawl sources 1 · Tailor 3",
    );
    await user.click(
      screen.getByRole("button", { name: /Freshness and capacity/i }),
    );
    expect(screen.getByRole("region", { name: "Worker capacity facts" })).toHaveTextContent(
      "Configured slots4Active slots4Available slots0",
    );

    expect(
      screen.queryByRole("button", { name: /Backlog and diagnostics/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Execution sweep ledger table" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Global outside execution ledger table" }),
    ).not.toBeInTheDocument();

    expect(screen.queryByText(/terminal/i)).not.toBeInTheDocument();
    expect(screen.queryByText("No work remaining")).not.toBeInTheDocument();
    expect(screen.queryByText(/tracking unavailable/i)).not.toBeInTheDocument();
  });

  it("preserves incomplete previous-run history and offers a safe new Discover run", async () => {
    const user = userEvent.setup();
    useStageTriggerStore.getState().setActiveStage("apply");
    await renderPipelineOperations(pipelinesIncompleteProjectionSnapshot);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Previous run record is incomplete");
    expect(alert).toHaveTextContent("preserved every exact record it can prove");
    expect(alert).toHaveTextContent("will not be retried automatically");
    expect(alert).not.toHaveTextContent("will retry automatically");
    expect(alert).not.toHaveTextContent(/terminal/i);
    expect(screen.queryByText(/No work remaining/i)).not.toBeInTheDocument();

    const restart = within(alert).getByRole("link", {
      name: "Set up a new Discover run",
    });
    const tools = screen.getByRole("group", { name: "Pipeline action tools" });
    await user.click(restart);
    expect(within(tools).getByRole("tab", { name: "Discover" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await within(tools).findByRole("button", { name: "Run Discover" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Stop discovery" })).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Technical execution details/i }),
    );
    expect(screen.getByText("run-discover-20260714")).toBeInTheDocument();
    expect(screen.getAllByText("legacy-fanout-terminal-failed").length).toBeGreaterThan(0);
    expect(screen.getByText("119")).toBeInTheDocument();
  });

  it("does not offer a new Discover run while non-allowlisted work occupies a slot", async () => {
    const capacity = pipelinesIncompleteProjectionSnapshot.capacity;
    if (capacity.status !== "available") {
      throw new Error("Incomplete-history fixture requires fresh available capacity");
    }
    await renderPipelineOperations({
      ...pipelinesIncompleteProjectionSnapshot,
      capacity: {
        ...capacity,
        activeSlots: 1,
        availableSlots: 3,
        slotSaturation: 0.25,
      },
      activeItems: [],
      activeItemsTotal: 0,
      activeItemsTruncated: false,
    });

    const alert = screen.getByRole("alert");
    expect(
      within(alert).queryByRole("link", { name: "Set up a new Discover run" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Pipeline action tools" }),
    ).not.toBeInTheDocument();
  });

  it("lets a previous-run check dominate an apparently finished incomplete projection", async () => {
    await renderPipelineOperations(pipelinesTerminalRecoveringProjectionSnapshot);

    const coverageAlert = screen.getByRole("alert");
    expect(coverageAlert).toHaveTextContent("Checking previous run records");
    expect(coverageAlert).not.toHaveTextContent("Discovery completed with source issues");

    const phase = document.querySelector(".pipeline-phase-message");
    expect(phase).toHaveTextContent("Checking previous run");
    expect(phase).not.toHaveTextContent("Completed with issues");
    expect(
      screen.queryByRole("link", { name: "Set up a new Discover run" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop discovery" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Pipeline action tools" }),
    ).not.toBeInTheDocument();

    expect(getLivePipelineMetric("Workers online")).toBeInTheDocument();
    expect(getLivePipelineMetric("Worker slots in use")).toBeInTheDocument();
    expect(getLivePipelineMetric("Active work")).toBeInTheDocument();
    expect(getLivePipelineMetric("Queue backlog")).toBeInTheDocument();
    const technicalDetails = screen.getByRole("button", {
      name: /Technical execution details/i,
    });
    await userEvent.setup().click(technicalDetails);
    expect(screen.getByText("run-discover-20260714")).toBeInTheDocument();
    expect(screen.getAllByText("Recovering").length).toBeGreaterThan(0);
    expect(screen.getByText("89")).toBeInTheDocument();
  });

  it("does not expose partial sweep, cohort, source, or ETA values during recovery", async () => {
    await renderPipelineOperations(pipelinesPartialSweepRecoveringSnapshot);

    const summary = screen.getByLabelText("Pipeline operations summary");
    expect(summary).toHaveTextContent("Current cohortChecking previous run");
    expect(summary).toHaveTextContent("Execution sweepChecking previous run");
    expect(summary).toHaveTextContent("Source familiesChecking previous run");
    expect(summary).toHaveTextContent("Overall ETAChecking previous run");

    expect(screen.queryByText("41 remaining")).not.toBeInTheDocument();
    expect(screen.queryByText("83 remaining")).not.toBeInTheDocument();
    expect(screen.queryByText("43/47")).not.toBeInTheDocument();
    expect(screen.queryByText("83 active")).not.toBeInTheDocument();
    expect(screen.queryByText("8 min – 12 min")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Execution sweep ledger table" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Plan sources stage" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Source families and enrichment reconciliation/i }),
    ).not.toBeInTheDocument();

    expect(getLivePipelineMetric("Workers online")).toHaveTextContent(
      "Workers online1",
    );
    expect(getLivePipelineMetric("Active work")).toHaveTextContent(
      "Active work4Crawl sources 1 · Tailor 3",
    );
    expect(getLivePipelineMetric("Queue backlog")).toHaveTextContent(
      "Queue backlog41 queuedOldest queued task 2 min",
    );
  });

  it("omits meaningless progress for a complete zero-denominator stage", async () => {
    const user = userEvent.setup();
    await renderPipelineOperations({
      ...pipelinesDiscoveringSnapshot,
      stages: pipelinesDiscoveringSnapshot.stages.map((stage) =>
        stage.stage === "source_planning" && stage.scope === "current_execution"
          ? {
              ...stage,
              currentExecution: {
                eligible: 0,
                waiting: 0,
                processing: 0,
                succeeded: 0,
                skipped: 0,
                blocked: 0,
                failed: 0,
                exhausted: 0,
                canceled: 0,
                needsVerification: 0,
                stale: 0,
                unknown: 0,
              },
            }
          : stage,
      ),
    });

    const planSources = screen.getByRole("region", { name: "Plan sources stage" });
    expect(
      planSources.querySelector('[role="progressbar"]'),
    ).not.toBeInTheDocument();
    expect(within(planSources).queryByText("No work remaining")).not.toBeInTheDocument();
    const crawlSources = screen.getByRole("region", { name: "Crawl sources stage" });
    await user.click(
      within(crawlSources).getByRole("button", { name: /Crawl sources/i }),
    );
    expect(
      within(crawlSources).getByRole("progressbar", { name: "Stage completion" }),
    ).toHaveAttribute("aria-valuenow", "33");
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
    expect(getLivePipelineMetric("Active work")).toHaveTextContent(
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
      capacity: {
        ...pipelinesCompletedWithIssuesSnapshot.capacity,
        activeSlots: 0,
        availableSlots:
          pipelinesCompletedWithIssuesSnapshot.capacity.status === "available"
            ? pipelinesCompletedWithIssuesSnapshot.capacity.configuredSlots
            : 0,
        slotSaturation: 0,
      },
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

    const sourceStatus = screen.getByText("3 of 3 finished · 1 needs attention", {
      selector: '[data-slot="status-badge"]',
    });
    expect(sourceStatus).toHaveAttribute("data-status-tone", "warn");
    expect(sourceStatus.querySelector("[data-status-icon='true']")).toBeInTheDocument();

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

  it("explains that a closed draining run needs a new Discover run instead of resume", async () => {
    const user = userEvent.setup();
    const runPipelineStages = vi.fn();
    useStageTriggerStore.getState().setActiveStage("apply");
    const pipelineOperations = vi.fn(async () => ({
      ...pipelinesDiscoveringSnapshot,
      execution: {
        ...pipelinesDiscoveringSnapshot.execution!,
        workflowStatus: "succeeded" as const,
        phase: "draining" as const,
        finishedAt: "2026-07-14T12:04:00.000Z",
      },
      capacity: {
        ...pipelinesDiscoveringSnapshot.capacity,
        activeSlots: 0,
        availableSlots:
          pipelinesDiscoveringSnapshot.capacity.status === "available"
            ? pipelinesDiscoveringSnapshot.capacity.configuredSlots
            : 0,
        slotSaturation: 0,
      },
      stages: pipelinesDiscoveringSnapshot.stages.map((stage) =>
        stage.stage === "source_family"
          ? {
              ...stage,
              eta: {
                status: "paused" as const,
                reason: "no_dispatch" as const,
                asOf: stage.asOf,
              },
            }
          : stage,
      ),
      activeItems: [],
      activeItemsTotal: 0,
      activeItemsTruncated: false,
      activeStageCounts: [],
      overallEta: {
        status: "paused" as const,
        reason: "no_dispatch" as const,
        asOf: pipelinesDiscoveringSnapshot.generatedAt,
      },
    }));
    renderWithProviders(<PipelinesView />, {
      ports: buildTestPorts({ api: { pipelineOperations, runPipelineStages } }),
    });
    await screen.findByRole("heading", { name: "Live pipeline" });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("This Discover run has ended");
    expect(alert).toHaveTextContent("there is no paused workflow to resume");
    const restart = within(alert).getByRole("link", {
      name: "Set up a new Discover run",
    });
    expect(restart).toHaveAttribute("href", "#pipeline-actions");

    const crawl = screen.getByRole("region", { name: "Crawl sources stage" });
    expect(
      within(crawl).getByRole("button", { name: /Crawl sources/i }),
    ).toHaveTextContent("No ETA · No recent dispatch activity");

    await user.click(
      screen.getByRole("button", { name: /Overall completion estimate/i }),
    );
    expect(screen.getByLabelText("Overall ETA facts")).toHaveTextContent(
      "StatusNo ETA",
    );

    await user.click(restart);
    expect(runPipelineStages).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Discover" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      await screen.findByRole("button", { name: "Run Discover" }),
    ).toBeEnabled();
  });

  it("blocks a manually selected replacement Discover run while shared work is active", async () => {
    const user = userEvent.setup();
    const runPipelineStages = vi.fn();
    useStageTriggerStore.getState().setActiveStage("apply");
    const pipelineOperations = vi.fn(async () => ({
      ...pipelinesDiscoveringSnapshot,
      execution: {
        ...pipelinesDiscoveringSnapshot.execution!,
        workflowStatus: "succeeded" as const,
        phase: "draining" as const,
        finishedAt: "2026-07-14T12:04:00.000Z",
      },
      capacity: {
        ...pipelinesDiscoveringSnapshot.capacity,
        activeSlots: 1,
        availableSlots:
          pipelinesDiscoveringSnapshot.capacity.status === "available"
            ? pipelinesDiscoveringSnapshot.capacity.configuredSlots - 1
            : 0,
        slotSaturation:
          pipelinesDiscoveringSnapshot.capacity.status === "available"
            ? 1 / pipelinesDiscoveringSnapshot.capacity.configuredSlots
            : 0,
      },
      activeItems: [],
      activeItemsTotal: 0,
      activeItemsTruncated: false,
      activeStageCounts: [],
    }));
    renderWithProviders(<PipelinesView />, {
      ports: buildTestPorts({ api: { pipelineOperations, runPipelineStages } }),
    });
    await screen.findByRole("heading", { name: "Live pipeline" });

    expect(
      screen.queryByRole("link", { name: "Set up a new Discover run" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Discover" }));

    const runDiscover = screen.getByRole("button", { name: "Run Discover" });
    expect(runDiscover).toBeDisabled();
    expect(runDiscover).toHaveAccessibleDescription(
      "Wait for active pipeline work to finish before starting a new Discover run.",
    );
    await user.click(runDiscover);
    expect(runPipelineStages).not.toHaveBeenCalled();
  });

  it.each([
    {
      capacity: "busy",
      label: "failed with busy capacity",
      snapshot: pipelinesFailedHistorySnapshot,
    },
    {
      capacity: "unavailable",
      label: "failed with unavailable capacity",
      snapshot: pipelinesFailedHistorySnapshot,
    },
    {
      capacity: "busy",
      label: "completed with issues and busy capacity",
      snapshot: pipelinesCompletedWithIssuesSnapshot,
    },
    {
      capacity: "unavailable",
      label: "completed with issues and unavailable capacity",
      snapshot: pipelinesCompletedWithIssuesSnapshot,
    },
  ])(
    "blocks the manual Discover bypass for a $label replacement run",
    async ({ capacity, snapshot }) => {
      const user = userEvent.setup();
      const runPipelineStages = vi.fn();
      useStageTriggerStore.getState().setActiveStage("apply");
      const pipelineOperations = vi.fn(async () => ({
        ...snapshot,
        capacity:
          capacity === "unavailable"
            ? pipelinesUnavailableTelemetrySnapshot.capacity
            : {
                ...snapshot.capacity,
                activeSlots: 1,
                availableSlots:
                  snapshot.capacity.status === "available"
                    ? snapshot.capacity.configuredSlots - 1
                    : 0,
                slotSaturation:
                  snapshot.capacity.status === "available"
                    ? 1 / snapshot.capacity.configuredSlots
                    : 0,
              },
        activeItems: [],
        activeItemsTotal: 0,
        activeItemsTruncated: false,
        activeStageCounts: [],
      }));
      renderWithProviders(<PipelinesView />, {
        ports: buildTestPorts({
          api: { pipelineOperations, runPipelineStages },
        }),
      });
      await screen.findByRole("heading", { name: "Live pipeline" });

      expect(
        screen.queryByRole("link", { name: "Set up a new Discover run" }),
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole("tab", { name: "Discover" }));
      const runDiscover = screen.getByRole("button", {
        name: "Run Discover",
      });
      expect(runDiscover).toBeDisabled();
      expect(runDiscover).toHaveAccessibleDescription(
        capacity === "unavailable"
          ? "Shared runtime capacity must be available before starting a new Discover run."
          : "Wait for active pipeline work to finish before starting a new Discover run.",
      );
      await user.click(runDiscover);
      expect(runPipelineStages).not.toHaveBeenCalled();
    },
  );

  it("keeps source-family progress separate from exactly two reconciliation ledgers", async () => {
    await renderPipelineOperations(pipelinesThreeSourceSixStepSnapshot);

    const sourceHeading = screen.getByRole("heading", {
      name: "Source families and enrichment reconciliation",
    });
    const sourceLedger =
      sourceHeading.closest<HTMLElement>(".pipeline-source-ledger");
    if (!sourceLedger) throw new Error("Expected source and reconciliation ledger.");

    expect(sourceLedger).toHaveTextContent("3 of 3 finished");
    expect(
      within(sourceLedger).getByRole("progressbar", {
        name: "Source-family completion",
      }),
    ).toHaveAttribute("aria-valuenow", "100");
    expect(
      within(sourceLedger).getByRole("progressbar", {
        name: "Source-family completion",
      }),
    ).toHaveAttribute("aria-valuetext", "3 of 3 finished");
    expect(sourceLedger).toHaveTextContent(
      "Runs one final enrichment pass for stragglers, then hands every ready job to preparation.",
    );
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

  it("keeps global queue and capacity separate from stage ETA provenance", async () => {
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
    await user.click(
      screen.getByRole("button", { name: /Freshness and capacity/i }),
    );

    const activityQueue = screen.getByRole("region", {
      name: "Activity task queue",
    });
    const eta = within(disclosure).getByLabelText("Score ETA facts");
    const capacity = screen.getByRole("region", {
      name: "Worker capacity facts",
    });

    expect(
      within(disclosure).queryByRole("region", { name: "Worker capacity facts" }),
    ).not.toBeInTheDocument();
    expect(
      within(disclosure).queryByRole("region", { name: "Activity task queue" }),
    ).not.toBeInTheDocument();

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
    const user = userEvent.setup();
    await renderPipelineOperations(pipelinesUnavailableTelemetrySnapshot);
    await user.click(
      screen.getByRole("button", { name: /Freshness and capacity/i }),
    );

    const capacity = screen.getByRole("region", {
      name: "Worker capacity facts",
    });
    const freshness = screen.getByRole("region", {
      name: "Telemetry freshness",
    });

    expect(capacity).toHaveTextContent("Unavailable");
    expect(capacity).toHaveTextContent("No worker runtime telemetry");
    expect(freshness).toHaveTextContent("Unavailable");
    expect(screen.queryByText(/estimate:.*min/i)).not.toBeInTheDocument();
  });

  it("reports active inventory truth and multi-worker internal concurrency", async () => {
    const user = userEvent.setup();
    await renderPipelineOperations(pipelinesMultiWorkerCapacitySnapshot);
    await user.click(
      screen.getByRole("button", { name: /Freshness and capacity/i }),
    );

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

  it("replaces raw demo capability errors with a disabled control and supported path", async () => {
    const pipelineOperations = vi.fn();
    const runPipelineStages = vi.fn();
    const ports = buildTestPorts({
      api: { pipelineOperations, runPipelineStages },
    });
    ports.featureFlags = new DemoFeatureFlagAdapter();
    renderWithProviders(<PipelinesView />, { ports });

    const title = await screen.findByText(
      "Live pipeline controls require the local app",
    );
    const alert = title.closest<HTMLElement>("[role='alert']");
    if (!alert) throw new Error("Expected demo capability alert.");
    expect(alert).toHaveTextContent(
      "The public demo does not start worker-backed pipelines",
    );
    expect(alert).not.toHaveTextContent("Demo capability pipelineOperations");
    expect(within(alert).getByRole("link", { name: "Review demo runs" })).toHaveAttribute(
      "href",
      "/runs",
    );
    expect(within(alert).getByRole("link", { name: "Install JobCtrl" })).toHaveAttribute(
      "href",
      "https://jobctrl.dev/user/getting-started",
    );
    const tools = screen.getByRole("group", { name: "Pipeline action tools" });
    expect(
      within(tools).getByRole("button", { name: "Run in local app" }),
    ).toBeDisabled();
    expect(pipelineOperations).not.toHaveBeenCalled();
    expect(runPipelineStages).not.toHaveBeenCalled();
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
