import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useToastStore } from "../../../shared/stores/toasts.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { ResetStaleScoresButton } from "./ResetStaleScoresButton.js";

afterEach(() => {
  vi.restoreAllMocks();
  useToastStore.getState().clear();
});

describe("ResetStaleScoresButton", () => {
  it.each([false, true])("retains selection on active-owner skip: %s", async (skipped) => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onSuccess = vi.fn();
    const resetStaleScoresForRescore = vi.fn(async () => ({
      ok: true as const,
      count: skipped ? 0 : 1,
      jobKeys: skipped ? [] : ["synthetic-job"],
      nextAction: "",
      skippedActiveJobKeys: skipped ? ["synthetic-job"] : [],
      alreadyPendingJobKeys: [],
    }));
    const user = userEvent.setup();
    renderWithProviders(
      <ResetStaleScoresButton jobKeys={["synthetic-job"]} staleCount={1} onSuccess={onSuccess} />,
      { ports: buildTestPorts({ api: { resetStaleScoresForRescore } }) },
    );
    await user.click(screen.getByRole("button", { name: "Reset stale selected" }));
    await waitFor(() => expect(resetStaleScoresForRescore).toHaveBeenCalled());
    if (skipped) {
      expect(await screen.findByText(/wait for scoring to finish, then retry/i)).toBeInTheDocument();
      expect(onSuccess).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    }
  });
});
