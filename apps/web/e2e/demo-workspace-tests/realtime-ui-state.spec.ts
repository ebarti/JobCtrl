import { expect, test, type Route } from "@playwright/test";

const MODULE_URLS = {
  repository: "/src/demo/workspace/DemoWorkspaceRepository.ts",
  storage: "/src/demo/workspace/storage.ts",
} as const;
const JOB_ID = "6e2f4a10-20be-4d5f-98a4-a4bb9a877a35";
const JOB_TITLE = "Platform systems lead";
const ARTIFACT_ID = "artifact-tailored-resume";
const RUN_ID = "run-materials-progress";
const TEMPORAL_RUN_ID = "temporal-run-realtime-regression";
const EVENT_AT = "2026-08-01T15:30:00.000Z";
const GOOGLE_TAG_ORIGIN = "https://www.googletagmanager.com";

const realtimeTest = test.extend<{ demoNetworkBoundary: void }>({
  demoNetworkBoundary: [
    async ({ baseURL, context }, use) => {
      if (!baseURL) throw new Error("Demo Playwright baseURL is required.");
      const demoOrigin = new URL(baseURL).origin;
      const forbiddenRequests: string[] = [];
      const guard = async (route: Route) => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.origin === demoOrigin && requestUrl.pathname === "/api/demo-consent") {
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({ choice: "granted", version: "v2" }),
          });
          return;
        }
        if (
          requestUrl.origin === demoOrigin
          && (requestUrl.pathname === "/api/demo-health"
            || requestUrl.pathname === "/api/demo-telemetry")
        ) {
          await route.fulfill({ status: 204, body: "" });
          return;
        }
        if (requestUrl.origin === GOOGLE_TAG_ORIGIN && requestUrl.pathname === "/gtag/js") {
          await route.fulfill({ contentType: "application/javascript", body: "" });
          return;
        }
        const forbidden =
          requestUrl.pathname === "/v1"
          || requestUrl.pathname === "/v1/events/stream"
          || requestUrl.pathname.startsWith("/v1/")
          || requestUrl.origin !== demoOrigin;
        if (forbidden) {
          forbiddenRequests.push(route.request().url());
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      };
      await context.route("**/*", guard);
      try {
        await use();
      } finally {
        await context.unroute("**/*", guard);
        expect(
          forbiddenRequests,
          "realtime UI regression must stay inside the browser-local demo",
        ).toEqual([]);
      }
    },
    { auto: true },
  ],
});

