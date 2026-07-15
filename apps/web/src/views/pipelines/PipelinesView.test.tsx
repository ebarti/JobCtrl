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

    expect(screen.getByRole("heading", { name: "Pipeline actions" })).toBeInTheDocument();
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

  it("distinguishes current execution, sweep, and global backlog in one dense stage table", async () => {
    await renderPipelineOperations(pipelinesDiscoveringSnapshot);

    const table = screen.getByRole("table", { name: /stage state, existing backlog/i });
    expect(within(table).getAllByText("Current execution").length).toBeGreaterThan(0);
    expect(within(table).getAllByText("Execution sweep").length).toBeGreaterThan(0);
    expect(within(table).getAllByText("Global backlog").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("table")).toHaveLength(1);
  });

  it("keeps the three source families separate from the two reconciliation steps", async () => {
    await renderPipelineOperations(pipelinesThreeSourceSixStepSnapshot);

    const sourceCard = screen.getByRole("heading", { name: "Source crawl progress" }).closest(".pipeline-card");
    if (!sourceCard) throw new Error("Expected source crawl progress card.");

    expect(sourceCard).toHaveTextContent("3/3 succeeded");
    expect(sourceCard).toHaveTextContent("Reconciliation");
    expect(sourceCard).toHaveTextContent("Enrichment pass");
    expect(sourceCard).toHaveTextContent("Preparation fanout");
  });

  it("announces only the stable phase message and keeps calibration inspectable", async () => {
    const { container } = await renderPipelineOperations(pipelinesCalibratingSnapshot);

    const liveMessage = container.querySelector(".pipeline-phase-message");
    if (!liveMessage) throw new Error("Expected the compact phase message.");

    expect(liveMessage).toHaveAttribute("aria-live", "polite");
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(liveMessage).toHaveTextContent("Discovering");
    expect(liveMessage).not.toHaveTextContent("Calibrating");
    expect(screen.getAllByText(/Calibrating · 2\/8/).length).toBeGreaterThan(0);
  });

  it("labels unavailable telemetry without inventing an ETA", async () => {
    await renderPipelineOperations(pipelinesUnavailableTelemetrySnapshot);

    const capacity = screen.getByRole("heading", { name: "Worker capacity" }).closest(".pipeline-card");
    if (!capacity) throw new Error("Expected worker capacity card.");

    expect(capacity).toHaveTextContent("Unavailable");
    expect(capacity).toHaveTextContent("No worker runtime telemetry");
    expect(screen.queryByText(/estimate:.*min/i)).not.toBeInTheDocument();
  });

  it("reports active inventory truth and multi-worker internal concurrency", async () => {
    await renderPipelineOperations(pipelinesMultiWorkerCapacitySnapshot);

    const activeWork = screen.getByRole("heading", { name: "Active work" }).closest(".pipeline-card");
    const capacity = screen.getByRole("heading", { name: "Worker capacity" }).closest(".pipeline-card");
    if (!activeWork || !capacity) throw new Error("Expected active-work and capacity cards.");

    expect(activeWork).toHaveTextContent("9 total");
    expect(activeWork).toHaveTextContent("Inventory truncated");
    expect(within(activeWork).getByText("Staff Platform Engineer")).toBeInTheDocument();
    expect(within(activeWork).getAllByText("activity-opaque-17").length).toBeGreaterThan(0);
    expect(capacity).toHaveTextContent("Internal concurrency");
    expect(capacity).toHaveTextContent("3");
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
    expect(screen.getAllByText("Sensitive identifier withheld").length).toBeGreaterThan(0);
  });

  it("does not show secondary discovery navigation inside pipeline actions", async () => {
    await renderPipelineOperations(pipelinesDiscoveringSnapshot);

    expect(screen.queryByRole("heading", { name: "Discovery" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open Discovery" })).not.toBeInTheDocument();
  });
});
