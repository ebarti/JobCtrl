import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeJobDetail, sampleJob } from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { ScoreCorrectionControl } from "./ScoreCorrectionControl.js";

describe("<ScoreCorrectionControl>", () => {
  it("submits a corrected score through the scoring mutation", async () => {
    const user = userEvent.setup();
    const correctScore = vi.fn(async () =>
      makeJobDetail({ ...sampleJob, fitScore: 6 }),
    );
    renderWithProviders(
      <ScoreCorrectionControl jobId="job-1" currentScore={8} />,
      { ports: buildTestPorts({ api: { correctScore } }) },
    );

    const scoreInput = screen.getByLabelText("Correct score");
    const reasonInput = screen.getByLabelText("Reason");
    const submit = screen.getByRole("button", { name: "Save score correction" });
    expect(scoreInput).toHaveAttribute("data-slot", "input");
    expect(reasonInput).toHaveAttribute("data-slot", "input");
    expect(submit).toHaveAttribute("data-slot", "button");

    await user.clear(scoreInput);
    await user.type(scoreInput, "6");
    await user.type(reasonInput, "Manual review found a mismatch.");
    await user.click(submit);

    await waitFor(() =>
      expect(correctScore).toHaveBeenCalledWith("job-1", {
        correctedScore: 6,
        reason: "Manual review found a mismatch.",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Scoring policy updated; comparable scores may be stale.",
    );
  });

  it("blocks empty corrected scores before optimistic mutation", async () => {
    const user = userEvent.setup();
    const correctScore = vi.fn(async () =>
      makeJobDetail({ ...sampleJob, fitScore: 6 }),
    );
    renderWithProviders(
      <ScoreCorrectionControl jobId="job-1" currentScore={8} />,
      { ports: buildTestPorts({ api: { correctScore } }) },
    );

    await user.clear(screen.getByLabelText("Correct score"));
    await user.type(screen.getByLabelText("Reason"), "Manual review found a mismatch.");

    expect(screen.getByRole("button", { name: "Save score correction" })).toBeDisabled();
    expect(correctScore).not.toHaveBeenCalled();
  });

  it("blocks out-of-range corrected scores before optimistic mutation", async () => {
    const user = userEvent.setup();
    const correctScore = vi.fn(async () =>
      makeJobDetail({ ...sampleJob, fitScore: 6 }),
    );
    renderWithProviders(
      <ScoreCorrectionControl jobId="job-1" currentScore={8} />,
      { ports: buildTestPorts({ api: { correctScore } }) },
    );

    await user.clear(screen.getByLabelText("Correct score"));
    await user.type(screen.getByLabelText("Correct score"), "11");
    await user.type(screen.getByLabelText("Reason"), "Manual review found a mismatch.");

    expect(screen.getByRole("button", { name: "Save score correction" })).toBeDisabled();
    expect(correctScore).not.toHaveBeenCalled();
  });
});
