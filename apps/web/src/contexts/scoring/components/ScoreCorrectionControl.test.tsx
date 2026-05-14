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

    await user.clear(screen.getByLabelText("Correct score"));
    await user.type(screen.getByLabelText("Correct score"), "6");
    await user.type(screen.getByLabelText("Reason"), "Manual review found a mismatch.");
    await user.click(screen.getByRole("button", { name: "Save score correction" }));

    await waitFor(() =>
      expect(correctScore).toHaveBeenCalledWith("job-1", {
        correctedScore: 6,
        reason: "Manual review found a mismatch.",
      }),
    );
  });
});
