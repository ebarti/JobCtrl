import type { PipelineStageRunResponse } from "@jobhunter/contracts";
import { userEvent } from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
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

  it("only shows controls that apply to the active stage", async () => {
    const user = userEvent.setup();
    renderWithProviders(<StageTriggerPanel />);

    expect(screen.getByLabelText("Workers")).toBeInTheDocument();
    expect(screen.getByLabelText("Dry run")).toBeInTheDocument();
    expect(screen.queryByLabelText("Limit")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Minimum score")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Validation mode")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Apply model")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Rescore")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Retailor")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Headless browser")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Continuous")).not.toBeInTheDocument();

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

  it("submits the active stage and its persisted options through the pipeline mutation", async () => {
    const user = userEvent.setup();
    const runPipelineStages = vi.fn(async (): Promise<PipelineStageRunResponse> => ({
      ok: true as const,
      action: "run_stage" as const,
      status: "accepted",
      jobKey: "pipeline",
      count: 2,
      command: {
        stages: ["score", "apply"],
        limit: 12,
        workers: 3,
        minScore: 8,
        validationMode: "strict" as const,
        dryRun: true,
        rescore: true,
        retailor: false,
        headless: true,
        model: "sonnet",
        continuous: false,
      },
      actions: [],
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
    expect(await screen.findByText("accepted 2 stage actions")).toBeInTheDocument();
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
