import { http, HttpResponse } from "msw";
import { screen, waitForElementToBeRemoved } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { server } from "../../test/msw/server.js";
import { renderWithProviders } from "../../test/render.js";
import { DashboardView } from "./DashboardView.js";

describe("DashboardView", () => {
  it("does not render pipeline action controls", async () => {
    renderWithProviders(<DashboardView />);

    const loading = screen.queryByText("Loading dashboard.");
    if (loading) {
      await waitForElementToBeRemoved(loading);
    }

    expect(screen.queryByRole("heading", { name: "Pipeline actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Discovery controls" })).not.toBeInTheDocument();
    expect(screen.queryByText("Recent activity")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Outcome suggestions" })).toBeInTheDocument();
    expect(screen.getByText("Recruiter reply indicates an interview request.")).toBeInTheDocument();
  });

  it("shows a loading state before the summary resolves, then renders the conversion panel", async () => {
    renderWithProviders(<DashboardView />);

    expect(screen.getByText("Loading dashboard.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Conversion" })).not.toBeInTheDocument();

    expect(await screen.findByRole("heading", { name: "Conversion" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "By source" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "By score band" })).toBeInTheDocument();
  });

  it("renders the conversion empty state when there are no applications", async () => {
    server.use(
      http.get("*/v1/dashboard/summary", () =>
        HttpResponse.json({
          ...sampleDashboardSummary,
          conversion: {
            totals: {
              applied: 0,
              reply: 0,
              interview: 0,
              offer: 0,
              rejection: 0,
              replyRate: null,
              interviewRate: null,
              offerRate: null,
              rejectionRate: null,
              costPerInterview: null,
            },
            bySource: [],
            byBand: [],
          },
        }),
      ),
    );

    renderWithProviders(<DashboardView />);

    expect(
      await screen.findByText(
        "No applications yet. Conversion appears once you apply and record outcomes.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "By source" })).not.toBeInTheDocument();
  });
});
