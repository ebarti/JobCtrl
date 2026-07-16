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
  pipelinesDiscoveringSnapshot,
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

  await screen.findByRole("heading", { name: "Operational stage ledger" });
  return { ...view, pipelineOperations };
}

describe("PipelinesView", () => {
  beforeEach(() => {
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

  it("renders current execution, sweep, and global backlog as separate focusable ledgers", async () => {
    await renderPipelineOperations(pipelinesDiscoveringSnapshot);

    const current = screen.getByRole("region", {
      name: "Current execution ledger table",
    });
    const sweep = screen.getByRole("region", {
      name: "Execution sweep ledger table",
    });
    const global = screen.getByRole("region", {
      name: "Global outside execution ledger table",
    });

    expect(current).toHaveAttribute("tabindex", "0");
    expect(sweep).toHaveAttribute("tabindex", "0");
    expect(global).toHaveAttribute("tabindex", "0");
    expect(
      within(current).getByRole("table", { name: /current execution stage state/i }),
    ).toBeInTheDocument();
    expect(
      within(sweep).getByRole("table", { name: /execution sweep stage state/i }),
    ).toBeInTheDocument();
    expect(
      within(global).getByRole("table", { name: /global outside execution stage state/i }),
    ).toBeInTheDocument();
    expect(within(global).getAllByText("Global backlog").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("table")).toHaveLength(3);
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
