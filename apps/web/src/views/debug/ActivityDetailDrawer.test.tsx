import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../test/render.js";
import { ActivityDetailDrawer } from "./ActivityDetailDrawer.js";

describe("<ActivityDetailDrawer>", () => {
  it("renders the selected event as a route workspace without losing activity facts", async () => {
    renderWithProviders(<ActivityDetailDrawer eventId="evt-1" />, {
      withRouter: true,
    });

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Job scored 8/10",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Back to Debug" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open related job" })).toHaveAttribute(
      "href",
      "/jobs/job-1",
    );

    const inspector = screen.getByRole("complementary", {
      name: "Activity event facts",
    });
    for (const fact of [
      "evt-1",
      "JobScored",
      "score",
      "info",
      "job-1",
      "Staff Software Engineer",
      "Acme Corp",
      "Not exposed by the activity projection",
    ]) {
      expect(within(inspector).getByText(fact)).toBeInTheDocument();
    }

    const payload = screen.getByRole("region", {
      name: "Projected event payload",
    });
    expect(payload).toHaveTextContent('"eventId": "evt-1"');
    expect(payload).toHaveTextContent('"message": "Job scored 8/10"');

    const timeline = screen.getByRole("region", {
      name: "Activity event timeline",
    });
    expect(within(timeline).getByText("JobScored")).toBeInTheDocument();
    expect(within(timeline).getByText("Job scored 8/10")).toBeInTheDocument();
  });

  it("keeps the existing unavailable-event state", async () => {
    renderWithProviders(<ActivityDetailDrawer eventId="missing" />, {
      withRouter: true,
    });

    await waitFor(() =>
      expect(
        screen.getByText(
          "Activity event missing is no longer in the recent list.",
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
