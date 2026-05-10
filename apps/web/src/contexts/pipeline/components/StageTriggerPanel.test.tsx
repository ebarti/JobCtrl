import type { PipelineStageRunResponse } from "@jobhunter/contracts";
import { userEvent } from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { StageTriggerPanel } from "./StageTriggerPanel.js";

describe("StageTriggerPanel", () => {
  it("defaults to dry-run and disables submission until at least one stage is selected", () => {
    renderWithProviders(<StageTriggerPanel />);

    expect(screen.getByLabelText("Dry run")).toBeChecked();
    expect(screen.getByRole("button", { name: /Run selected stages/i })).toBeDisabled();
  });

  it("submits selected stages and options through the pipeline mutation", async () => {
    const user = userEvent.setup();
    const runPipelineStages = vi.fn(async (): Promise<PipelineStageRunResponse> => ({
      ok: true as const,
      action: "run_stage" as const,
      status: "queued",
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

    await user.click(screen.getByLabelText("Score"));
    await user.click(screen.getByLabelText("Apply"));
    await user.clear(screen.getByLabelText("Limit"));
    await user.type(screen.getByLabelText("Limit"), "12");
    await user.clear(screen.getByLabelText("Workers"));
    await user.type(screen.getByLabelText("Workers"), "3");
    await user.clear(screen.getByLabelText("Minimum score"));
    await user.type(screen.getByLabelText("Minimum score"), "8");
    await user.selectOptions(screen.getByLabelText("Validation mode"), "strict");
    await user.click(screen.getByLabelText("Rescore"));
    await user.click(screen.getByLabelText("Headless browser"));
    await user.clear(screen.getByLabelText("Apply model"));
    await user.type(screen.getByLabelText("Apply model"), "sonnet");
    await user.click(screen.getByRole("button", { name: /Run selected stages/i }));

    await waitFor(() => expect(runPipelineStages).toHaveBeenCalledTimes(1));
    expect(runPipelineStages).toHaveBeenCalledWith({
      stages: ["score", "apply"],
      limit: 12,
      workers: 3,
      minScore: 8,
      validationMode: "strict",
      dryRun: true,
      rescore: true,
      retailor: false,
      headless: true,
      model: "sonnet",
      continuous: false,
    });
    expect(await screen.findByText("queued 2 stage actions")).toBeInTheDocument();
  });
});
