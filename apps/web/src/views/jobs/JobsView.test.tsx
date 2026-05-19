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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import { makeJobsPage, sampleJob } from "../../test/fixtures/projections.js";
import { server } from "../../test/msw/server.js";
import { buildProviderHarness } from "../../test/render.js";
import { JobsView } from "./JobsView.js";

const SEARCH = "?stage=all&state=all&deleted=active&sort=discovered_at&dir=desc&page=1&pageSize=50";

function buildRouter(harness: ReturnType<typeof buildProviderHarness>) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const jobsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/jobs",
    validateSearch: jobsSearchSchema,
    component: () => <JobsView />,
  });
  const detailRoute = createRoute({
    getParentRoute: () => jobsRoute,
    path: "/$jobId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([jobsRoute.addChildren([detailRoute])]),
    history: createMemoryHistory({ initialEntries: [`/jobs${SEARCH}`] }),
  });
  return { router, queryClient: harness.queryClient, Wrapper: harness.Wrapper };
}

const originalConfirm = globalThis.window?.confirm;

beforeEach(() => {
  Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: () => true });
});

afterEach(() => {
  if (typeof originalConfirm === "function") {
    Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: originalConfirm });
  }
});

describe("<JobsView> bulk delete integration", () => {
  it("selects rows via checkbox, clicks delete, confirms, and posts to /v1/jobs/bulk-delete", async () => {
    const user = userEvent.setup();
    const calls: Array<{ jobKeys?: string[] }> = [];
    server.use(
      http.post("*/v1/jobs/bulk-delete", async ({ request }) => {
        const body = (await request.json()) as { jobKeys?: string[] };
        calls.push(body);
        return HttpResponse.json({ ok: true, count: body.jobKeys?.length ?? 0, jobKeys: body.jobKeys ?? [] });
      }),
    );

    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    const { container } = render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByText(/Acme Corp/i)).toBeInTheDocument(), {
      timeout: 5_000,
    });

    const checkboxes = container.querySelectorAll<HTMLInputElement>(
      "input[type='checkbox']",
    );
    expect(checkboxes.length).toBeGreaterThan(1);

    const rowCheckbox = Array.from(checkboxes).find(
      (input) => input.getAttribute("aria-label")?.includes("Select row") ?? false,
    ) ?? checkboxes[1]!;
    await user.click(rowCheckbox);

    await waitFor(() => expect(screen.getByText(/1 selected/i)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /delete selected/i }));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]?.jobKeys?.length).toBe(1);
  });

  it("aborts the mutation when window.confirm returns false", async () => {
    const user = userEvent.setup();
    const calls: number[] = [];
    server.use(
      http.post("*/v1/jobs/bulk-delete", () => {
        calls.push(1);
        return HttpResponse.json({ ok: true, count: 0, jobKeys: [] });
      }),
    );
    Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: () => false });

    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    const { container } = render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByText(/Acme Corp/i)).toBeInTheDocument(), {
      timeout: 5_000,
    });

    const checkboxes = container.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
    const rowCheckbox = Array.from(checkboxes).find(
      (input) => input.getAttribute("aria-label")?.includes("Select row") ?? false,
    ) ?? checkboxes[1]!;
    await user.click(rowCheckbox);
    await waitFor(() => expect(screen.getByText(/1 selected/i)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /delete selected/i }));
    expect(calls.length).toBe(0);
  });

  it("posts selected active jobs to /v1/jobs/bulk-hide", async () => {
    const user = userEvent.setup();
    const calls: Array<{ jobKeys?: string[] }> = [];
    server.use(
      http.post("*/v1/jobs/bulk-hide", async ({ request }) => {
        const body = (await request.json()) as { jobKeys?: string[] };
        calls.push(body);
        return HttpResponse.json({ ok: true, count: body.jobKeys?.length ?? 0, jobKeys: body.jobKeys ?? [] });
      }),
    );

    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    const { container } = render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByText(/Acme Corp/i)).toBeInTheDocument(), {
      timeout: 5_000,
    });

    const checkboxes = container.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
    const rowCheckbox = Array.from(checkboxes).find(
      (input) => input.getAttribute("aria-label")?.includes("Select row") ?? false,
    ) ?? checkboxes[1]!;
    await user.click(rowCheckbox);
    await waitFor(() => expect(screen.getByText(/1 selected/i)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /hide selected/i }));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]?.jobKeys?.length).toBe(1);
  });

  it("shows a hidden tab and posts selected hidden jobs to /v1/jobs/bulk-unhide", async () => {
    const user = userEvent.setup();
    const calls: Array<{ jobKeys?: string[] }> = [];
    server.use(
      http.post("*/v1/jobs/bulk-unhide", async ({ request }) => {
        const body = (await request.json()) as { jobKeys?: string[] };
        calls.push(body);
        return HttpResponse.json({ ok: true, count: body.jobKeys?.length ?? 0, jobKeys: body.jobKeys ?? [] });
      }),
    );

    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    const { container } = render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByRole("button", { name: /hidden jobs/i })).toBeInTheDocument(), {
      timeout: 5_000,
    });
    await user.click(screen.getByRole("button", { name: /hidden jobs/i }));
    await waitFor(() => expect(screen.getByText(/Acme Corp/i)).toBeInTheDocument(), {
      timeout: 5_000,
    });

    const checkboxes = container.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
    const rowCheckbox = Array.from(checkboxes).find(
      (input) => input.getAttribute("aria-label")?.includes("Select row") ?? false,
    ) ?? checkboxes[1]!;
    await user.click(rowCheckbox);
    await waitFor(() => expect(screen.getByText(/1 selected/i)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /unhide selected/i }));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]?.jobKeys?.length).toBe(1);
  });

  it("posts selected deleted jobs to /v1/jobs/bulk-delete-permanent", async () => {
    const user = userEvent.setup();
    const calls: Array<{ jobKeys?: string[] }> = [];
    server.use(
      http.post("*/v1/jobs/bulk-delete-permanent", async ({ request }) => {
        const body = (await request.json()) as { jobKeys?: string[] };
        calls.push(body);
        return HttpResponse.json({ ok: true, count: body.jobKeys?.length ?? 0, jobKeys: body.jobKeys ?? [] });
      }),
    );

    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    const { container } = render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByRole("button", { name: /deleted jobs/i })).toBeInTheDocument(), {
      timeout: 5_000,
    });
    await user.click(screen.getByRole("button", { name: /deleted jobs/i }));
    await waitFor(() => expect(screen.getByText(/Acme Corp/i)).toBeInTheDocument(), {
      timeout: 5_000,
    });

    const checkboxes = container.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
    const rowCheckbox = Array.from(checkboxes).find(
      (input) => input.getAttribute("aria-label")?.includes("Select row") ?? false,
    ) ?? checkboxes[1]!;
    await user.click(rowCheckbox);
    await waitFor(() => expect(screen.getByText(/1 selected/i)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /delete permanently selected/i }));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]?.jobKeys?.length).toBe(1);
  });

  it("shows stale score state and posts selected stale scores for rescore reset", async () => {
    const user = userEvent.setup();
    const staleJob = {
      ...sampleJob,
      jobKey: "job-stale",
      currentStage: "score" as const,
      currentState: "stale" as const,
      scoreStaleness: {
        isStale: true,
        staleReason: "scoring_policy_changed",
        currentPolicyVersion: 1,
        targetPolicyVersion: 2,
        markedAt: "2026-04-29T10:07:00+00:00",
        pendingExplicitRescore: true,
      },
    };
    const calls: Array<{ jobKeys?: string[] }> = [];
    server.use(
      http.get("*/v1/jobs", () => HttpResponse.json(makeJobsPage([staleJob]))),
      http.post("*/v1/scoring/stale-scores/actions/reset-for-rescore", async ({ request }) => {
        const body = (await request.json()) as { jobKeys?: string[] };
        calls.push(body);
        return HttpResponse.json({
          ok: true,
          count: body.jobKeys?.length ?? 0,
          jobKeys: body.jobKeys ?? [],
          nextAction: "jobhunter run score --rescore",
        });
      }),
    );

    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    const { container } = render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByText(/stale score v1 -> v2/i)).toBeInTheDocument(), {
      timeout: 5_000,
    });
    const checkboxes = container.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
    const rowCheckbox = Array.from(checkboxes).find(
      (input) => input.getAttribute("aria-label")?.includes("Select row") ?? false,
    ) ?? checkboxes[1]!;
    await user.click(rowCheckbox);
    await user.click(screen.getByRole("button", { name: /reset stale selected/i }));

    await waitFor(() => expect(calls).toEqual([{ jobKeys: ["job-stale"], limit: 0 }]));
  });
});

void vi;
