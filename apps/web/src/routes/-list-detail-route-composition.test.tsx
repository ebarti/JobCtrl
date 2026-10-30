import type { ActivityEventResponse } from "@jobctrl/contracts";
import type { ApiClientPort } from "../shared/ports/ApiClientPort.js";
import type { RouterContext } from "../router.js";
import { activityKeys } from "../contexts/operations/activityKeys.js";
import { analyticsKeys } from "../contexts/operations/analyticsKeys.js";
import { applyReviewKeys } from "../contexts/operations/applyReviewKeys.js";
import { artifactsKeys } from "../contexts/operations/artifactsKeys.js";
import { dashboardKeys } from "../contexts/operations/dashboardKeys.js";
import { digestKeys } from "../contexts/operations/digestKeys.js";
import { evidenceMapKeys } from "../contexts/operations/evidenceMapKeys.js";
import { outcomesKeys } from "../contexts/operations/outcomesKeys.js";
import { workflowRunsKeys } from "../contexts/operations/workflowRunsKeys.js";
import {
  STARTING_RUNS_INPUT,
  IN_PROGRESS_RUNS_INPUT,
} from "../contexts/operations/activeRuns.js";
import { outreachKeys } from "../contexts/outreach/queryKeys.js";
import { profileKeys } from "../contexts/profile/queryKeys.js";
import {
  createTenantId,
  type TenantId,
  LOCAL_TENANT,
} from "@jobctrl/domain-types";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { routeTree } from "../routeTree.gen.js";
import { buildProviderHarness } from "../test/render.js";
import { buildTestPorts } from "../test/testPorts.js";

vi.mock("../shared/ui/PdfPreviewViewer.js", () => ({
  PdfPreviewViewer: ({ title }: { title: string }) => <div>{title}</div>,
}));

function renderRoute(initialEntry: string) {
  const ports = buildTestPorts({ api: {
    materialLocaleVariants: vi.fn(async () => ({ supportedLocales: [], variants: [], profileVersion: null, sources: [] })),
  } });
  const harness = buildProviderHarness({ withEventStream: true, ports });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    context: {
      ports: harness.ports,
      queryClient: harness.queryClient,
      tenantId: LOCAL_TENANT,
    },
  });

  render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });
}

