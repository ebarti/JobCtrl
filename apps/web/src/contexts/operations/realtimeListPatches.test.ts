import {
  LOCAL_TENANT,
  createJobActiveStateChanged,
  createJobUpdated,
  createResumeApproved,
  createPdfRendered,
  type TenantId,
} from "@jobctrl/domain-types";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  makeJobsPage,
  makeArtifactsPage,
  sampleJob,
  sampleSecondaryJob,
  sampleDraftResumeArtifact,
  sampleDashboardSummary,
} from "../../test/fixtures/projections.js";
import { jobsKeys } from "./jobsKeys.js";
import { artifactsKeys } from "./artifactsKeys.js";
import { dashboardKeys } from "./dashboardKeys.js";
import { invalidationRouter } from "./invalidation-router.js";
import type { ArtifactsListInput, JobsListInput } from "./types.js";

const OTHER = "other" as TenantId;
const approval = createResumeApproved(LOCAL_TENANT, {
  jobId: sampleDraftResumeArtifact.jobKey,
  artifactId: sampleDraftResumeArtifact.artifactId,
  generation: 2,
  approvedAt: "2026-09-12T10:00:00Z",
});
const availability = (
  activeState: "closed" | "active" | "expired",
  previousState: "active" | "closed" = "active",
) =>
  createJobActiveStateChanged(LOCAL_TENANT, {
    jobId: sampleJob.jobKey,
    activeState,
    previousState,
    verificationMethod: "snapshot",
    verifiedAt: "2026-09-12T10:00:00Z",
  });

