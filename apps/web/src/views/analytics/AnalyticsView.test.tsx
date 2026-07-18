import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { http, HttpResponse } from "msw";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { analyticsSearchSchema } from "../../routes/-analytics.search.js";
import { sampleOutcomeAnalyticsSummary } from "../../test/fixtures/projections.js";
import { server } from "../../test/msw/server.js";
import { buildProviderHarness } from "../../test/render.js";
import { AnalyticsView } from "./AnalyticsView.js";

function buildRouter(harness: ReturnType<typeof buildProviderHarness>, initialEntry = "/analytics") {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const analyticsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/analytics",
    validateSearch: analyticsSearchSchema,
    component: () => <AnalyticsView />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([analyticsRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  return { router, Wrapper: harness.Wrapper };
}

describe("<AnalyticsView>", () => {
  it("renders the analytics read model with the required small-sample and non-causal caption", async () => {
    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness, "/analytics?dimension=fit_band");
    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByText("11 applied")).toBeInTheDocument());

    expect(screen.getByRole("heading", { name: "Outcome analytics" })).toBeInTheDocument();
    expect(screen.getByText(/Recorded outcomes from canonical rows only/i)).toBeInTheDocument();
    expect(screen.getByText(/not causal claims/i)).toBeInTheDocument();
    expect(screen.getByText(/Analytics never enter scoring, ranking, or apply eligibility/i)).toBeInTheDocument();
    expect(screen.getByText("4d")).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.getByText("excellent")).toBeInTheDocument();
    expect(
      screen
        .getByText("excellent")
        .closest("tr")
        ?.querySelector('[data-slot="status-badge"]'),
    ).toHaveAttribute("data-status-tone", "muted");
    expect(screen.getByText("stretch")).toBeInTheDocument();
    expect(screen.getAllByText(/too few to rate/i).length).toBeGreaterThan(0);
  });

  it("assigns named typography roles to outcome summary labels and values", async () => {
    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByText("11 applied")).toBeInTheDocument());

    const appliedLabel = screen.getAllByText("Applied").find((element) => element.tagName === "DT");
    expect(appliedLabel).toBeDefined();
    const summary = appliedLabel!.closest("dl.analytics-summary-strip");
    expect(summary).not.toBeNull();
    for (const metric of summary!.querySelectorAll(".analytics-summary-metric")) {
      expect(metric.querySelector("dt")).toHaveAttribute("data-typography", "label");
      expect(metric.querySelector("dd")).toHaveAttribute("data-typography", "metric");
    }
    expect(screen.getByText("Breakdown")).toHaveAttribute(
      "data-typography",
      "label",
    );
    expect(document.querySelector(".analytics-controls-copy > strong")).toHaveAttribute(
      "data-typography",
      "component-title",
    );
  });

  it("keeps dimension selection in the URL search state", async () => {
    const user = userEvent.setup();
    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByText("11 applied")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Break down outcomes by apply mode" }));

    expect(router.state.location.search).toMatchObject({ dimension: "apply_mode" });
    expect(screen.getByText("automated live")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Break down outcomes by template" }));
    expect(router.state.location.search).toMatchObject({ dimension: "template" });
    expect(screen.getByText("Modern compact")).toBeInTheDocument();
  });

  it("renders the empty state without fabricating rows", async () => {
    server.use(
      http.get("*/v1/analytics/outcomes", () =>
        HttpResponse.json({
          ...sampleOutcomeAnalyticsSummary,
          totals: {
            n: 0,
            applied: 0,
            reply: 0,
            interview: 0,
            offer: 0,
            rejection: 0,
            replyRate: null,
            interviewRate: null,
            offerRate: null,
            rejectionRate: null,
          },
          bySource: [],
          byScoreBand: [],
          byFitBand: [],
          byApplyMode: [],
          byTemplate: [],
          byPolicy: [],
          timeToResponse: { n: 0, medianMinutes: null },
          suggestionAccuracy: {
            n: 0,
            decided: 0,
            accepted: 0,
            corrected: 0,
            ignored: 0,
            acceptanceRate: null,
          },
        }),
      ),
    );
    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness, "/analytics?dimension=source");
    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(() =>
      expect(screen.getByText("No source outcome rows yet.")).toBeInTheDocument(),
    );
    expect(screen.queryByText("100%")).not.toBeInTheDocument();
  });

  it("marks analytics load failures with a semantic alert icon", async () => {
    server.use(
      http.get("*/v1/analytics/outcomes", () =>
        new HttpResponse(JSON.stringify({ ok: false, error: "analytics unavailable" }), {
          status: 503,
        }),
      ),
    );
    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    const title = await screen.findByText("Outcome analytics could not be loaded");
    const alert = title.closest('[data-slot="alert"]');
    expect(alert?.querySelector("svg.tabler-icon-alert-triangle")).toBeInTheDocument();
  });

  it("does not render denied recommendation copy in headings, captions, or column labels", async () => {
    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByText("11 applied")).toBeInTheDocument());

    const headingsCaptionsAndLabels = [
      ...screen.getAllByRole("heading").map((element) => element.textContent ?? ""),
      ...screen.getAllByRole("columnheader").map((element) => element.textContent ?? ""),
      ...screen.getAllByText(/Recorded outcomes/i).map((element) => element.textContent ?? ""),
    ].join(" ");
    const blockedPhrases = [
      ["be", "st"].join(""),
      ["bett", "er"].join(""),
      ["win", "ner"].join(""),
      "optimal",
      ["rec", "ommended"].join(""),
      ["use", " this"].join(""),
    ];
    for (const phrase of blockedPhrases) {
      expect(headingsCaptionsAndLabels.toLowerCase()).not.toContain(phrase);
    }
  });
});
