import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type {
  BulkJobMutationRequest,
  BulkRunPendingPreparationRequest,
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
  jobWithCompensation,
  makeCompensationSummary,
  makeFloorConfiguredCompensationSummary,
  makeFloorNotConfiguredCompensationSummary,
  makeInsufficientEvidenceCompensationSummary,
  makeJobsPage,
  makeMarketCompensationSummary,
  makeNoPostedSalaryCompensationSummary,
  sampleJob,
  sampleSecondaryJob,
  makeSourceUnavailableCompensationSummary,
  makeUnsupportedMarketCompensationSummary,
} from "../../test/fixtures/projections.js";
import { server } from "../../test/msw/server.js";
import { buildProviderHarness } from "../../test/render.js";
import { buildTestPorts } from "../../test/testPorts.js";
import { useStageTriggerStore } from "../../contexts/pipeline/stores/stage-trigger-store.js";
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
  useStageTriggerStore.getState().reset();
  Object.defineProperty(window, "confirm", {
    configurable: true,
    writable: true,
    value: () => true,
  });
});

afterEach(() => {
  useStageTriggerStore.getState().reset();
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

function rowForTitle(title: string): HTMLElement {
  const titleCell = screen.getByText(title);
  const row = titleCell.closest("tr");
  if (!row) {
    throw new Error(`Could not find row for ${title}`);
  }
  return row;
}

describe("<JobsView> compensation scan columns", () => {
  it("renders separate Posted, Market, and Warnings columns from compensationSummary", async () => {
    const jobs = vi.fn(async () =>
      makeJobsPage([
        jobWithCompensation({
          jobKey: "job-comp-high",
          title: "Compensation Scan Role",
          compensationSummary: makeFloorConfiguredCompensationSummary({
            warningCount: 2,
          }),
        }),
      ]),
    );
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs } }),
    });
    const { router, Wrapper } = buildRouter(harness);

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(await screen.findByText("Compensation Scan Role")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Posted" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Market" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Warnings" })).toBeInTheDocument();

    const row = within(rowForTitle("Compensation Scan Role"));
    expect(row.getByText("EUR 120k-150k")).toBeInTheDocument();
    expect(row.getByText("EUR 135k-165k")).toBeInTheDocument();
    expect(row.getByText("high confidence")).toBeInTheDocument();
    expect(row.getByText("6 sources")).toBeInTheDocument();
    expect(row.getByText("2 warnings")).toBeInTheDocument();
  });

  it("renders compact explicit market states and confidence/source scan labels", async () => {
    const jobs = vi.fn(async () =>
      makeJobsPage([
        jobWithCompensation({
          jobKey: "job-market-unsupported",
          title: "Unsupported Market Role",
          compensationSummary: makeUnsupportedMarketCompensationSummary(),
        }),
        jobWithCompensation({
          jobKey: "job-market-insufficient",
          title: "Insufficient Market Role",
          compensationSummary: makeInsufficientEvidenceCompensationSummary(),
        }),
        jobWithCompensation({
          jobKey: "job-market-unavailable",
          title: "Source Unavailable Role",
          compensationSummary: makeSourceUnavailableCompensationSummary(),
        }),
        jobWithCompensation({
          jobKey: "job-market-not-requested",
          title: "Not Requested Market Role",
          compensationSummary: makeFloorNotConfiguredCompensationSummary({
            market: makeMarketCompensationSummary({
              recordStatus: "not_requested",
              estimateState: "not_requested",
              confidenceBand: "none",
              sourceCount: 0,
              warningCount: 0,
              range: null,
              displayRange: null,
            }),
            warningCount: 0,
          }),
        }),
      ]),
    );
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs } }),
    });
    const { router, Wrapper } = buildRouter(harness);

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(await screen.findByText("Unsupported Market Role")).toBeInTheDocument();
    expect(within(rowForTitle("Unsupported Market Role")).getByText("unsupported")).toBeInTheDocument();
    expect(within(rowForTitle("Unsupported Market Role")).getByText("no confidence")).toBeInTheDocument();
    expect(within(rowForTitle("Insufficient Market Role")).getByText("insufficient")).toBeInTheDocument();
    expect(within(rowForTitle("Insufficient Market Role")).getByText("low confidence")).toBeInTheDocument();
    expect(within(rowForTitle("Insufficient Market Role")).getByText("2 sources")).toBeInTheDocument();
    expect(within(rowForTitle("Source Unavailable Role")).getByText("unavailable")).toBeInTheDocument();
    expect(
      within(rowForTitle("Not Requested Market Role")).getByLabelText(
        "Market estimate not requested",
      ),
    ).toHaveTextContent("-");
  });

  it("renders accessible dashes for null and missing compensation states", async () => {
    const jobs = vi.fn(async () =>
      makeJobsPage([
        jobWithCompensation({
          jobKey: "job-null-compensation",
          title: "Null Compensation Role",
          compensationSummary: null,
          salary: "EUR 1-999k",
        }),
        jobWithCompensation({
          jobKey: "job-no-posted",
          title: "No Posted Salary Role",
          compensationSummary: makeNoPostedSalaryCompensationSummary(),
        }),
      ]),
    );
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs } }),
    });
    const { router, Wrapper } = buildRouter(harness);

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(await screen.findByText("Null Compensation Role")).toBeInTheDocument();
    expect(
      within(rowForTitle("Null Compensation Role")).getByLabelText(
        "No posted salary recorded",
      ),
    ).toHaveTextContent("-");
    expect(
      within(rowForTitle("Null Compensation Role")).getByLabelText(
        "Market estimate not requested",
      ),
    ).toHaveTextContent("-");
    expect(
      within(rowForTitle("No Posted Salary Role")).getByLabelText(
        "No posted salary recorded",
      ),
    ).toHaveTextContent("-");
  });

  it("renders warning counts without adding floor warnings when the floor is not configured", async () => {
    const jobs = vi.fn(async () =>
      makeJobsPage([
        jobWithCompensation({
          jobKey: "job-warning-count",
          title: "Warning Count Role",
          compensationSummary: makeFloorConfiguredCompensationSummary({
            warningCount: 2,
          }),
        }),
        jobWithCompensation({
          jobKey: "job-floor-not-configured",
          title: "Floor Not Configured Role",
          compensationSummary: makeFloorNotConfiguredCompensationSummary({
            warningCount: 0,
          }),
        }),
      ]),
    );
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs } }),
    });
    const { router, Wrapper } = buildRouter(harness);

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(await screen.findByText("Warning Count Role")).toBeInTheDocument();
    expect(within(rowForTitle("Warning Count Role")).getByText("2 warnings")).toBeInTheDocument();
    expect(within(rowForTitle("Floor Not Configured Role")).getByText("No warnings")).toBeInTheDocument();
  });

  it("does not expose compensation sorting, filtering, route search, or query fields", async () => {
    const jobs = vi.fn(async (query?: Partial<JobListQuery>) =>
      makeJobsPage([
        jobWithCompensation({
          jobKey: "job-display-only-compensation",
          title: "Display Only Compensation Role",
        }),
      ]),
    );
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs } }),
    });
    const { router, Wrapper } = buildRouter(harness);

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(await screen.findByText("Display Only Compensation Role")).toBeInTheDocument();
    for (const label of ["Posted", "Market", "Warnings"]) {
      expect(screen.queryByRole("button", { name: new RegExp(`sort by ${label}`, "i") })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: new RegExp(`filter ${label} column`, "i") })).not.toBeInTheDocument();
    }
    expect(JSON.stringify(router.state.location.search)).not.toMatch(/compensation|posted|market|warning/i);
    expect(JSON.stringify(jobs.mock.calls[0]?.[0] ?? {})).not.toMatch(/compensation|posted|market|warning/i);
  });

  it("shows source-conflict warning count without sort filter or query behavior", async () => {
    const jobs = vi.fn(async (query?: Partial<JobListQuery>) =>
      makeJobsPage([
        jobWithCompensation({
          jobKey: "job-source-conflict",
          title: "Source Conflict Role",
          compensationSummary: makeCompensationSummary({
            warningCount: 2,
            market: makeMarketCompensationSummary({
              confidenceBand: "medium",
              sourceCount: 2,
              warningCount: 2,
            }),
          }),
        }),
      ]),
    );
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs } }),
    });
    const { router, Wrapper } = buildRouter(harness);

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(await screen.findByText("Source Conflict Role")).toBeInTheDocument();
    const row = within(rowForTitle("Source Conflict Role"));
    expect(row.getByText("2 warnings")).toBeInTheDocument();
    expect(row.getByText("medium confidence")).toBeInTheDocument();
    expect(row.getByText("2 sources")).toBeInTheDocument();

    for (const label of ["Posted", "Market", "Warnings"]) {
      expect(screen.queryByRole("button", { name: new RegExp(`sort by ${label}`, "i") })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: new RegExp(`filter ${label} column`, "i") })).not.toBeInTheDocument();
    }
    expect(JSON.stringify(router.state.location.search)).not.toMatch(/compensation|posted|market|warning/i);
    expect(JSON.stringify(jobs.mock.calls[0]?.[0] ?? {})).not.toMatch(/compensation|posted|market|warning/i);
    expect(jobs.mock.calls[0]?.[0]).toMatchObject({
      sort: "discovered_at",
      dir: "desc",
    });
  });
});

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
    expect(jobs).toHaveBeenCalled();
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
    expect(jobs).toHaveBeenCalled();
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

  it("continues all matching pending preparation when the jobs page opens on eligible pending work", async () => {
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
    const runPendingPreparation = vi.fn(async () => ({
      ok: true as const,
      count: 2,
      jobKeys: ["job-pending-tailor", "job-pending-score"],
      stageCounts: { tailor: 1, score: 1 },
      status: "queued" as const,
      actions: [],
    }));
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs, runPendingPreparation } }),
    });
    const { router, Wrapper } = buildRouter(
      harness,
      SEARCH.replace("state=all", "state=pending"),
    );

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(await screen.findByText("Pending Tailor")).toBeInTheDocument();
    await waitFor(() => expect(runPendingPreparation).toHaveBeenCalledTimes(1));
    expect(runPendingPreparation).toHaveBeenCalledWith(
      expect.objectContaining({
        allMatching: true,
        filter: expect.objectContaining({ state: "pending", deleted: "active" }),
        jobKeys: [],
        workers: 1,
        minScore: 7,
        validationMode: "normal",
        dryRun: false,
      }),
    );
  });

  it("does not clear selected rows after background pending preparation pickup", async () => {
    const user = userEvent.setup();
    const pendingTailor: JobSummary = {
      ...sampleJob,
      jobKey: "job-pending-tailor",
      url: "https://example.com/jobs/job-pending-tailor",
      title: "Pending Tailor",
      currentStage: "discover",
      currentSubstage: "tailor",
      currentState: "pending",
    };
    const activeJob: JobSummary = {
      ...sampleSecondaryJob,
      jobKey: "job-active",
      url: "https://example.com/jobs/job-active",
      title: "Selectable Active Job",
      currentStage: "discover",
      currentSubstage: "discover",
      currentState: "succeeded",
    };
    const jobs = vi.fn(async () => makeJobsPage([pendingTailor, activeJob]));
    const runPendingPreparation = vi.fn(async () => ({
      ok: true as const,
      count: 1,
      jobKeys: ["job-pending-tailor"],
      stageCounts: { tailor: 1 },
      status: "queued" as const,
      actions: [],
    }));
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs, runPendingPreparation } }),
    });
    const { router, Wrapper } = buildRouter(harness);
    const { container } = render(<RouterProvider router={router} />, {
      wrapper: Wrapper,
    });

    expect(await screen.findByText("Pending Tailor")).toBeInTheDocument();
    await waitFor(() => expect(runPendingPreparation).toHaveBeenCalledTimes(1));

    const rowCheckboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[type='checkbox']"),
    ).filter(
      (input) =>
        input.getAttribute("aria-label")?.startsWith("Select ") &&
        input.getAttribute("aria-label") !== "Select all rows on this page",
    );
    await user.click(rowCheckboxes[0]!);
    await waitFor(() =>
      expect(screen.getByText("1 selected")).toBeInTheDocument(),
    );

    expect(
      screen.getByRole("button", { name: /delete selected/i }),
    ).not.toBeDisabled();
  });

  it("continues pending preparation even when no visible row is frontend-eligible", async () => {
    const activeJob: JobSummary = {
      ...sampleJob,
      jobKey: "job-active-visible",
      url: "https://example.com/jobs/job-active-visible",
      title: "Active Visible Job",
      currentStage: "discover",
      currentSubstage: "discover",
      currentState: "succeeded",
    };
    const jobs = vi.fn(async () => makeJobsPage([activeJob]));
    const runPendingPreparation = vi.fn(async () => ({
      ok: true as const,
      count: 0,
      jobKeys: [],
      stageCounts: {},
      status: "accepted" as const,
      actions: [],
    }));
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs, runPendingPreparation } }),
    });
    const { router, Wrapper } = buildRouter(harness);

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(await screen.findByText("Active Visible Job")).toBeInTheDocument();
    await waitFor(() => expect(runPendingPreparation).toHaveBeenCalledTimes(1));
    expect(runPendingPreparation).toHaveBeenCalledWith(
      expect.objectContaining({
        allMatching: true,
        filter: expect.objectContaining({ state: "pending", deleted: "active" }),
        jobKeys: [],
      }),
    );
  });

  it("starts at most one automatic pending-preparation drain per unchanged server filter", async () => {
    const firstTailor: JobSummary = {
      ...sampleJob,
      jobKey: "job-pending-tailor-a",
      url: "https://example.com/jobs/job-pending-tailor-a",
      title: "Pending Tailor A",
      currentStage: "discover",
      currentSubstage: "tailor",
      currentState: "pending",
    };
    const secondTailor: JobSummary = {
      ...sampleJob,
      jobKey: "job-pending-tailor-b",
      url: "https://example.com/jobs/job-pending-tailor-b",
      title: "Pending Tailor B",
      currentStage: "discover",
      currentSubstage: "tailor",
      currentState: "pending",
    };
    const jobs = vi.fn(async () => makeJobsPage([firstTailor, secondTailor]));
    const runPendingPreparation = vi.fn(async () => ({
      ok: true as const,
      count: 2,
      jobKeys: ["job-pending-tailor-a", "job-pending-tailor-b"],
      stageCounts: { tailor: 2 },
      status: "queued" as const,
      actions: [],
    }));
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs, runPendingPreparation } }),
    });
    const { router, Wrapper } = buildRouter(
      harness,
      SEARCH.replace("state=all", "state=pending"),
    );

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(await screen.findByText("Pending Tailor A")).toBeInTheDocument();
    expect(await screen.findByText("Pending Tailor B")).toBeInTheDocument();
    await waitFor(() => expect(runPendingPreparation).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runPendingPreparation).toHaveBeenCalledTimes(1);
    expect(runPendingPreparation).toHaveBeenCalledWith(
      expect.objectContaining({
        allMatching: true,
        filter: expect.objectContaining({ state: "pending", deleted: "active" }),
        jobKeys: [],
      }),
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
    useStageTriggerStore.getState().patchStageConfig("score", { workers: "14" });
    const failedSearch =
      "?stage=all&state=failed&deleted=active&sort=discovered_at&dir=desc&page=1&pageSize=50";
    const calls: Array<{
      allMatching?: boolean;
      filter?: { state?: string; deleted?: string };
      jobKeys?: string[];
      runAfter?: boolean;
      workers?: number;
      minScore?: number;
      validationMode?: string;
      dryRun?: boolean;
    }> = [];
    server.use(
      http.post("*/v1/jobs/bulk-retry-failed", async ({ request }) => {
        const body = (await request.json()) as {
          allMatching?: boolean;
          filter?: { state?: string; deleted?: string };
          jobKeys?: string[];
          runAfter?: boolean;
          workers?: number;
          minScore?: number;
          validationMode?: string;
          dryRun?: boolean;
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
      runAfter: true,
      workers: 14,
      minScore: 7,
      validationMode: "normal",
      dryRun: false,
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
      runAfter?: boolean;
      workers?: number;
      minScore?: number;
      validationMode?: string;
      dryRun?: boolean;
    }> = [];
    server.use(
      http.post("*/v1/jobs/bulk-retry-failed", async ({ request }) => {
        const body = (await request.json()) as {
          allMatching?: boolean;
          filter?: { state?: string; deleted?: string };
          jobKeys?: string[];
          runAfter?: boolean;
          workers?: number;
          minScore?: number;
          validationMode?: string;
          dryRun?: boolean;
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
      runAfter: true,
      workers: 1,
      minScore: 7,
      validationMode: "normal",
      dryRun: false,
    });
  });

  it("posts all matching pending preparation jobs from the jobs toolbar", async () => {
    const user = userEvent.setup();
    useStageTriggerStore.getState().patchStageConfig("score", { workers: "14" });
    const pendingSearch =
      "?stage=all&state=pending&deleted=active&sort=discovered_at&dir=desc&page=1&pageSize=50";
    const calls: BulkRunPendingPreparationRequest[] = [];
    server.use(
      http.post("*/v1/jobs/bulk-run-pending-preparation", async ({ request }) => {
        const body = (await request.json()) as BulkRunPendingPreparationRequest;
        calls.push(body);
        return HttpResponse.json({
          ok: true,
          count: 2,
          jobKeys: ["job-1", "job-2"],
          stageCounts: { score: 2 },
          status: "queued",
          actions: [],
        });
      }),
    );

    const harness = buildProviderHarness();
    const { router, Wrapper } = buildRouter(harness, pendingSearch);
    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: /continue pending prep/i }),
        ).toBeInTheDocument(),
      {
        timeout: 5_000,
      },
    );
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1));
    calls.length = 0;
    await user.click(screen.getByRole("button", { name: /continue pending prep/i }));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toMatchObject({
      allMatching: true,
      filter: { state: "pending", deleted: "active" },
      jobKeys: [],
      workers: 14,
      minScore: 7,
      validationMode: "normal",
      dryRun: false,
    });
  });
});

void vi;
