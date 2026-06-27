import { DEFAULT_PIPELINE_LLM_MODEL, type PipelineStageRunResponse } from "@jobhunter/contracts";
import { userEvent } from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { sampleDashboardSummary, sampleHealthResponse } from "../../../test/fixtures/projections.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useStageTriggerStore } from "../stores/stage-trigger-store.js";
import { StageTriggerPanel } from "./StageTriggerPanel.js";

describe("StageTriggerPanel", () => {
  beforeEach(() => {
    window.localStorage.removeItem?.("jh:stage-trigger-config");
    useStageTriggerStore.getState().reset();
  });

  it("defaults to the Discover tab with dry-run enabled", async () => {
    renderWithProviders(<StageTriggerPanel />);

    expect(screen.getByLabelText("Dry run")).toBeChecked();
    expect(await screen.findByRole("button", { name: "Run Discover" })).toBeEnabled();
  });

  it("blocks stage runs when the JobHunter automation worker heartbeat is missing", async () => {
    const user = userEvent.setup();
    const runPipelineStages = vi.fn();
    renderWithProviders(<StageTriggerPanel />, {
      ports: buildTestPorts({
        api: {
          health: vi.fn(async () => ({
            ...sampleHealthResponse,
            worker: {
              ...sampleHealthResponse.worker,
              status: "missing" as const,
              message: "No JobHunter automation worker heartbeat has been written to the API database.",
              heartbeat: null,
            },
          })),
          runPipelineStages,
        },
      }),
    });

    expect(await screen.findByRole("button", { name: "Worker unavailable" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "No JobHunter automation worker heartbeat has been written to the API database.",
    );
    await user.click(screen.getByRole("button", { name: "Worker unavailable" }));
    expect(runPipelineStages).not.toHaveBeenCalled();
  });

  it("rechecks worker runtime health immediately before dispatching a stage run", async () => {
    const user = userEvent.setup();
    const runPipelineStages = vi.fn();
    const health = vi
      .fn()
      .mockResolvedValueOnce(sampleHealthResponse)
      .mockResolvedValueOnce({
        ...sampleHealthResponse,
        worker: {
          ...sampleHealthResponse.worker,
          status: "mismatched" as const,
          message:
            "JobHunter automation worker runtime does not match the API runtime: worker DB /tmp/old.db, API DB /tmp/new.db.",
        },
      });
    renderWithProviders(<StageTriggerPanel />, {
      ports: buildTestPorts({
        api: {
          health,
          runPipelineStages,
        },
      }),
    });

    expect(await screen.findByRole("button", { name: "Run Discover" })).toBeEnabled();

    await user.click(await screen.findByRole("button", { name: "Run Discover" }));

    await waitFor(() => expect(health).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Worker unavailable" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "JobHunter automation worker runtime does not match the API runtime",
    );
    expect(runPipelineStages).not.toHaveBeenCalled();
  });

  it("renders a matching tabpanel for every stage trigger", () => {
    renderWithProviders(<StageTriggerPanel />);

    expect(screen.getAllByRole("tabpanel", { hidden: true })).toHaveLength(2);
    expect(screen.queryByRole("tab", { name: "Enrich" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Score" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Tailor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Cover" })).not.toBeInTheDocument();

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
    expect(screen.queryByLabelText("Tailor models")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Rescore")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Re-tailor")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Headless browser")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Continuous")).not.toBeInTheDocument();

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
    expect(screen.queryByLabelText("Re-tailor")).not.toBeInTheDocument();
  });

  it("renders supplemental content only for the active stage", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <StageTriggerPanel
        stagePanels={{
          discover: <div>Discover supplemental controls</div>,
          apply: <div>Apply supplemental controls</div>,
        }}
      />,
    );

    expect(screen.getByText("Discover supplemental controls")).toBeInTheDocument();
    expect(screen.queryByText("Apply supplemental controls")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Apply" }));

    expect(screen.getByText("Apply supplemental controls")).toBeInTheDocument();
    expect(screen.queryByText("Discover supplemental controls")).not.toBeInTheDocument();
  });

  it("submits a bounded Discover run from the stage tab", async () => {
    const user = userEvent.setup();
    const runPipelineStages = vi.fn(async (_request: unknown): Promise<PipelineStageRunResponse> => ({
      ok: true as const,
      action: "run_stage" as const,
      status: "succeeded",
      jobKey: "pipeline",
      count: 1,
      command: {
        stages: ["discover"],
        limit: 1000,
        workers: 1,
        minScore: 7,
        validationMode: "normal" as const,
        dryRun: false,
        rescore: false,
        retailor: false,
        headless: false,
        model: "default",
        llmModel: DEFAULT_PIPELINE_LLM_MODEL,
        tailorModels: [],
        continuous: false,
      },
      actions: [],
    }));
    renderWithProviders(<StageTriggerPanel />, {
      ports: buildTestPorts({ api: { runPipelineStages } }),
    });

    const limitInput = screen.getByLabelText("Limit");
    expect(limitInput).toHaveAttribute("max", "1000");
    await user.clear(limitInput);
    await user.type(limitInput, "1000");
    await user.selectOptions(await screen.findByLabelText("Source"), "jobspy:linkedin");
    await user.click(screen.getByLabelText("Dry run"));
    await user.click(await screen.findByRole("button", { name: "Run Discover" }));

    await waitFor(() => expect(runPipelineStages).toHaveBeenCalledTimes(1));
    const request = runPipelineStages.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      stages: ["discover"],
      limit: 1000,
      workers: 1,
      minScore: 7,
      validationMode: "normal",
      dryRun: false,
      rescore: false,
      retailor: false,
      tailorModels: [],
      tailorJudgeModel: undefined,
      headless: false,
      model: "default",
      llmModel: DEFAULT_PIPELINE_LLM_MODEL,
      continuous: false,
      sourceIds: ["jobspy:linkedin"],
    });
    expect(request).not.toHaveProperty("tailorJudgeMinScore");
  });

  it("shows a stop control for queued pipeline stage runs", async () => {
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
    const runPipelineStages = vi.fn(async (_request: unknown): Promise<PipelineStageRunResponse> => ({
      ok: true as const,
      action: "run_stage" as const,
      status: "queued",
      jobKey: "pipeline",
      count: 1,
      command: {
        stages: ["discover"],
        limit: 25,
        workers: 1,
        minScore: 7,
        validationMode: "normal" as const,
        dryRun: true,
        rescore: false,
        retailor: false,
        headless: false,
        model: "default",
        llmModel: DEFAULT_PIPELINE_LLM_MODEL,
        tailorModels: [],
        continuous: false,
      },
      actions: [
        {
          ok: true as const,
          runId: "discover-run-1",
          workflowId: "discover-run-1",
          actionId: "discover-run-1",
          action: "run_stage" as const,
          status: "queued",
          jobKey: "pipeline",
          command: {
            action: "run_stage" as const,
            jobKey: "pipeline",
            stage: "discover",
            limit: 25,
            workers: 1,
            minScore: 7,
            validationMode: "normal",
            dryRun: true,
            rescore: false,
            retailor: false,
            headless: false,
            continuous: false,
          },
        },
      ],
    }));
    renderWithProviders(<StageTriggerPanel />, {
      ports: buildTestPorts({ api: { cancelWorkflowRun, runPipelineStages } }),
    });

    await user.click(await screen.findByRole("button", { name: "Run Discover" }));
    await user.click(await screen.findByRole("button", { name: "Stop Discover run" }));

    await waitFor(() => expect(cancelWorkflowRun).toHaveBeenCalledWith("discover-run-1"));
  });

  it("submits the active stage and its persisted options through the pipeline mutation", async () => {
    const user = userEvent.setup();
    const runPipelineStages = vi.fn(async (_request: unknown): Promise<PipelineStageRunResponse> => ({
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
        llmModel: DEFAULT_PIPELINE_LLM_MODEL,
        tailorModels: [],
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
            llmModel: DEFAULT_PIPELINE_LLM_MODEL,
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
    const request = runPipelineStages.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      stages: ["apply"],
      limit: 12,
      workers: 3,
      minScore: 8,
      validationMode: "normal",
      dryRun: true,
      rescore: false,
      retailor: false,
      tailorModels: [],
      tailorJudgeModel: undefined,
      headless: true,
      model: "sonnet",
      llmModel: DEFAULT_PIPELINE_LLM_MODEL,
      continuous: true,
    });
    expect(request).not.toHaveProperty("tailorJudgeMinScore");
    expect(await screen.findByText("Apply queued successfully (run apply-run-123).")).toBeInTheDocument();
  });

  it("does not expose Tailor as a product pipeline stage", () => {
    renderWithProviders(<StageTriggerPanel />);

    expect(screen.queryByRole("tab", { name: "Tailor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run Tailor" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Tailor models")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Judge model")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Minimum judge score")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Re-tailor")).not.toBeInTheDocument();
  });

  it("shows a live starting status while the worker request is pending", async () => {
    const user = userEvent.setup();
    const runPipelineStages = vi.fn(() => new Promise<PipelineStageRunResponse>(() => undefined));
    renderWithProviders(<StageTriggerPanel />, {
      ports: buildTestPorts({ api: { runPipelineStages } }),
    });

    await user.click(await screen.findByRole("button", { name: "Run Discover" }));

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

    await user.click(await screen.findByRole("button", { name: "Run Discover" }));

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

  it("shows backend discovery percent progress when available", async () => {
    renderWithProviders(<StageTriggerPanel />, {
      ports: buildTestPorts({
        api: {
          dashboardSummary: vi.fn(async () => ({
            ...sampleDashboardSummary,
            progress: [
              {
                stage: "discover" as const,
                status: "running" as const,
                percent: 60,
                completed: 3,
                total: 5,
                currentStep: "Workday scraper",
                message: "Workday scraper complete",
                updatedAt: new Date().toISOString(),
              },
            ],
          })),
        },
      }),
    });

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Discover 60% complete (3/5): Workday scraper complete.",
    );
    expect(screen.getByRole("progressbar", { name: "Discover progress" })).toHaveAttribute("value", "60");
  });

  it("shows source-level discovery progress instead of opaque stage counts", async () => {
    renderWithProviders(<StageTriggerPanel />, {
      ports: buildTestPorts({
        api: {
          dashboardSummary: vi.fn(async () => ({
            ...sampleDashboardSummary,
            progress: [
              {
                stage: "discover" as const,
                status: "running" as const,
                percent: 8,
                completed: 0,
                total: 6,
                currentStep: "JobSpy",
                message: "JobSpy search completed",
                updatedAt: new Date().toISOString(),
                sourceProgress: {
                  completed: 35,
                  total: 72,
                  unit: "searches",
                  currentQuery: "Head of Platform",
                  currentLocation: "Spain (remote)",
                  newJobs: 13,
                  existingJobs: 46,
                  filteredJobs: 412,
                  errorCount: 0,
                  rawTotal: 1000,
                },
              },
            ],
          })),
        },
      }),
    });

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(
      "Discover 8% complete: JobSpy 35/72 searches done: Head of Platform in Spain (remote); 13 new, 46 dupes, 412 filtered, 0 errors, 1000 found.",
    );
    expect(status).not.toHaveTextContent("(0/6)");
    expect(screen.getByRole("progressbar", { name: "Discover progress" })).toHaveAttribute("value", "8");
  });

  it("describes partial preparation progress as automatically retried and actionable", async () => {
    renderWithProviders(<StageTriggerPanel />, {
      ports: buildTestPorts({
        api: {
          dashboardSummary: vi.fn(async () => ({
            ...sampleDashboardSummary,
            progress: [
              {
                stage: "discover" as const,
                status: "partial" as const,
                percent: 100,
                completed: 1,
                total: 1,
                currentStep: null,
                message: "Stage completed with warnings",
                updatedAt: new Date().toISOString(),
              },
            ],
          })),
        },
      }),
    });

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Discover 100% complete with warnings (1/1): Discovery finished with warnings. Recoverable scoring and tailoring work is retried automatically; items that exhaust retry attempts need attention from the job details.",
    );
    expect(screen.getByRole("progressbar", { name: "Discover progress" })).toHaveAttribute("value", "100");
  });

  it("shows a stop control for backend running discovery progress", async () => {
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
    renderWithProviders(<StageTriggerPanel />, {
      ports: buildTestPorts({
        api: {
          cancelWorkflowRun,
          dashboardSummary: vi.fn(async () => ({
            ...sampleDashboardSummary,
            progress: [
              {
                stage: "discover" as const,
                status: "running" as const,
                runId: "discovery:jobspy:run-1",
                workflowId: "workflow-run-1",
                percent: 0,
                completed: 0,
                total: 5,
                currentStep: "JobSpy",
                message: "JobSpy started",
                updatedAt: new Date().toISOString(),
              },
            ],
          })),
        },
      }),
    });

    await user.click(await screen.findByRole("button", { name: "Stop Discover run" }));

    await waitFor(() => expect(cancelWorkflowRun).toHaveBeenCalledWith("workflow-run-1"));
  });

  it("describes failed backend discovery progress as not running and runnable again", async () => {
    renderWithProviders(<StageTriggerPanel />, {
      ports: buildTestPorts({
        api: {
          dashboardSummary: vi.fn(async () => ({
            ...sampleDashboardSummary,
            progress: [
              {
                stage: "discover" as const,
                status: "failed" as const,
                percent: 60,
                completed: 3,
                total: 5,
                currentStep: "Smart extract",
                message: "Discovery source smartextract was left running by a prior worker.",
                updatedAt: new Date().toISOString(),
              },
            ],
          })),
        },
      }),
    });

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Discover not running. Last progress 60% (3/5): Smart extract is ready to run again.",
    );
    expect(screen.getByRole("progressbar", { name: "Discover progress" })).toHaveAttribute("value", "60");
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
        stages: ["discover"],
        limit: 12,
        workers: 1,
        minScore: 7,
        validationMode: "normal" as const,
        dryRun: true,
        rescore: false,
        retailor: false,
        headless: false,
        model: "default",
        llmModel: DEFAULT_PIPELINE_LLM_MODEL,
        tailorModels: [],
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
            stage: "discover",
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

    await user.click(await screen.findByRole("button", { name: "Run Discover" }));

    expect(await screen.findByText("Discover failed to start: Worker unavailable.")).toBeInTheDocument();
  });

  it("keeps separate per-stage tab config and restores it after remount", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<StageTriggerPanel />);

    expect(screen.getByRole("tab", { name: "Discover" })).toHaveAttribute("aria-selected", "true");
    await user.clear(screen.getByLabelText("Workers"));
    await user.type(screen.getByLabelText("Workers"), "5");

    await user.click(screen.getByRole("tab", { name: "Apply" }));
    await user.clear(screen.getByLabelText("Limit"));
    await user.type(screen.getByLabelText("Limit"), "13");
    await user.click(screen.getByLabelText("Headless browser"));

    await user.click(screen.getByRole("tab", { name: "Discover" }));
    expect(screen.getByLabelText("Workers")).toHaveValue(5);
    expect(screen.queryByLabelText("Re-tailor")).not.toBeInTheDocument();

    unmount();
    renderWithProviders(<StageTriggerPanel />);

    expect(screen.getByRole("tab", { name: "Discover" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Workers")).toHaveValue(5);

    await user.click(screen.getByRole("tab", { name: "Apply" }));
    expect(screen.getByLabelText("Limit")).toHaveValue(13);
    expect(screen.getByLabelText("Headless browser")).toBeChecked();
  });
});
