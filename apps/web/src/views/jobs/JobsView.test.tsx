import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type {
  ActionRunResponse,
  BulkJobMutationRequest,
  JobListQuery,
  JobSummary,
  Stage,
} from "@jobhunter/contracts";
import { http, HttpResponse } from "msw";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import {
  makeJobsPage,
  sampleJob,
  sampleSecondaryJob,
} from "../../test/fixtures/projections.js";
import { server } from "../../test/msw/server.js";
import { buildProviderHarness } from "../../test/render.js";
import { buildTestPorts } from "../../test/testPorts.js";
import { JobsView } from "./JobsView.js";

const SEARCH =
  "?stage=all&state=all&deleted=active&sort=discovered_at&dir=desc&page=1&pageSize=50";

function buildRouter(
  harness: ReturnType<typeof buildProviderHarness>,
  search = SEARCH,
) {
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
    history: createMemoryHistory({ initialEntries: [`/jobs${search}`] }),
  });
  return { router, queryClient: harness.queryClient, Wrapper: harness.Wrapper };
}

const originalConfirm = globalThis.window?.confirm;

beforeEach(() => {
  Object.defineProperty(window, "confirm", {
    configurable: true,
    writable: true,
    value: () => true,
  });
});

afterEach(() => {
  if (typeof originalConfirm === "function") {
    Object.defineProperty(window, "confirm", {
      configurable: true,
      writable: true,
      value: originalConfirm,
    });
  }
});

function jobWithStage(
  jobKey: string,
  title: string,
  currentStage: Stage,
): JobSummary {
  return {
    ...sampleJob,
    jobKey,
    url: `https://example.com/jobs/${jobKey}`,
    title,
    currentStage,
    currentSubstage: currentStage,
    currentState: currentStage === "apply" ? "pending" : sampleJob.currentState,
  };
}

function queuedAction(action: ActionRunResponse["action"], jobKey: string): ActionRunResponse {
  return {
    ok: true,
    runId: `run-${action}`,
    actionId: `action-${action}`,
    action,
    status: "queued",
    jobKey,
    command: { action, jobKey },
  };
}

