import { STAGES, type PipelineStageRunResponse } from "@jobhunter/contracts";
import { userEvent } from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { sampleDashboardSummary } from "../../../test/fixtures/projections.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useStageTriggerStore } from "../stores/stage-trigger-store.js";
import { StageTriggerPanel } from "./StageTriggerPanel.js";

describe("StageTriggerPanel", () => {
  beforeEach(() => {
    window.localStorage.removeItem?.("jh:stage-trigger-config");
    useStageTriggerStore.getState().reset();
  });

  it("defaults to the Discover tab with dry-run enabled", () => {
    renderWithProviders(<StageTriggerPanel />);

    expect(screen.getByLabelText("Dry run")).toBeChecked();
    expect(screen.getByRole("button", { name: "Run Discover" })).toBeEnabled();
  });

  it("renders a matching tabpanel for every stage trigger", () => {
    renderWithProviders(<StageTriggerPanel />);

    expect(screen.getAllByRole("tabpanel", { hidden: true })).toHaveLength(STAGES.length);

    for (const tab of screen.getAllByRole("tab")) {
      const panelId = tab.getAttribute("aria-controls");

      if (panelId === null) {
        throw new Error(`Expected ${tab.textContent ?? "stage"} tab to control a panel`);
      }

      expect(document.getElementById(panelId)).toBeInTheDocument();
    }
  });

  it("only shows controls that apply to the active stage", async () => {
    const user = userEvent.setup();
    renderWithProviders(<StageTriggerPanel />);

    expect(screen.getByLabelText("Workers")).toBeInTheDocument();
    expect(screen.getByLabelText("Limit")).toBeInTheDocument();
    expect(screen.getByLabelText("Dry run")).toBeInTheDocument();
    expect(screen.queryByLabelText("Minimum score")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Validation mode")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Apply model")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Rescore")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Retailor")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Headless browser")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Continuous")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Enrich" }));
    expect(screen.getByLabelText("Limit")).toBeInTheDocument();
    expect(screen.getByLabelText("Workers")).toBeInTheDocument();
    expect(screen.queryByLabelText("Minimum score")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Validation mode")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Apply model")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Headless browser")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Score" }));
    expect(screen.getByLabelText("Limit")).toBeInTheDocument();
    expect(screen.getByLabelText("Workers")).toBeInTheDocument();
    expect(screen.getByLabelText("Rescore")).toBeInTheDocument();
    expect(screen.queryByLabelText("Minimum score")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Validation mode")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Apply model")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Headless browser")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Tailor" }));
    expect(screen.getByLabelText("Limit")).toBeInTheDocument();
    expect(screen.getByLabelText("Workers")).toBeInTheDocument();
    expect(screen.getByLabelText("Minimum score")).toBeInTheDocument();
    expect(screen.getByLabelText("Validation mode")).toBeInTheDocument();
    expect(screen.getByLabelText("Retailor")).toBeInTheDocument();
    expect(screen.queryByLabelText("Rescore")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Apply model")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Headless browser")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Cover" }));
    expect(screen.getByLabelText("Limit")).toBeInTheDocument();
    expect(screen.getByLabelText("Minimum score")).toBeInTheDocument();
    expect(screen.getByLabelText("Validation mode")).toBeInTheDocument();
    expect(screen.queryByLabelText("Workers")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Retailor")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "PDF" }));
    expect(screen.getByLabelText("Limit")).toBeInTheDocument();
    expect(screen.getByLabelText("Dry run")).toBeInTheDocument();
    expect(screen.queryByLabelText("Workers")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Minimum score")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Validation mode")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Apply" }));
    expect(screen.getByLabelText("Limit")).toBeInTheDocument();
    expect(screen.getByLabelText("Workers")).toBeInTheDocument();
    expect(screen.getByLabelText("Minimum score")).toBeInTheDocument();
    expect(screen.getByLabelText("Apply model")).toBeInTheDocument();
    expect(screen.getByLabelText("Apply model")).toHaveRole("combobox");
    expect(screen.getByLabelText("Headless browser")).toBeInTheDocument();
    expect(screen.getByLabelText("Continuous")).toBeInTheDocument();
    expect(screen.queryByLabelText("Validation mode")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Rescore")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Retailor")).not.toBeInTheDocument();
  });

  it("renders supplemental content only for the active stage", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <StageTriggerPanel
        stagePanels={{
          discover: <div>Discover supplemental controls</div>,
          score: <div>Score supplemental controls</div>,
        }}
      />,
    );

    expect(screen.getByText("Discover supplemental controls")).toBeInTheDocument();
    expect(screen.queryByText("Score supplemental controls")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Score" }));

    expect(screen.getByText("Score supplemental controls")).toBeInTheDocument();
    expect(screen.queryByText("Discover supplemental controls")).not.toBeInTheDocument();
  });

  it("submits a bounded Discover run from the stage tab", async () => {
    const user = userEvent.setup();
    const runPipelineStages = vi.fn(async (): Promise<PipelineStageRunResponse> => ({
      ok: true as const,
      action: "run_stage" as const,
      status: "succeeded",
      jobKey: "pipeline",
      count: 1,
      command: {
        stages: ["discover"],
        limit: 1,
        workers: 1,
        minScore: 7,
        validationMode: "normal" as const,
        dryRun: false,
        rescore: false,
        retailor: false,
        headless: false,
        model: "haiku",
        continuous: false,
      },
      actions: [],
    }));
    renderWithProviders(<StageTriggerPanel />, {
      ports: buildTestPorts({ api: { runPipelineStages } }),
    });

    await user.clear(screen.getByLabelText("Limit"));
    await user.type(screen.getByLabelText("Limit"), "1");
    await user.click(screen.getByLabelText("Dry run"));
    await user.click(screen.getByRole("button", { name: "Run Discover" }));

    await waitFor(() => expect(runPipelineStages).toHaveBeenCalledTimes(1));
    expect(runPipelineStages).toHaveBeenCalledWith({
      stages: ["discover"],
      limit: 1,
      workers: 1,
      minScore: 7,
      validationMode: "normal",
      dryRun: false,
      rescore: false,
      retailor: false,
      headless: false,
      model: "haiku",
      continuous: false,
    });
  });

  it("submits the active stage and its persisted options through the pipeline mutation", async () => {
    const user = userEvent.setup();
    const runPipelineStages = vi.fn(async (): Promise<PipelineStageRunResponse> => ({
      ok: true as const,
      action: "run_stage" as const,
      status: "queued",
      jobKey: "pipeline",
      count: 1,
      command: {
        stages: ["apply"],
        limit: 12,
        workers: 3,
        minScore: 8,
        validationMode: "normal" as const,
        dryRun: true,
        rescore: false,
        retailor: false,
        headless: true,
        model: "sonnet",
        continuous: true,
      },
      actions: [
        {
          ok: true as const,
          runId: "apply-run-123",
          actionId: "apply-run-123",
          action: "apply",
          status: "queued",
          jobKey: "pipeline",
          command: {
            action: "apply",
            jobKey: "pipeline",
            stage: "apply",
            limit: 12,
            workers: 3,
            minScore: 8,
            dryRun: true,
            headless: true,
            model: "sonnet",
            continuous: true,
          },
        },
      ],
    }));
    renderWithProviders(<StageTriggerPanel />, {
      ports: buildTestPorts({ api: { runPipelineStages } }),
    });

    await user.click(screen.getByRole("tab", { name: "Apply" }));
    await user.clear(screen.getByLabelText("Limit"));
    await user.type(screen.getByLabelText("Limit"), "12");
    await user.clear(screen.getByLabelText("Workers"));
    await user.type(screen.getByLabelText("Workers"), "3");
    await user.clear(screen.getByLabelText("Minimum score"));
    await user.type(screen.getByLabelText("Minimum score"), "8");
    await user.click(screen.getByLabelText("Headless browser"));
    await user.click(screen.getByLabelText("Continuous"));
    await user.selectOptions(screen.getByLabelText("Apply model"), "sonnet");
    await user.click(screen.getByRole("button", { name: "Run Apply" }));

    await waitFor(() => expect(runPipelineStages).toHaveBeenCalledTimes(1));
    expect(runPipelineStages).toHaveBeenCalledWith({
      stages: ["apply"],
      limit: 12,
      workers: 3,
      minScore: 8,
      validationMode: "normal",
      dryRun: true,
      rescore: false,
      retailor: false,
      headless: true,
      model: "sonnet",
      continuous: true,
    });
    expect(await screen.findByText("Apply queued successfully (run apply-run-123).")).toBeInTheDocument();
  });

  it("shows a live starting status while the worker request is pending", async () => {
    const user = userEvent.setup();
    const runPipelineStages = vi.fn(() => new Promise<PipelineStageRunResponse>(() => undefined));
    renderWithProviders(<StageTriggerPanel />, {
      ports: buildTestPorts({ api: { runPipelineStages } }),
    });

    await user.click(screen.getByRole("button", { name: "Run Discover" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Starting Discover... waiting for local worker response.",
    );
  });

  it("replaces the local starting label with the latest backend stage event", async () => {
    const user = userEvent.setup();
    const runPipelineStages = vi.fn(() => new Promise<PipelineStageRunResponse>(() => undefined));
    renderWithProviders(<StageTriggerPanel />, {
      ports: buildTestPorts({
        api: {
          dashboardSummary: vi.fn(async () => ({
            ...sampleDashboardSummary,
            activity: [
              {
                eventId: "538",
                eventType: "StageStarted",
                jobKey: "pipeline",
                title: null,
                company: null,
                stage: "discover",
                level: "info",
                message: "Discovery source workday started",
                at: new Date().toISOString(),
              },
            ],
          })),
          runPipelineStages,
        },
      }),
    });

    await user.click(screen.getByRole("button", { name: "Run Discover" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Discover in progress: Discovery source workday started (#538).",
    );
  });

  it("shows the latest backend stage event even without local mutation state", async () => {
    renderWithProviders(<StageTriggerPanel />, {
      ports: buildTestPorts({
        api: {
          dashboardSummary: vi.fn(async () => ({
            ...sampleDashboardSummary,
            activity: [
              {
                eventId: "539",
                eventType: "StageStarted",
                jobKey: "pipeline",
                title: null,
                company: null,
                stage: "discover",
                level: "info",
                message: "Discovery source smart extract started",
                at: new Date().toISOString(),
              },
            ],
          })),
        },
      }),
    });

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Discover in progress: Discovery source smart extract started (#539).",
    );
  });

  it("surfaces failed worker action responses", async () => {
    const user = userEvent.setup();
    const runPipelineStages = vi.fn(async (): Promise<PipelineStageRunResponse> => ({
      ok: true as const,
      action: "run_stage" as const,
      status: "failed",
      jobKey: "pipeline",
      count: 1,
      command: {
        stages: ["score"],
        limit: 12,
        workers: 1,
        minScore: 7,
        validationMode: "normal" as const,
        dryRun: true,
        rescore: false,
        retailor: false,
        headless: false,
        model: "haiku",
        continuous: false,
      },
      actions: [
        {
          ok: true as const,
          runId: "action-score",
          actionId: "action-score",
          action: "run_stage",
          status: "failed",
          jobKey: "pipeline",
          command: {
            action: "run_stage",
            jobKey: "pipeline",
            stage: "score",
            limit: 12,
            workers: 1,
            minScore: 7,
            validationMode: "normal",
            dryRun: true,
            rescore: false,
            retailor: false,
          },
          message: "Worker unavailable.",
        },
      ],
    }));
    renderWithProviders(<StageTriggerPanel />, {
      ports: buildTestPorts({ api: { runPipelineStages } }),
    });

    await user.click(screen.getByRole("tab", { name: "Score" }));
    await user.click(screen.getByRole("button", { name: "Run Score" }));

    expect(await screen.findByText("Score failed to start: Worker unavailable.")).toBeInTheDocument();
  });

  it("keeps separate per-stage tab config and restores it after remount", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<StageTriggerPanel />);

    expect(screen.getByRole("tab", { name: "Discover" })).toHaveAttribute("aria-selected", "true");
    await user.clear(screen.getByLabelText("Workers"));
    await user.type(screen.getByLabelText("Workers"), "5");

    await user.click(screen.getByRole("tab", { name: "Tailor" }));
    await user.clear(screen.getByLabelText("Limit"));
    await user.type(screen.getByLabelText("Limit"), "13");
    await user.click(screen.getByLabelText("Retailor"));

    await user.click(screen.getByRole("tab", { name: "Discover" }));
    expect(screen.getByLabelText("Workers")).toHaveValue(5);
    expect(screen.queryByLabelText("Retailor")).not.toBeInTheDocument();

    unmount();
    renderWithProviders(<StageTriggerPanel />);

    expect(screen.getByRole("tab", { name: "Discover" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Workers")).toHaveValue(5);

    await user.click(screen.getByRole("tab", { name: "Tailor" }));
    expect(screen.getByLabelText("Limit")).toHaveValue(13);
    expect(screen.getByLabelText("Retailor")).toBeChecked();
  });
});