describe("list and detail route composition", () => {
  it.each([
    {
      initialEntry: "/jobs/job-1?stage=apply&page=2",
      workspaceName: "Job details",
      listHeading: "Jobs",
    },
    {
      initialEntry: "/artifacts/artifact-1?q=platform&page=2",
      workspaceName: "Artifact details",
      listHeading: "Artifacts",
    },
    {
      initialEntry: "/outreach/contact-1?employer=Acme",
      workspaceName: "Contact details",
      listHeading: "Contacts",
    },
    {
      initialEntry: "/runs/run-pipeline-1?status=failed&page=2",
      workspaceName: "Workflow run details",
      listHeading: "Workflow runs",
    },
    {
      initialEntry: "/jobs/job-1/run/run-pipeline-1?stage=apply&page=2",
      workspaceName: "Apply run details",
      listHeading: "Jobs",
    },
  ])(
    "renders only the $workspaceName workspace at its detail route",
    async ({ initialEntry, workspaceName, listHeading }) => {
      renderRoute(initialEntry);

      expect(
        await screen.findByRole("article", { name: workspaceName }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { level: 1, name: listHeading }),
      ).not.toBeInTheDocument();
    },
  );

  it.each([
    { initialEntry: "/jobs?stage=apply&page=2", listHeading: "Jobs" },
    {
      initialEntry: "/artifacts?q=platform&page=2",
      listHeading: "Artifacts",
    },
    {
      initialEntry: "/outreach?employer=Acme",
      listHeading: "Contacts",
    },
    {
      initialEntry: "/runs?status=failed&page=2",
      listHeading: "Workflow runs",
    },
  ])(
    "renders the $listHeading collection at its index route",
    async ({ initialEntry, listHeading }) => {
      renderRoute(initialEntry);

      expect(
        await screen.findByRole("heading", { level: 1, name: listHeading }),
      ).toBeInTheDocument();
    },
  );

  it("bypasses the job workspace when rendering a nested apply run", async () => {
    renderRoute("/jobs/job-1/run/run-pipeline-1?stage=apply&page=2");

    expect(
      await screen.findByRole("article", { name: "Apply run details" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("article", { name: "Job details" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a job-scoped activity route on event details with a separate job link", async () => {
    renderRoute("/activity/evt-1");

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Job scored 8/10",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open related job" }),
    ).toHaveAttribute("href", "/jobs/job-1");
    expect(
      screen.queryByRole("article", { name: "Job details" }),
    ).not.toBeInTheDocument();
  });
});

// Exercise the actual generated route tree without mounting observers: this
// distinguishes loader awaiting/cache policy from the hooks' mount policies.
describe("generated loader → context read → tenant cache", () => {
  const cases = [
    {
      entry: "/dashboard",
      method: "dashboardSummary",
      key: (t: TenantId) => dashboardKeys.summary(t),
    },
    {
      entry: "/profile",
      method: "profile",
      key: (t: TenantId) => profileKeys.profile(t),
    },
    {
      entry: "/preferences",
      method: "settings",
      key: (t: TenantId) => profileKeys.settings(t),
    },
    {
      entry: "/discovery",
      method: "profile",
      key: (t: TenantId) => profileKeys.profile(t),
    },
    {
      entry: "/debug?q=platform&page=2&level=error",
      method: "activity",
      args: [
        {
          page: 2,
          pageSize: 50,
          q: "platform",
          level: "error",
          stage: "",
          eventType: "",
          sort: "occurred_at",
          dir: "desc",
        },
      ],
      key: (t: TenantId) =>
        activityKeys.list(t, {
          page: 2,
          pageSize: 50,
          q: "platform",
          level: "error",
          stage: "",
          eventType: "",
          sort: "occurred_at",
          dir: "desc",
        }),
    },
    {
      entry: "/apply-review",
      method: "applyReviewQueue",
      key: (t: TenantId) => applyReviewKeys.queue(t),
    },
    {
      entry: "/analytics?dimension=fit_band",
      method: "outcomeAnalytics",
      args: [],
      key: (t: TenantId) =>
        analyticsKeys.outcomes(t, { dimension: "fit_band" }),
    },
    {
      entry: "/artifacts?q=platform&page=2&status=all",
      method: "artifacts",
      args: [
        {
          page: 2,
          pageSize: 50,
          q: "platform",
          sort: "created_at",
          dir: "desc",
          status: "",
        },
      ],
      key: (t: TenantId) =>
        artifactsKeys.list(t, {
          page: 2,
          pageSize: 50,
          q: "platform",
          sort: "created_at",
          dir: "desc",
          status: "",
        }),
    },
    {
      entry: "/outreach?employer=Acme&jobId=job-1",
      method: "listContacts",
      args: [{ employer: "Acme", jobId: "job-1" }],
      key: (t: TenantId) =>
        outreachKeys.contactList(t, { employer: "Acme", jobId: "job-1" }),
    },
    // Runs deliberately maps only page, pageSize and status in its loader.
    {
      entry: "/runs?status=failed&page=2&workflowType=ignored&sort=status",
      method: "workflowRuns",
      args: [{ page: 2, pageSize: 50, status: "failed" }],
      key: (t: TenantId) =>
        workflowRunsKeys.list(t, { page: 2, pageSize: 50, status: "failed" }),
    },
    {
      entry: "/evidence-map",
      method: "evidenceMap",
      key: (t: TenantId) => evidenceMapKeys.list(t),
    },
    {
      entry: "/activity/evt-1",
      method: "activityEvent",
      args: ["evt-1"],
      key: (t: TenantId) => activityKeys.detail(t, "evt-1"),
    },
  ] satisfies {
    entry: string;
    method: keyof ApiClientPort;
    args?: unknown[];
    key: (tenant: TenantId) => readonly unknown[];
  }[];

  function loaderRouter(entry: string, context: RouterContext) {
    return createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: [entry] }),
      context,
    });
  }

  it.each(cases)(
    "awaits cold reads, reuses fresh cache and separates tenants: $entry",
    async (c) => {
      const harness = buildProviderHarness();
      harness.queryClient.setDefaultOptions({
        queries: { retry: false, staleTime: 60_000, gcTime: Infinity },
      });
      const context = { ...harness, tenantId: LOCAL_TENANT };
      const spy = vi.spyOn(harness.ports.api, c.method);
      await loaderRouter(c.entry, context).load();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(...("args" in c ? c.args : []));
      const first = harness.queryClient.getQueryData(c.key(LOCAL_TENANT));
      expect(first).toBeDefined();
      const result = await spy.mock.results[0]!.value;
      expect(first).toEqual(
        c.method === "activityEvent"
          ? (result as ActivityEventResponse).event
          : result,
      );
      await loaderRouter(c.entry, context).load();
      expect(spy).toHaveBeenCalledTimes(1);

      const tenantId = createTenantId("loader-tenant-two");
      await loaderRouter(c.entry, { ...context, tenantId }).load();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(harness.queryClient.getQueryState(c.key(tenantId))?.status).toBe(
        "success",
      );
      expect(harness.queryClient.getQueryData(c.key(LOCAL_TENANT))).toEqual(
        first,
      );
      harness.queryClient.clear();
    },
  );

  it.each(cases)(
    "awaits a pending cold read and preserves failure policy: $entry",
    async (c) => {
      const harness = buildProviderHarness();
      const gate = Promise.withResolvers<void>();
      const spy = vi
        .spyOn(harness.ports.api, c.method)
        .mockImplementationOnce(async () => {
          await gate.promise;
          throw new Error("synthetic delayed read failure");
        });
      const router = loaderRouter(c.entry, {
        ...harness,
        tenantId: LOCAL_TENANT,
      });
      let settled = false;
      const loading = router.load().then(() => {
        settled = true;
      });
      try {
        await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
        expect(settled).toBe(false);
        expect(
          harness.queryClient.getQueryData(c.key(LOCAL_TENANT)),
        ).toBeUndefined();
      } finally {
        gate.resolve();
        await loading;
      }
      expect(
        harness.queryClient.getQueryState(c.key(LOCAL_TENANT))?.status,
      ).toBe("error");
      expect(router.state.matches.some((m) => m.status === "error")).toBe(
        c.method === "activityEvent",
      );
      harness.queryClient.clear();
    },
  );

  it.each(cases)(
    "preserves accepted data on failed refresh and recovers: $entry",
    async (c) => {
      const harness = buildProviderHarness();
      const context = { ...harness, tenantId: LOCAL_TENANT };
      const spy = vi.spyOn(harness.ports.api, c.method);
      const firstRouter = loaderRouter(c.entry, context);
      await firstRouter.load();
      const accepted = harness.queryClient.getQueryData(c.key(LOCAL_TENANT));
      expect(accepted).toBeDefined();
      const failure = new Error("synthetic loader read failed");
      spy.mockRejectedValueOnce(failure);
      if (c.method === "activityEvent") {
        // ensureQueryData returns even stale accepted data without fetching.
        await loaderRouter(c.entry, context).load();
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockReset().mockRejectedValueOnce(failure);
        harness.queryClient.removeQueries({
          queryKey: c.key(LOCAL_TENANT),
          exact: true,
        });
      }
      const failed = loaderRouter(c.entry, context);
      await failed.load();
      expect(
        harness.queryClient.getQueryState(c.key(LOCAL_TENANT))?.status,
      ).toBe("error");
      expect(failed.state.matches.some((m) => m.status === "error")).toBe(
        c.method === "activityEvent",
      );
      if (c.method !== "activityEvent")
        expect(harness.queryClient.getQueryData(c.key(LOCAL_TENANT))).toEqual(
          accepted,
        );
      spy.mockRestore();
      const recovered = loaderRouter(c.entry, context);
      await recovered.load();
      expect(recovered.state.matches.every((m) => m.status === "success")).toBe(
        true,
      );
      expect(
        harness.queryClient.getQueryState(c.key(LOCAL_TENANT))?.status,
      ).toBe("success");
      harness.queryClient.clear();
    },
  );

  it("prefetches every dashboard read and both profile-editor reads", async () => {
    const harness = buildProviderHarness();
    const context = { ...harness, tenantId: LOCAL_TENANT };
    await loaderRouter("/dashboard", context).load();
    for (const key of [
      dashboardKeys.summary(LOCAL_TENANT),
      outcomesKeys.list(LOCAL_TENANT),
      digestKeys.summary(LOCAL_TENANT),
      workflowRunsKeys.list(LOCAL_TENANT, STARTING_RUNS_INPUT),
      workflowRunsKeys.list(LOCAL_TENANT, IN_PROGRESS_RUNS_INPUT),
    ])
      expect(harness.queryClient.getQueryState(key)?.status).toBe("success");
    for (const entry of ["/profile", "/preferences"]) {
      harness.queryClient.clear();
      await loaderRouter(entry, context).load();
      expect(
        harness.queryClient.getQueryState(profileKeys.profile(LOCAL_TENANT))
          ?.status,
      ).toBe("success");
      expect(
        harness.queryClient.getQueryState(profileKeys.settings(LOCAL_TENANT))
          ?.status,
      ).toBe("success");
    }
    harness.queryClient.clear();
  });

  it("keeps previous URL caches while dependency changes fetch the next input", async () => {
    const harness = buildProviderHarness();
    const router = loaderRouter("/artifacts?q=first", {
      ...harness,
      tenantId: LOCAL_TENANT,
    });
    const spy = vi.spyOn(harness.ports.api, "artifacts");
    await router.load();
    const firstInput = spy.mock.calls[0]![0]!;
    const firstKey = artifactsKeys.list(LOCAL_TENANT, firstInput);
    const first = harness.queryClient.getQueryData(firstKey);
    router.history.push("/artifacts?q=second&page=2&status=approved");
    await router.load();
    expect(spy).toHaveBeenLastCalledWith({
      page: 2,
      pageSize: 50,
      q: "second",
      sort: "created_at",
      dir: "desc",
      status: "approved",
    });
    expect(harness.queryClient.getQueryData(firstKey)).toEqual(first);
    expect(
      harness.queryClient.getQueryData(
        artifactsKeys.list(LOCAL_TENANT, spy.mock.calls.at(-1)![0]!),
      ),
    ).toBeDefined();
    harness.queryClient.clear();
  });
});