realtimeTest("realtime patches preserve filters, selection, pagination, and scroll", async ({
  page: jobsPage,
  context,
}) => {
  await jobsPage.goto(
    "/jobs?q=Platform&stage=all&state=all&deleted=active&sort=title&dir=asc&page=1&pageSize=25",
  );
  await expect(jobsPage.getByRole("heading", { name: "Jobs" })).toBeVisible();

  const artifactsPage = await context.newPage();
  await artifactsPage.goto(
    "/artifacts?q=Platform&status=all&sort=title&dir=asc&page=1&pageSize=25",
  );
  await expect(artifactsPage.getByRole("heading", { name: "Artifacts" })).toBeVisible();

  const runPage = await context.newPage();
  await runPage.goto(
    `/runs/${RUN_ID}?status=all&workflowType=JobPipelineWorkflow&sort=started_at&dir=desc&page=1&pageSize=25`,
  );
  await expect(
    runPage.getByRole("article", { name: "Workflow run details" }),
  ).toBeVisible();

  const dashboardPage = await context.newPage();
  await dashboardPage.goto("/dashboard");
  await expect(dashboardPage.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  const jobsRow = jobsPage.getByRole("row").filter({ hasText: JOB_TITLE });
  const jobSelection = jobsRow.getByRole("checkbox");
  await jobSelection.check();
  await expect(jobSelection).toBeChecked();

  const artifactRow = artifactsPage
    .getByRole("row")
    .filter({ hasText: JOB_TITLE })
    .filter({ hasText: "612 B" });
  const artifactSelection = artifactRow.getByRole("checkbox");
  await artifactSelection.check();
  await expect(artifactSelection).toBeChecked();

  const jobsScroll = jobsPage.locator(".filterable-data-grid-scroll").first();
  const artifactsScroll = artifactsPage.locator(".filterable-data-grid-scroll").first();
  const jobsScrollLeft = await setNonDefaultScroll(jobsScroll);
  const artifactsScrollLeft = await setNonDefaultScroll(artifactsScroll);

  const urlsBefore = await Promise.all([
    jobsPage.url(),
    artifactsPage.url(),
    runPage.url(),
    dashboardPage.url(),
  ]);
  const navigationCountsBefore = await Promise.all(
    [jobsPage, artifactsPage, runPage, dashboardPage].map((candidate) =>
      candidate.evaluate(() => performance.getEntriesByType("navigation").length),
    ),
  );

  const result = await jobsPage.evaluate(
    async ({ moduleUrls, jobId, artifactId, runId, temporalRunId, eventAt }) => {
      const [repositoryModule, storageModule] = await Promise.all([
        import(moduleUrls.repository),
        import(moduleUrls.storage),
      ]);
      const workspace = new repositoryModule.DemoWorkspaceRepository({
        store: new storageModule.IndexedDbDemoWorkspaceStore(),
      });
      await workspace.initialize();
      (window as typeof window & { __jobctrlRealtimeWorkspace?: unknown })
        .__jobctrlRealtimeWorkspace = workspace;
      const committed = await workspace.mutate(
        (
          draft: unknown,
          mutation: { appendDomainEvent(event: unknown): void },
        ) => {
          const readModel = (draft as MutableRealtimeDraft).state.readModel;
          const job = readModel.jobs.list.items.find((item) => item.jobKey === jobId);
          const jobDetail = readModel.jobs.details[jobId]?.job;
          const artifact = readModel.materials.list.items.find(
            (item) => item.artifactId === artifactId,
          );
          const artifactDetail = readModel.materials.details[artifactId]?.artifact;
          const run = readModel.runs.list.items.find((item) => item.workflowId === runId);
          const runDetail = readModel.runs.details[runId];
          if (!job || !jobDetail || !artifact || !artifactDetail || !run || !runDetail) {
            throw new Error("Expected seeded realtime projection records.");
          }

          job.activeState = "unknown";
          jobDetail.activeState = "unknown";
          artifact.status = "approved";
          artifactDetail.status = "approved";
          run.status = "succeeded";
          run.finishedAt = eventAt;
          run.durationMs = 120_000;
          runDetail.status = "succeeded";
          runDetail.temporalRunId = temporalRunId;
          runDetail.finishedAt = eventAt;
          runDetail.durationMs = 120_000;
          runDetail.retryable = false;
          readModel.dashboard.summary.totals.failures = 0;
          readModel.dashboard.summary.work.active = 1;

          mutation.appendDomainEvent({
            eventType: "JobActiveStateChanged",
            tenantId: "local",
            occurredAt: eventAt,
            payload: {
              jobId,
              activeState: "unknown",
              previousState: "active",
              verificationMethod: "snapshot_capture",
              verifiedAt: eventAt,
            },
          });
          mutation.appendDomainEvent({
            eventType: "ResumeApproved",
            tenantId: "local",
            occurredAt: eventAt,
            payload: { jobId, artifactId, generation: 2, approvedAt: eventAt },
          });
          mutation.appendDomainEvent({
            eventType: "WorkflowCompleted",
            tenantId: "local",
            occurredAt: eventAt,
            payload: {
              workflowId: runId,
              workflowType: "JobPipelineWorkflow",
              status: "succeeded",
              finishedAt: eventAt,
              durationMs: 120_000,
              temporalRunId,
            },
          });
        },
      );
      return committed.kind;
    },
    {
      moduleUrls: MODULE_URLS,
      jobId: JOB_ID,
      artifactId: ARTIFACT_ID,
      runId: RUN_ID,
      temporalRunId: TEMPORAL_RUN_ID,
      eventAt: EVENT_AT,
    },
  );
  expect(result).toBe("committed");

  await expect(jobsRow).toBeVisible();
  await expect(artifactRow.getByText(/^approved$/i)).toBeVisible();
  await expect(runPage.getByText(/^succeeded$/i).first()).toBeVisible();
  await expect(
    dashboardPage
      .locator(".dashboard-kpi")
      .filter({ hasText: "Failures" })
      .locator('[data-slot="stat-value"]'),
  ).toHaveText("0");

  await expect(jobSelection).toBeChecked();
  await expect(artifactSelection).toBeChecked();
  expect(await jobsScroll.evaluate((element) => element.scrollLeft)).toBe(jobsScrollLeft);
  expect(await artifactsScroll.evaluate((element) => element.scrollLeft)).toBe(
    artifactsScrollLeft,
  );
  expect([
    jobsPage.url(),
    artifactsPage.url(),
    runPage.url(),
    dashboardPage.url(),
  ]).toEqual(urlsBefore);

  const navigationCountsAfter = await Promise.all(
    [jobsPage, artifactsPage, runPage, dashboardPage].map((candidate) =>
      candidate.evaluate(() => performance.getEntriesByType("navigation").length),
    ),
  );
  expect(navigationCountsAfter).toEqual(navigationCountsBefore);
});

async function setNonDefaultScroll(locator: import("@playwright/test").Locator): Promise<number> {
  await expect(locator).toBeVisible();
  const available = await locator.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(available).toBeGreaterThan(0);
  const target = Math.min(64, available);
  await locator.evaluate((element, scrollLeft) => {
    element.scrollLeft = scrollLeft;
  }, target);
  await expect.poll(() => locator.evaluate((element) => element.scrollLeft)).toBe(target);
  return target;
}

interface MutableRealtimeDraft {
  state: {
    readModel: {
      jobs: {
        list: { items: Array<{ jobKey: string; activeState: string }> };
        details: Record<string, { job: { activeState: string } }>;
      };
      materials: {
        list: { items: Array<{ artifactId: string; status: string }> };
        details: Record<string, { artifact: { status: string } }>;
      };
      runs: {
        list: {
          items: Array<{
            workflowId: string;
            status: string;
            finishedAt: string | null;
            durationMs: number | null;
          }>;
        };
        details: Record<
          string,
          {
            status: string;
            temporalRunId: string | null;
            finishedAt: string | null;
            durationMs: number | null;
            retryable: boolean;
          }
        >;
      };
      dashboard: {
        summary: {
          totals: { failures: number };
          work: { active: number };
        };
      };
    };
  };
}
