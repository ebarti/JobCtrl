import { http, HttpResponse } from "msw";
import { screen, waitForElementToBeRemoved } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { server } from "../../test/msw/server.js";
import { renderWithProviders } from "../../test/render.js";
import { DashboardView } from "./DashboardView.js";

describe("DashboardView", () => {
  it("renders the BR-007 operations surfaces without pipeline action controls", async () => {
    renderWithProviders(<DashboardView />);

    const loading = screen.queryByText("Loading dashboard.");
    if (loading) {
      await waitForElementToBeRemoved(loading);
    }

    expect(screen.queryByRole("heading", { name: "Pipeline actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Discovery controls" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Work status" })).toBeInTheDocument();
    expect(screen.getByText("Active work")).toBeInTheDocument();
    expect(screen.getByText("Stuck work")).toBeInTheDocument();
    expect(screen.getByText("worker unavailable · stale over 2m 30s")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Active runs" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recent activity" })).toBeInTheDocument();
    expect(screen.getByText("Job scored 8/10")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Daily digest" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Outcome suggestions" })).toBeInTheDocument();
    expect(screen.getByText("Recruiter reply indicates an interview request.")).toBeInTheDocument();
    expect(screen.getByText("stuck").querySelector("svg")).toHaveClass("tabler-icon-ban");
    expect(screen.getByText("in progress").querySelector("svg")).toHaveClass("tabler-icon-clock");
    expect(screen.getByText("info").querySelector("svg")).toHaveClass("tabler-icon-info-circle");
  });

  it("surfaces workflow-run read failures inside the active-runs card", async () => {
    server.use(
      http.get("*/v1/workflow-runs", () =>
        new HttpResponse(JSON.stringify({ ok: false, error: "runs unavailable" }), {
          status: 503,
        }),
      ),
    );

    renderWithProviders(<DashboardView />);

    expect(await screen.findByRole("heading", { name: "Active runs" })).toBeInTheDocument();
    expect(await screen.findByText(/JobCtrl API request failed: 503/i)).toBeInTheDocument();
  });

  it("marks dashboard load failures with a semantic alert icon", async () => {
    server.use(
      http.get("*/v1/dashboard/summary", () =>
        new HttpResponse(JSON.stringify({ ok: false, error: "summary unavailable" }), {
          status: 503,
        }),
      ),
    );

    renderWithProviders(<DashboardView />);

    const title = await screen.findByText("Dashboard unavailable");
    const alert = title.closest('[data-slot="alert"]');
    expect(alert?.querySelector("svg.tabler-icon-alert-triangle")).toBeInTheDocument();
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

    expect(await screen.findByText("No application outcomes yet")).toBeInTheDocument();
    expect(screen.getByText(/Conversion rates appear after you apply/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review applied jobs" })).toHaveAttribute(
      "href",
      expect.stringContaining("applyStatus=applied"),
    );
    expect(screen.queryByRole("heading", { name: "By source" })).not.toBeInTheDocument();
  });
});
