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
  makeJobsPage,
  sampleCompensationSummary,
  sampleJob,
  sampleSecondaryJob,
} from "../../test/fixtures/projections.js";
import { server } from "../../test/msw/server.js";
import { buildProviderHarness } from "../../test/render.js";
import { buildTestPorts } from "../../test/testPorts.js";
import { useStageTriggerStore } from "../../contexts/pipeline/stores/stage-trigger-store.js";
import {
  JOBS_TABLE_COLUMN_IDS,
  JOBS_TABLE_ID,
  useSavedTableViewsStore,
} from "../../shared/stores/saved-table-views.js";
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
  useSavedTableViewsStore.getState().reset();
  window.localStorage.removeItem("jh:saved-table-views");
  Object.defineProperty(window, "confirm", {
    configurable: true,
    writable: true,
    value: () => true,
  });
});

afterEach(() => {
  useStageTriggerStore.getState().reset();
  useSavedTableViewsStore.getState().reset();
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

describe("<JobsView> compensation source-conflict visibility", () => {
  it("shows salary min/max, market, and warning scan columns with every data column sortable", async () => {
    const user = userEvent.setup();
    const compensationSummary = {
      ...sampleCompensationSummary,
      warningCount: 2,
      market: {
        ...sampleCompensationSummary.market,
        confidenceBand: "medium" as const,
        confidenceScore: 0.74,
        sourceCount: 2,
        sampleCount: 7,
        warningCount: 2,
      },
    };
    const jobs = vi.fn(async (query?: Partial<JobListQuery>) =>
      makeJobsPage([
        {
          ...sampleSecondaryJob,
          jobKey: "job-source-conflict",
          title: "Source Conflict Role",
          compensationSummary,
        },
      ]),
    );
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs } }),
    });
    const { router, Wrapper } = buildRouter(harness);

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(await screen.findByText("Source Conflict Role")).toBeInTheDocument();
    expect(screen.getByText("Salary min (€ / year)")).toBeInTheDocument();
    expect(screen.getByText("Salary max (€ / year)")).toBeInTheDocument();
    expect(screen.getByText("Market (€ / year)")).toBeInTheDocument();
    expect(screen.getByText("Confidence")).toBeInTheDocument();
    expect(screen.getByText("Warnings")).toBeInTheDocument();
    const row = within(rowForTitle("Source Conflict Role"));
    expect(row.getByText("70,000")).toBeInTheDocument();
    expect(row.getByText("90,000")).toBeInTheDocument();
    expect(row.getByText("112,000-142,000")).toBeInTheDocument();
    expect(row.getByText("Medium")).toBeInTheDocument();
    expect(row.getByText("74%")).toBeInTheDocument();
    expect(row.getByText(/2 sources/)).toBeInTheDocument();
    expect(row.getByText("2 warnings")).toBeInTheDocument();

    for (const label of [
      "Fit score",
      "Title",
      "Company",
      "Sources",
      "Salary min (€ / year)",
      "Salary max (€ / year)",
      "Market (€ / year)",
      "Confidence",
      "Warnings",
      "Location",
      "Stage",
      "State",
      "Discovered",
      "Apply",
    ]) {
      const name = label === "Discovered" ? /^Sort by Discovered/ : `Sort by ${label}`;
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }

    expect(jobs.mock.calls[0]?.[0]).toMatchObject({
      sort: "discovered_at",
      dir: "desc",
    });

    await user.click(screen.getByRole("button", { name: "Sort by Salary min (€ / year)" }));
    await waitFor(() =>
      expect(jobs).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "compensation_min_eur", dir: "asc" })),
    );
    expect(router.state.location.search).toMatchObject({
      sort: "compensation_min_eur",
      dir: "asc",
    });

    await user.click(screen.getByRole("button", { name: "Sort by Salary max (€ / year)" }));
    await waitFor(() =>
      expect(jobs).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "compensation_max_eur", dir: "asc" })),
    );

    await user.click(screen.getByRole("button", { name: "Sort by Confidence" }));
    await waitFor(() =>
      expect(jobs).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "compensation_confidence", dir: "asc" })),
    );
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

  it("saves and reapplies Jobs table views through URL-backed filters", async () => {
    const user = userEvent.setup();
    const discoverJob = jobWithStage("job-discover-view", "Discovery view job", "discover");
    const applyJob = jobWithStage("job-apply-view", "Apply view job", "apply");
    const jobs = vi.fn(async (query?: Partial<JobListQuery>) =>
      makeJobsPage(query?.stage === "apply" ? [applyJob] : [discoverJob, applyJob]),
    );
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs } }),
    });
    const { router, Wrapper } = buildRouter(harness);

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(await screen.findByText(discoverJob.title)).toBeInTheDocument();
    expect(screen.getByText(applyJob.title)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /filter stage column/i }));
    await user.click(screen.getByRole("checkbox", { name: "apply" }));
    await user.click(screen.getByRole("button", { name: /close/i }));
    await waitFor(() =>
      expect(jobs).toHaveBeenLastCalledWith(expect.objectContaining({ stage: "apply" })),
    );
    expect(router.state.location.search).toMatchObject({ stage: "apply" });

    await user.click(screen.getByRole("button", { name: "Configure table columns" }));
    const columnsDialog = screen.getByRole("dialog", { name: "Columns" });
    await user.click(within(columnsDialog).getByRole("checkbox", { name: "Company" }));
    await user.click(within(columnsDialog).getByRole("button", { name: "Compact" }));
    await user.selectOptions(
      within(columnsDialog).getByRole("combobox", { name: "Group table rows" }),
      "current_stage",
    );
    await user.selectOptions(
      within(columnsDialog).getByRole("combobox", { name: "Color rule column" }),
      "title",
    );
    await user.type(
      within(columnsDialog).getByRole("textbox", { name: "Color rule value" }),
      "Apply",
    );
    await user.selectOptions(
      within(columnsDialog).getByRole("combobox", { name: "Color rule tone" }),
      "warning",
    );
    await user.click(within(columnsDialog).getByRole("button", { name: "Add" }));
    await user.click(within(columnsDialog).getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("columnheader", { name: /Company/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save as view" }));
    const saveDialog = screen.getByRole("dialog", { name: "Save view" });
    await user.type(within(saveDialog).getByLabelText("Name"), "Apply compact");
    await user.click(within(saveDialog).getByRole("button", { name: "Save" }));

    const viewSelect = screen.getByRole("combobox", { name: "Saved table view" });
    await user.selectOptions(viewSelect, "default");
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ stage: "all" }),
    );
    expect(jobs.mock.lastCall?.[0]).not.toHaveProperty("stage");
    expect(router.state.location.search).toMatchObject({ stage: "all" });
    expect(screen.getByRole("columnheader", { name: /Company/ })).toBeInTheDocument();

    await user.selectOptions(
      viewSelect,
      screen.getByRole("option", { name: "Apply compact" }),
    );
    await waitFor(() =>
      expect(jobs).toHaveBeenLastCalledWith(expect.objectContaining({ stage: "apply" })),
    );
    expect(router.state.location.search).toMatchObject({ stage: "apply" });
    expect(screen.queryByRole("columnheader", { name: /Company/ })).not.toBeInTheDocument();
    expect(document.querySelector(".filterable-data-grid")).toHaveAttribute(
      "data-density",
      "compact",
    );
    expect(screen.getByRole("row", { name: /apply 1/i })).toHaveClass(
      "data-grid-group-row",
    );
    expect(rowForTitle(applyJob.title)).toHaveClass("data-grid-row-tone-warning");
  });

  it("hydrates active saved table view filters when the jobs view remounts", async () => {
    const vonageJob: JobSummary = {
      ...sampleJob,
      jobKey: "job-saved-filter-vonage",
      title: "Saved Filter Manager",
      company: "Vonage",
      source: "Greenhouse",
      discoverySource: "greenhouse:vonage",
      postingSource: "greenhouse:vonage",
    };
    const acaiJob: JobSummary = {
      ...sampleSecondaryJob,
      jobKey: "job-saved-filter-acai",
      title: "Saved Filter Engineer",
      company: "Acai",
      source: "Ashby",
      discoverySource: "ashby:acai",
      postingSource: "ashby:acai",
    };
    const jobs = vi.fn(async () => makeJobsPage([vonageJob, acaiJob]));
    useSavedTableViewsStore.getState().createView(JOBS_TABLE_ID, "Vonage", {
      columns: { order: [...JOBS_TABLE_COLUMN_IDS], hidden: [], widths: {} },
      density: null,
      grouping: null,
      colorRules: [],
      sort: { columnId: "discovered_at", direction: "desc" },
      urlFilters: {
        q: "",
        stage: "all",
        state: "all",
        applyStatus: "all",
        deleted: "active",
        pageSize: 50,
      },
      gridFilters: {
        company: {
          operator: "contains",
          text: "",
          selectedValues: ["Vonage"],
        },
      },
    });

    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs } }),
    });
    const { router, Wrapper } = buildRouter(harness);

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(await screen.findByText(vonageJob.title)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(acaiJob.title)).not.toBeInTheDocument(),
    );
    expect(router.state.location.search).toMatchObject({
      stage: "all",
      sort: "discovered_at",
    });
    expect(
      screen.getByRole("button", {
        name: /filter company column \(active\)/i,
      }),
    ).toBeInTheDocument();
  });

  it("saves and reapplies digest timestamp URL filters in table views", async () => {
    const user = userEvent.setup();
    const since = "2026-07-01T00:00:00.000Z";
    const newMatchJob: JobSummary = {
      ...sampleJob,
      jobKey: "job-digest-new-match",
      url: "https://example.com/jobs/job-digest-new-match",
      title: "Digest new match",
    };
    const jobs = vi.fn(async (query?: Partial<JobListQuery>) =>
      makeJobsPage(
        query?.discoveredSince === since && query?.scoredSince === since
          ? [newMatchJob]
          : [],
      ),
    );
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs } }),
    });
    const digestSearch = `${SEARCH}&discoveredSince=${encodeURIComponent(
      since,
    )}&scoredSince=${encodeURIComponent(since)}`;
    const { router, Wrapper } = buildRouter(harness, digestSearch);

    render(<RouterProvider router={router} />, { wrapper: Wrapper });

    expect(await screen.findByText(newMatchJob.title)).toBeInTheDocument();
    expect(jobs).toHaveBeenLastCalledWith(
      expect.objectContaining({
        discoveredSince: since,
        scoredSince: since,
      }),
    );

    await user.click(screen.getByRole("button", { name: "Save as view" }));
    const saveDialog = screen.getByRole("dialog", { name: "Save view" });
    await user.type(within(saveDialog).getByLabelText("Name"), "Digest new");
    await user.click(within(saveDialog).getByRole("button", { name: "Save" }));

    const viewSelect = screen.getByRole("combobox", { name: "Saved table view" });
    await user.selectOptions(viewSelect, "default");
    await waitFor(() => {
      expect(router.state.location.search.discoveredSince).toBeUndefined();
      expect(router.state.location.search.scoredSince).toBeUndefined();
    });
    expect(screen.queryByText(newMatchJob.title)).not.toBeInTheDocument();

    await user.selectOptions(
      viewSelect,
      screen.getByRole("option", { name: "Digest new" }),
    );
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        discoveredSince: since,
        scoredSince: since,
      }),
    );
    expect(await screen.findByText(newMatchJob.title)).toBeInTheDocument();
    expect(jobs).toHaveBeenLastCalledWith(
      expect.objectContaining({
        discoveredSince: since,
        scoredSince: since,
      }),
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