// Exercise the router against real QueryClient cache entries, including pages
// not containing the changed row and other tenants with identical identifiers.
describe("event-specific list reconciliation", () => {
  it("patches eligible job pages without changing filters, pagination, row order or unrelated references", () => {
    const client = new QueryClient();
    const input: JobsListInput = {
      page: 3,
      pageSize: 20,
      sort: "fit_score",
      dir: "asc",
      source: "lever",
      normalizedScoreKeyword: "platform",
      stages: ["score", "tailor"],
    };
    const key = jobsKeys.list(LOCAL_TENANT, input);
    const page = makeJobsPage([sampleSecondaryJob, sampleJob]);
    page.pagination = { page: 3, pageSize: 20, total: 70, pages: 4 };
    const otherKey = jobsKeys.list(OTHER, input);
    client.setQueryData(key, page);
    client.setQueryData(otherKey, page);
    invalidationRouter.handle(
      createJobUpdated(LOCAL_TENANT, {
        jobId: sampleJob.jobKey,
        changedFields: { title: "New title", company: "  New employer  " },
      }),
      client,
    );
    const next = client.getQueryData<typeof page>(key)!;
    expect(next.items.map((row) => row.jobKey)).toEqual(
      page.items.map((row) => row.jobKey),
    );
    expect(next.items[1]).toMatchObject({
      title: "New title",
      company: "New employer",
    });
    expect(next.items[0]).toBe(page.items[0]);
    expect(next.pagination).toBe(page.pagination);
    expect(next.sort).toBe(page.sort);
    expect(next.filter).toBe(page.filter);
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    expect(client.getQueryData(otherKey)).toBe(page);
    expect(client.getQueryState(otherKey)?.isInvalidated).toBe(false);
    client.clear();
  });

  it.each<JobsListInput>([
    { q: "new" },
    { sort: "title" },
    { sort: "company" },
    { company: "new" },
  ])(
    "invalidates a display edit when membership/order is unknown: %j",
    (input) => {
      const client = new QueryClient();
      const key = jobsKeys.list(LOCAL_TENANT, input);
      const page = makeJobsPage([sampleSecondaryJob]);
      client.setQueryData(key, page);
      invalidationRouter.handle(
        createJobUpdated(LOCAL_TENANT, {
          jobId: sampleJob.jobKey,
          changedFields: { title: "New title", company: "New employer" },
        }),
        client,
      );
      expect(client.getQueryData(key)).toBe(page);
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
      client.clear();
    },
  );

  it("retains fallback for unknown fields and malformed values, without partially applying known fields", () => {
    for (const changedFields of [
      { title: "New", location: "Berlin" },
      { title: 3 },
      {},
    ]) {
      const client = new QueryClient();
      const key = jobsKeys.list(LOCAL_TENANT, {});
      const page = makeJobsPage();
      client.setQueryData(key, page);
      invalidationRouter.handle(
        createJobUpdated(LOCAL_TENANT, {
          jobId: sampleJob.jobKey,
          changedFields,
        }),
        client,
      );
      expect(client.getQueryData(key)).toBe(page);
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
      client.clear();
    }
  });

  it("patches all/deleted/hidden queues but invalidates active and closed queue boundaries", () => {
    const client = new QueryClient();
    const inputs: JobsListInput[] = [
      {},
      { deleted: "closed" },
      { deleted: "all", q: "engineer" },
      { deleted: "hidden" },
      { deleted: "deleted", page: 3 },
    ];
    const page = makeJobsPage();
    for (const input of inputs)
      client.setQueryData(jobsKeys.list(LOCAL_TENANT, input), page);
    invalidationRouter.handle(availability("closed"), client);
    for (const [index, input] of inputs.entries()) {
      const key = jobsKeys.list(LOCAL_TENANT, input);
      expect(client.getQueryState(key)?.isInvalidated).toBe(index < 2);
      expect(client.getQueryData<typeof page>(key)?.items[0]?.activeState).toBe(
        index < 2 ? sampleJob.activeState : "closed",
      );
    }
    client.clear();
  });

  it("keeps same-class transitions in their active/closed pages and handles duplicate events", () => {
    const client = new QueryClient();
    const key = jobsKeys.list(LOCAL_TENANT, { deleted: "closed" });
    client.setQueryData(
      key,
      makeJobsPage([{ ...sampleJob, activeState: "closed" }]),
    );
    invalidationRouter.handle(availability("expired", "closed"), client);
    invalidationRouter.handle(availability("expired", "closed"), client);
    expect(
      client.getQueryData<ReturnType<typeof makeJobsPage>>(key)?.items[0]
        ?.activeState,
    ).toBe("expired");
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    client.clear();
  });

  it("patches an existing artifact but reconciles registration and suppression side effects", () => {
    const client = new QueryClient();
    const input: ArtifactsListInput = {
      page: 2,
      type: "resume",
      sort: "created_at",
      dir: "asc",
    };
    const key = artifactsKeys.list(LOCAL_TENANT, input);
    const otherKey = artifactsKeys.list(OTHER, input);
    const page = makeArtifactsPage([sampleDraftResumeArtifact]);
    client.setQueryData(key, page);
    client.setQueryData(otherKey, page);
    invalidationRouter.handle(approval, client);
    const next = client.getQueryData<typeof page>(key)!;
    expect(next.items[0]?.status).toBe("approved");
    expect(next.pagination).toBe(page.pagination);
    expect(next.sort).toBe(page.sort);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(client.getQueryData(otherKey)).toBe(page);
    client.clear();
  });

  it("invalidates each approval-sensitive page once without a second family-wide refetch", () => {
    const client = new QueryClient();
    const key = artifactsKeys.list(LOCAL_TENANT, { status: "candidate" });
    client.setQueryData(key, makeArtifactsPage([sampleDraftResumeArtifact]));
    const invalidations = vi.spyOn(client, "invalidateQueries");
    invalidationRouter.handle(approval, client);
    const artifactInvalidations = invalidations.mock.calls.filter(([filters]) => filters?.queryKey?.[2] === "artifacts");
    expect(artifactInvalidations).toHaveLength(1);
    expect(artifactInvalidations[0]?.[0]).toEqual({ queryKey: key, exact: true });
    client.clear();
  });

  it.each<ArtifactsListInput>([
    { status: "candidate" },
    { status: "approved" },
    { q: "approved" },
    { sort: "status" },
  ])("invalidates approval-sensitive artifact pages: %j", (input) => {
    const client = new QueryClient();
    const key = artifactsKeys.list(LOCAL_TENANT, input);
    const page = makeArtifactsPage([sampleDraftResumeArtifact]);
    client.setQueryData(key, page);
    invalidationRouter.handle(approval, client);
    expect(client.getQueryData(key)).toBe(page);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    client.clear();
  });

  it("does not invent missing artifacts or unsuppress rows without reconciling totals", () => {
    for (const rows of [
      [],
      [{ ...sampleDraftResumeArtifact, status: "suppressed" }],
    ]) {
      const client = new QueryClient();
      const key = artifactsKeys.list(LOCAL_TENANT, { page: 3 });
      const page = makeArtifactsPage(rows);
      client.setQueryData(key, page);
      invalidationRouter.handle(approval, client);
      expect(client.getQueryData(key)).toBe(page);
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
      client.clear();
    }
  });

  it("preserves page age so partial patches cannot suppress a stale remount fetch", async () => {
    const client = new QueryClient();
    const key = jobsKeys.list(LOCAL_TENANT, {});
    const page = makeJobsPage();
    const updatedAt = Date.now() - 60_000;
    client.setQueryData(key, page, { updatedAt });
    invalidationRouter.handle(
      createJobUpdated(LOCAL_TENANT, {
        jobId: sampleJob.jobKey,
        changedFields: { title: "Changed" },
      }),
      client,
    );
    expect(client.getQueryState(key)?.dataUpdatedAt).toBe(updatedAt);
    const canonical = makeJobsPage([
      { ...sampleJob, title: "Changed", fitScore: 10 },
    ]);
    const queryFn = vi.fn(async () => canonical);
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn,
      staleTime: 30_000,
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(client.getQueryData(key)).toEqual(canonical));
    unsubscribe();
    client.clear();
  });

  it("preserves invalidation from an earlier event instead of declaring a partial patch fresh", async () => {
    const client = new QueryClient();
    const key = jobsKeys.list(LOCAL_TENANT, { deleted: "all" });
    const page = makeJobsPage();
    client.setQueryData(key, page);
    await client.invalidateQueries({ queryKey: key });
    invalidationRouter.handle(availability("closed"), client);
    expect(client.getQueryData(key)).toBe(page);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    client.clear();
  });

  it("keeps PDF rendering bounded invalidation because no path, size or complete artifact is carried", () => {
    const client = new QueryClient();
    const key = artifactsKeys.list(LOCAL_TENANT, {});
    client.setQueryData(key, makeArtifactsPage());
    client.setQueryData(artifactsKeys.list(OTHER, {}), makeArtifactsPage());
    invalidationRouter.handle(
      createPdfRendered(LOCAL_TENANT, {
        jobId: sampleJob.jobKey,
        artifactId: "new",
        artifactType: "resume",
        renderedAt: "2026-09-12T10:00:00Z",
      }),
      client,
    );
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(
      client.getQueryState(artifactsKeys.list(OTHER, {}))?.isInvalidated,
    ).toBe(false);
    client.clear();
  });

  it("patches existing dashboard job labels while retaining canonical activity/aggregate refresh", () => {
    const client = new QueryClient();
    const key = dashboardKeys.summary(LOCAL_TENANT);
    const summary = {
      ...sampleDashboardSummary,
      activity: [
        { ...sampleDashboardSummary.activity[0]!, jobKey: sampleJob.jobKey },
      ],
    };
    client.setQueryData(key, summary);
    client.setQueryData(dashboardKeys.summary(OTHER), summary);
    invalidationRouter.handle(
      createJobUpdated(LOCAL_TENANT, {
        jobId: sampleJob.jobKey,
        changedFields: { title: "Changed" },
      }),
      client,
    );
    const next = client.getQueryData<typeof summary>(key)!;
    expect(next.activity[0]?.title).toBe("Changed");
    expect(next.totals).toBe(summary.totals);
    expect(next.applyRuns).toBe(summary.applyRuns);
    expect(next.activity).toHaveLength(summary.activity.length);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(client.getQueryData(dashboardKeys.summary(OTHER))).toBe(summary);
    client.clear();
  });
});