describe("<JobsView> bulk delete integration", () => {
  it("keeps the product Discover filter as a single discover-stage jobs query", async () => {
    const discoverJob = jobWithStage("job-discover", "Discovery candidate", "discover");
    const jobs = vi.fn(async (query?: Partial<JobListQuery>) =>
      makeJobsPage(query?.stage === "discover" ? [discoverJob] : []),
    );
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs } }),
    });
    const { router, Wrapper } = buildRouter(
      harness,
      SEARCH.replace("stage=all", "stage=discover"),
    );

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(await screen.findByText(discoverJob.title)).toBeInTheDocument();
    expect(screen.getByLabelText("discover")).toBeInTheDocument();
    expect(screen.queryByText(/substatus/i)).not.toBeInTheDocument();
    expect(jobs).toHaveBeenCalledTimes(1);
    expect(jobs.mock.calls[0]?.[0]).toMatchObject({ stage: "discover" });
  });

  it("keeps the product Apply filter as an exact apply-stage jobs query", async () => {
    const applyJob = jobWithStage("job-apply", "Apply candidate", "apply");
    const jobs = vi.fn(async (query?: Partial<JobListQuery>) =>
      makeJobsPage(query?.stage === "apply" ? [applyJob] : []),
    );
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs } }),
    });
    const { router, Wrapper } = buildRouter(
      harness,
      SEARCH.replace("stage=all", "stage=apply"),
    );

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(await screen.findByText(applyJob.title)).toBeInTheDocument();
    expect(jobs).toHaveBeenCalledTimes(1);
    expect(jobs.mock.calls[0]?.[0]).toMatchObject({ stage: "apply" });
  });

  it("passes the applied application filter through the jobs query", async () => {
    const appliedJob: JobSummary = {
      ...sampleJob,
      jobKey: "job-applied",
      url: "https://example.com/jobs/job-applied",
      title: "Applied candidate",
      applyStatus: "applied",
      appliedAt: "2026-05-30T10:00:00Z",
    };
    const jobs = vi.fn(async (query?: Partial<JobListQuery>) =>
      makeJobsPage(query?.applyStatus === "applied" ? [appliedJob] : []),
    );
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs } }),
    });
    const { router, Wrapper } = buildRouter(
      harness,
      `${SEARCH}&applyStatus=applied`,
    );

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(await screen.findByText(appliedJob.title)).toBeInTheDocument();
    expect(jobs).toHaveBeenCalledWith(
      expect.objectContaining({ applyStatus: "applied" }),
    );
  });

  it("starts visible pending preparation substages when the jobs page is viewed", async () => {
    const pendingTailor: JobSummary = {
      ...sampleJob,
      jobKey: "job-pending-tailor",
      url: "https://example.com/jobs/job-pending-tailor",
      title: "Pending Tailor",
      currentStage: "discover",
      currentSubstage: "tailor",
      currentState: "pending",
    };
    const pendingApply: JobSummary = {
      ...sampleSecondaryJob,
      jobKey: "job-pending-apply",
      url: "https://example.com/jobs/job-pending-apply",
      title: "Pending Apply",
      currentStage: "apply",
      currentSubstage: "apply",
      currentState: "pending",
    };
    const jobs = vi.fn(async () => makeJobsPage([pendingTailor, pendingApply]));
    const runJobStage = vi.fn(async (jobKey: string) => queuedAction("run_stage", jobKey));
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs, runJobStage } }),
    });
    const { router, Wrapper } = buildRouter(
      harness,
      SEARCH.replace("state=all", "state=pending"),
    );

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(await screen.findByText("Pending Tailor")).toBeInTheDocument();
    await waitFor(() => expect(runJobStage).toHaveBeenCalledTimes(1));
    expect(runJobStage).toHaveBeenCalledWith(
      "job-pending-tailor",
      expect.objectContaining({ stage: "tailor", dryRun: false, limit: 1 }),
    );
  });

  it("moves product filters into the table header and keeps them URL-backed", async () => {
    const user = userEvent.setup();
    const discoverJob = jobWithStage("job-discover", "Discovery candidate", "discover");
    const jobs = vi.fn(async (query?: Partial<JobListQuery>) =>
      makeJobsPage(query?.stage === "discover" ? [discoverJob] : []),
    );
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs } }),
    });
    const { router, Wrapper } = buildRouter(harness);

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(() => expect(jobs).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("all stages")).not.toBeInTheDocument();
    expect(screen.queryByText("all states")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /filter stage column/i }));
    await user.click(
      within(screen.getByLabelText("Stage values")).getByRole("checkbox", {
        name: "discover",
      }),
    );

    await waitFor(() =>
      expect(jobs).toHaveBeenLastCalledWith(expect.objectContaining({ stage: "discover" })),
    );
    expect(router.state.location.search).toMatchObject({ stage: "discover", page: 1 });
  });

  it("uses the product Discover stage for all-matching bulk filters", async () => {
    const user = userEvent.setup();
    const discoverJob = jobWithStage("job-discover", "discover candidate", "discover");
    const jobs = vi.fn(async (query?: Partial<JobListQuery>) =>
      makeJobsPage(query?.stage === "discover" ? [discoverJob] : []),
    );
    const deleteJobs = vi.fn(async (body: BulkJobMutationRequest) => ({
      ok: true as const,
      count: body.jobKeys.length,
      jobKeys: body.jobKeys,
    }));
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs, deleteJobs } }),
    });
    const { router, Wrapper } = buildRouter(
      harness,
      SEARCH.replace("stage=all", "stage=discover"),
    );

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(await screen.findByText("discover candidate")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /select all matching/i }),
    );
    await waitFor(() =>
      expect(screen.getByText("1 selected")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /delete selected/i }));

    await waitFor(() => expect(deleteJobs).toHaveBeenCalledTimes(1));
    expect(deleteJobs.mock.calls[0]?.[0]).toMatchObject({
      allMatching: true,
      filter: expect.objectContaining({ stage: "discover" }),
      jobKeys: [],
    });
  });

  it("checks visible row checkboxes after selecting all matching jobs", async () => {
    const user = userEvent.setup();
    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    const { container } = render(<RouterProvider router={router} />, {
      wrapper: Wrapper,
    });

    await waitFor(
      () => expect(screen.getByText(/Acme Corp/i)).toBeInTheDocument(),
      {
        timeout: 5_000,
      },
    );

    await user.click(
      screen.getByRole("button", { name: /select all matching/i }),
    );
    await waitFor(() =>
      expect(screen.getByText(/2 selected/i)).toBeInTheDocument(),
    );

    const checkboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[type='checkbox']"),
    );
    const rowCheckboxes = checkboxes.filter(
      (input) =>
        input.getAttribute("aria-label")?.startsWith("Select ") &&
        input.getAttribute("aria-label") !== "Select all rows on this page",
    );

    expect(
      screen.getByRole("checkbox", { name: /select all rows on this page/i }),
    ).toBeChecked();
    expect(rowCheckboxes.length).toBeGreaterThan(0);
    for (const checkbox of rowCheckboxes) {
      expect(checkbox).toBeChecked();
    }
  });

  it("does not let page-local table filters drive unbounded bulk deletes", async () => {
    const user = userEvent.setup();
    const vonageJob: JobSummary = {
      ...sampleJob,
      jobKey: "vonage-1",
      title: "Engineering Manager",
      company: "Vonage",
      source: "Greenhouse",
      discoverySource: "greenhouse:vonage",
      postingSource: "greenhouse:vonage",
    };
    const acaiJob: JobSummary = {
      ...sampleSecondaryJob,
      jobKey: "acai-1",
      title: "Software Engineer (India)",
      company: "Acai",
      source: "Ashby",
      discoverySource: "ashby:acai",
      postingSource: "ashby:acai",
    };
    const jobs = vi.fn(async () => makeJobsPage([vonageJob, acaiJob]));
    const deleteJobs = vi.fn(async (body: BulkJobMutationRequest) => ({
      ok: true as const,
      count: body.jobKeys.length,
      jobKeys: body.jobKeys,
    }));
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs, deleteJobs } }),
    });
    const { router, Wrapper } = buildRouter(harness);

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(await screen.findByText("Engineering Manager")).toBeInTheDocument();
    expect(screen.getByText("Software Engineer (India)")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /filter sources column/i }),
    );
    await user.type(screen.getByLabelText("Sources filter text"), "vonage");

    await waitFor(() =>
      expect(
        screen.queryByText("Software Engineer (India)"),
      ).not.toBeInTheDocument(),
    );
    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("button", { name: /select all matching/i }),
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /select page/i }));
    await waitFor(() =>
      expect(screen.getByText(/1 selected/i)).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /delete selected/i }));

    await waitFor(() => expect(deleteJobs).toHaveBeenCalledTimes(1));
    expect(deleteJobs.mock.calls[0]?.[0]).toMatchObject({
      allMatching: false,
      jobKeys: ["vonage-1"],
    });
  });

  it("selects rows via checkbox, clicks delete, confirms, and posts to /v1/jobs/bulk-delete", async () => {
    const user = userEvent.setup();
    const calls: Array<{ jobKeys?: string[] }> = [];
    server.use(
      http.post("*/v1/jobs/bulk-delete", async ({ request }) => {
        const body = (await request.json()) as { jobKeys?: string[] };
        calls.push(body);
        return HttpResponse.json({
          ok: true,
          count: body.jobKeys?.length ?? 0,
          jobKeys: body.jobKeys ?? [],
        });
      }),
    );

    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    const { container } = render(<RouterProvider router={router} />, {
      wrapper: Wrapper,
    });

    await waitFor(
      () => expect(screen.getByText(/Acme Corp/i)).toBeInTheDocument(),
      {
        timeout: 5_000,
      },
    );

    const checkboxes = container.querySelectorAll<HTMLInputElement>(
      "input[type='checkbox']",
    );
    expect(checkboxes.length).toBeGreaterThan(1);

    const rowCheckbox =
      Array.from(checkboxes).find(
        (input) =>
          input.getAttribute("aria-label")?.includes("Select row") ?? false,
      ) ?? checkboxes[1]!;
    await user.click(rowCheckbox);

    await waitFor(() =>
      expect(screen.getByText(/1 selected/i)).toBeInTheDocument(),
    );

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
    Object.defineProperty(window, "confirm", {
      configurable: true,
      writable: true,
      value: () => false,
    });

    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    const { container } = render(<RouterProvider router={router} />, {
      wrapper: Wrapper,
    });

    await waitFor(
      () => expect(screen.getByText(/Acme Corp/i)).toBeInTheDocument(),
      {
        timeout: 5_000,
      },
    );

    const checkboxes = container.querySelectorAll<HTMLInputElement>(
      "input[type='checkbox']",
    );
    const rowCheckbox =
      Array.from(checkboxes).find(
        (input) =>
          input.getAttribute("aria-label")?.includes("Select row") ?? false,
      ) ?? checkboxes[1]!;
    await user.click(rowCheckbox);
    await waitFor(() =>
      expect(screen.getByText(/1 selected/i)).toBeInTheDocument(),
    );

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
        return HttpResponse.json({
          ok: true,
          count: body.jobKeys?.length ?? 0,
          jobKeys: body.jobKeys ?? [],
        });
      }),
    );

    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    const { container } = render(<RouterProvider router={router} />, {
      wrapper: Wrapper,
    });

    await waitFor(
      () => expect(screen.getByText(/Acme Corp/i)).toBeInTheDocument(),
      {
        timeout: 5_000,
      },
    );

    const checkboxes = container.querySelectorAll<HTMLInputElement>(
      "input[type='checkbox']",
    );
    const rowCheckbox =
      Array.from(checkboxes).find(
        (input) =>
          input.getAttribute("aria-label")?.includes("Select row") ?? false,
      ) ?? checkboxes[1]!;
    await user.click(rowCheckbox);
    await waitFor(() =>
      expect(screen.getByText(/1 selected/i)).toBeInTheDocument(),
    );

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
        return HttpResponse.json({
          ok: true,
          count: body.jobKeys?.length ?? 0,
          jobKeys: body.jobKeys ?? [],
        });
      }),
    );

    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    const { container } = render(<RouterProvider router={router} />, {
      wrapper: Wrapper,
    });

    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: /hidden jobs/i }),
        ).toBeInTheDocument(),
      {
        timeout: 5_000,
      },
    );
    await user.click(screen.getByRole("button", { name: /hidden jobs/i }));
    await waitFor(
      () => expect(screen.getByText(/Acme Corp/i)).toBeInTheDocument(),
      {
        timeout: 5_000,
      },
    );

    const checkboxes = container.querySelectorAll<HTMLInputElement>(
      "input[type='checkbox']",
    );
    const rowCheckbox =
      Array.from(checkboxes).find(
        (input) =>
          input.getAttribute("aria-label")?.includes("Select row") ?? false,
      ) ?? checkboxes[1]!;
    await user.click(rowCheckbox);
    await waitFor(() =>
      expect(screen.getByText(/1 selected/i)).toBeInTheDocument(),
    );

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
        return HttpResponse.json({
          ok: true,
          count: body.jobKeys?.length ?? 0,
          jobKeys: body.jobKeys ?? [],
        });
      }),
    );

    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    const { container } = render(<RouterProvider router={router} />, {
      wrapper: Wrapper,
    });

    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: /deleted jobs/i }),
        ).toBeInTheDocument(),
      {
        timeout: 5_000,
      },
    );
    await user.click(screen.getByRole("button", { name: /deleted jobs/i }));
    await waitFor(
      () => expect(screen.getByText(/Acme Corp/i)).toBeInTheDocument(),
      {
        timeout: 5_000,
      },
    );

    const checkboxes = container.querySelectorAll<HTMLInputElement>(
      "input[type='checkbox']",
    );
    const rowCheckbox =
      Array.from(checkboxes).find(
        (input) =>
          input.getAttribute("aria-label")?.includes("Select row") ?? false,
      ) ?? checkboxes[1]!;
    await user.click(rowCheckbox);
    await waitFor(() =>
      expect(screen.getByText(/1 selected/i)).toBeInTheDocument(),
    );

    await user.click(
      screen.getByRole("button", { name: /delete permanently selected/i }),
    );

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]?.jobKeys?.length).toBe(1);
  });

  it("shows stale score state and posts selected stale scores for rescore reset", async () => {
    const user = userEvent.setup();
    const staleJob = {
      ...sampleJob,
      jobKey: "job-stale",
      currentStage: "discover" as const,
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
      http.post(
        "*/v1/scoring/stale-scores/actions/reset-for-rescore",
        async ({ request }) => {
          const body = (await request.json()) as { jobKeys?: string[] };
          calls.push(body);
          return HttpResponse.json({
            ok: true,
            count: body.jobKeys?.length ?? 0,
            jobKeys: body.jobKeys ?? [],
            nextAction: "jobhunter run score --rescore",
          });
        },
      ),
    );

    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness);
    const { container } = render(<RouterProvider router={router} />, {
      wrapper: Wrapper,
    });

    await waitFor(
      () =>
        expect(screen.getByText(/stale score v1 -> v2/i)).toBeInTheDocument(),
      {
        timeout: 5_000,
      },
    );
    const checkboxes = container.querySelectorAll<HTMLInputElement>(
      "input[type='checkbox']",
    );
    const rowCheckbox =
      Array.from(checkboxes).find(
        (input) =>
          input.getAttribute("aria-label")?.includes("Select row") ?? false,
      ) ?? checkboxes[1]!;
    await user.click(rowCheckbox);
    await user.click(
      screen.getByRole("button", { name: /reset stale selected/i }),
    );

    await waitFor(() =>
      expect(calls).toEqual([{ jobKeys: ["job-stale"], limit: 0 }]),
    );
  });

  it("posts all matching failed jobs to bulk retry from the failed filter", async () => {
    const user = userEvent.setup();
    const failedSearch =
      "?stage=all&state=failed&deleted=active&sort=discovered_at&dir=desc&page=1&pageSize=50";
    const calls: Array<{
      allMatching?: boolean;
      filter?: { state?: string; deleted?: string };
      jobKeys?: string[];
    }> = [];
    server.use(
      http.post("*/v1/jobs/bulk-retry-failed", async ({ request }) => {
        const body = (await request.json()) as {
          allMatching?: boolean;
          filter?: { state?: string; deleted?: string };
          jobKeys?: string[];
        };
        calls.push(body);
        return HttpResponse.json({
          ok: true,
          count: 2,
          jobKeys: ["job-1", "job-2"],
        });
      }),
    );

    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness, failedSearch);
    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: /retry all failed/i }),
        ).toBeInTheDocument(),
      {
        timeout: 5_000,
      },
    );
    await user.click(screen.getByRole("button", { name: /retry all failed/i }));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toMatchObject({
      allMatching: true,
      filter: { state: "failed", deleted: "active" },
      jobKeys: [],
    });
  });

  it("posts all matching failed jobs to bulk retry from the pending filter", async () => {
    const user = userEvent.setup();
    const pendingSearch =
      "?stage=all&state=pending&deleted=active&sort=discovered_at&dir=desc&page=1&pageSize=50";
    const calls: Array<{
      allMatching?: boolean;
      filter?: { state?: string; deleted?: string };
      jobKeys?: string[];
    }> = [];
    server.use(
      http.post("*/v1/jobs/bulk-retry-failed", async ({ request }) => {
        const body = (await request.json()) as {
          allMatching?: boolean;
          filter?: { state?: string; deleted?: string };
          jobKeys?: string[];
        };
        calls.push(body);
        return HttpResponse.json({
          ok: true,
          count: 2,
          jobKeys: ["job-1", "job-2"],
        });
      }),
    );

    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness, pendingSearch);
    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: /retry all failed/i }),
        ).toBeInTheDocument(),
      {
        timeout: 5_000,
      },
    );
    await user.click(screen.getByRole("button", { name: /retry all failed/i }));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toMatchObject({
      allMatching: true,
      filter: { state: "failed", deleted: "active" },
      jobKeys: [],
    });
  });
});

void vi;
