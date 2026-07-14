import type { PipelineOperationsSnapshot } from "@jobctrl/contracts";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
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

  it("keeps the original action controls aligned with the live operations workspace", async () => {
    const user = userEvent.setup();
    await renderPipelineOperations(pipelinesDiscoveringSnapshot);

    expect(
      screen.getByRole("heading", { name: "Pipeline actions" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Run Discover" })).toBeEnabled();
    expect(screen.getByLabelText("Limit")).toBeInTheDocument();
    expect(screen.getByLabelText("Internal concurrency")).toBeInTheDocument();
    expect(screen.getByLabelText("Source")).toBeInTheDocument();
    expect(screen.getByLabelText("Dry run")).toBeChecked();

    await user.click(screen.getByRole("tab", { name: "Apply" }));

    expect(screen.getByLabelText("Minimum score")).toBeInTheDocument();
    expect(screen.getByLabelText("Internal concurrency")).toBeInTheDocument();
    expect(screen.getByLabelText("Apply model")).toBeInTheDocument();
    expect(screen.getByLabelText("Headless browser")).toBeInTheDocument();
    expect(screen.getByLabelText("Continuous")).toBeInTheDocument();
    expect(screen.queryByLabelText("Source")).not.toBeInTheDocument();
  });

  it("keeps current execution, sweep, and global work as separate semantic ledgers", async () => {
    await renderPipelineOperations(pipelinesDiscoveringSnapshot);

    expect(screen.getByRole("heading", { name: "Current execution" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Execution sweep" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Global outside execution" })).toBeInTheDocument();
    expect(screen.getAllByRole("table")).toHaveLength(3);
  });

  it("keeps table rows scannable while preserving the complete operational basis in disclosures", async () => {
    await renderPipelineOperations(pipelinesDiscoveringSnapshot);

    const currentExecution = screen.getByRole("heading", { name: "Current execution" }).closest("section");
    if (!currentExecution) {
      throw new Error("Expected current execution stage ledger.");
    }

    const planSources = within(currentExecution).getByRole("row", { name: /Plan sources/i });
    const scopedSummary = within(planSources).getByLabelText("Plan sources scoped outcomes summary");

    expect(scopedSummary).toHaveTextContent("Eligible");
    expect(scopedSummary).toHaveTextContent("Succeeded");
    expect(scopedSummary).not.toHaveTextContent("Blocked");
    expect(within(planSources).getByText("All 12 outcomes")).toBeInTheDocument();
    expect(within(planSources).getByText("Estimate basis")).toBeInTheDocument();
    expect(within(planSources).getAllByText("Needs verification")).toHaveLength(2);
    expect(within(planSources).getByText("Caveat")).toBeInTheDocument();
    expect(within(planSources).getByText("Capacity details")).toBeInTheDocument();
  });

  it("keeps the three source families separate from the two reconciliation steps", async () => {
    await renderPipelineOperations(pipelinesThreeSourceSixStepSnapshot);

    const sourcePlan = screen.getByText("Source-family plan").closest(".pipeline-source-reconciliation");
    const reconciliation = screen.getByText("Reconciliation · 2 steps").closest(".pipeline-source-reconciliation");

    if (!sourcePlan || !reconciliation) {
      throw new Error("Expected source planning and reconciliation inspectors.");
    }

    expect(sourcePlan).toHaveTextContent("3/3");
    expect(reconciliation).toHaveTextContent("2 steps");
    expect(reconciliation).toHaveTextContent("Enrichment pass");
    expect(reconciliation).toHaveTextContent("Preparation fanout");
  });

  it("announces only the compact live summary and keeps calibration text inspectable", async () => {
    const { container } = await renderPipelineOperations(pipelinesCalibratingSnapshot);

    const liveHeader = container.querySelector(".pipelines-workspace__live-header");
    if (!liveHeader) {
      throw new Error("Expected the compact pipeline live header.");
    }

    expect(liveHeader).toHaveAttribute("aria-live", "polite");
    expect(container.querySelectorAll("[aria-live='polite']")).toHaveLength(1);
    expect(liveHeader).toHaveTextContent("Calibrating");
    expect(liveHeader).toHaveTextContent("2/8");
  });

  it("labels unavailable telemetry without inventing an ETA", async () => {
    await renderPipelineOperations(pipelinesUnavailableTelemetrySnapshot);

    expect(screen.getByRole("heading", { name: "Execution inspector" })).toBeInTheDocument();
    expect(screen.getAllByText(/unavailable/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/estimate:.*min/i)).not.toBeInTheDocument();
  });

  it("reports active inventory truth and multi-worker internal concurrency", async () => {
    await renderPipelineOperations(pipelinesMultiWorkerCapacitySnapshot);

    const activeWork = screen.getByText("Active work").closest<HTMLElement>(".disclosure-section");
    if (!activeWork) {
      throw new Error("Expected the active-work disclosure.");
    }

    expect(activeWork).toHaveTextContent("9 total");
    expect(activeWork).toHaveTextContent("truncated");
    expect(within(activeWork).getByText("Staff Platform Engineer")).toBeInTheDocument();
    expect(within(activeWork).getByText("activity-opaque-17")).toBeInTheDocument();
    const capacity = document.querySelector<HTMLElement>(".pipeline-operations-capacity");
    if (!capacity) {
      throw new Error("Expected the pipeline capacity inspector.");
    }
    expect(within(capacity).getByText("Internal concurrency")).toBeInTheDocument();
    expect(capacity).toHaveTextContent("3");
    expect(within(capacity).getByRole("heading", { name: "Worker capacity" })).toBeInTheDocument();
    expect(within(capacity).getByRole("heading", { name: "Task queue telemetry" })).toBeInTheDocument();
  });

  it("withholds URL-shaped job keys from the operations inspector", async () => {
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
    expect(screen.getByText("Sensitive identifier withheld")).toBeInTheDocument();
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
