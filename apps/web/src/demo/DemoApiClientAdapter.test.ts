import { describe, expect, it, vi } from "vitest";

import {
  JOB_SORT_FIELDS,
  type ActivityEventSummary,
  type ArtifactDetail,
  type JobCompensationSummary,
  type JobSummary,
} from "@jobctrl/contracts";

import type { ApiClientPort } from "../shared/ports/ApiClientPort.js";
import { FakeTelemetryPort } from "../test/testPorts.js";
import { DEMO_CAPABILITY_MANIFEST } from "./capabilities.js";
import {
  DemoApiClientAdapter,
  DemoResourceNotFoundError,
  type DemoApiClientAdapterOptions,
} from "./DemoApiClientAdapter.js";
import { DemoCapabilityError } from "./ports.js";
import {
  DemoWorkspaceRepository,
  InMemoryDemoWorkspaceStore,
} from "./workspace/index.js";

async function createAdapter(
  options: DemoApiClientAdapterOptions = {},
): Promise<{
  adapter: DemoApiClientAdapter;
  repository: DemoWorkspaceRepository;
}> {
  const repository = new DemoWorkspaceRepository({
    store: new InMemoryDemoWorkspaceStore(),
    clock: { now: () => new Date("2026-07-11T09:00:00.000Z") },
    createWorkspaceId: () => "workspace-adapter-test",
  });
  await repository.initialize();
  return { adapter: new DemoApiClientAdapter(repository, options), repository };
}

function compensationSummary(
  options: {
    postedState?: JobCompensationSummary["posted"]["parseState"];
    postedAmount?: number;
    legacyRawSalary?: string | null;
    marketRecordStatus?: JobCompensationSummary["market"]["recordStatus"];
    marketState?: JobCompensationSummary["market"]["estimateState"];
    marketAmount?: number;
    confidenceBand?: JobCompensationSummary["market"]["confidenceBand"];
    confidenceScore?: number | null;
    warningCount?: number;
  } = {},
): JobCompensationSummary {
  const range = (amount: number) => ({
    currency: "EUR",
    period: "year",
    component: "base_salary",
    minimumAmount: amount,
    maximumAmount: amount + 1,
    annualizedMinimumAmount: amount,
    annualizedMaximumAmount: amount + 1,
    annualizedMinimumEur: amount,
    annualizedMaximumEur: amount + 1,
    displayRange: `€${amount}–€${amount + 1}`,
  });
  const postedRange =
    options.postedAmount === undefined ? null : range(options.postedAmount);
  const marketRange =
    options.marketAmount === undefined ? null : range(options.marketAmount);
  return {
    projectionVersion: 1,
    legacyRawSalary: options.legacyRawSalary ?? null,
    warningCount: options.warningCount ?? 0,
    posted: {
      sourceKind: "posted",
      recordStatus: "recorded",
      parseState: options.postedState ?? "parsed_range",
      confidence: postedRange ? "high" : "none",
      warningCount: 0,
      range: postedRange,
      displayRange: postedRange?.displayRange ?? null,
    },
    market: {
      sourceKind: "reported_company_role_market",
      recordStatus: options.marketRecordStatus ?? "recorded",
      estimateState: options.marketState ?? "estimated_range",
      confidenceBand: options.confidenceBand ?? "none",
      confidenceScore: options.confidenceScore ?? null,
      sourceCount: 0,
      sampleCount: null,
      warningCount: 0,
      range: marketRange,
      displayRange: marketRange?.displayRange ?? null,
      confidenceInterval: null,
      displayConfidenceInterval: null,
    },
  };
}

async function replaceJobs(
  repository: DemoWorkspaceRepository,
  jobs: JobSummary[],
): Promise<void> {
  await repository.mutate((draft) => {
    draft.state.readModel.jobs.list.items = jobs;
  });
}

const READ_CASES = [
  ["health", (api: ApiClientPort) => api.health()],
  ["dashboardSummary", (api: ApiClientPort) => api.dashboardSummary()],
  ["outcomeAnalytics", (api: ApiClientPort) => api.outcomeAnalytics()],
  ["digest", (api: ApiClientPort) => api.digest()],
  ["activity", (api: ApiClientPort) => api.activity()],
  [
    "activityEvent",
    (api: ApiClientPort) => api.activityEvent("event-demo-score"),
  ],
  ["discoverySettings", (api: ApiClientPort) => api.discoverySettings()],
  ["discoverySources", (api: ApiClientPort) => api.discoverySources()],
  [
    "discoverySourcePreview",
    (api: ApiClientPort) => api.discoverySourcePreview("demo-source:northwind"),
  ],
  ["compensationSources", (api: ApiClientPort) => api.compensationSources()],
  [
    "discoveryLocatorCandidates",
    (api: ApiClientPort) => api.discoveryLocatorCandidates(),
  ],
  ["discoveryQuarantine", (api: ApiClientPort) => api.discoveryQuarantine()],
  ["manualCaptureQueue", (api: ApiClientPort) => api.manualCaptureQueue()],
  [
    "roleMatchFeedbackSuggestions",
    (api: ApiClientPort) => api.roleMatchFeedbackSuggestions(),
  ],
  ["applyReviewQueue", (api: ApiClientPort) => api.applyReviewQueue()],
  [
    "resumeReviewDraft",
    (api: ApiClientPort) => api.resumeReviewDraft("job-northwind-platform"),
  ],
  [
    "resumeReviewFeedback",
    (api: ApiClientPort) => api.resumeReviewFeedback("job-northwind-platform"),
  ],
  ["resumeTemplates", (api: ApiClientPort) => api.resumeTemplates()],
  [
    "resumeTemplate",
    (api: ApiClientPort) => api.resumeTemplate("demo-template"),
  ],
  ["applicationOutcomes", (api: ApiClientPort) => api.applicationOutcomes()],
  [
    "jobApplicationOutcomes",
    (api: ApiClientPort) =>
      api.jobApplicationOutcomes("job-northwind-platform"),
  ],
  ["jobs", (api: ApiClientPort) => api.jobs()],
  ["job", (api: ApiClientPort) => api.job("job-northwind-platform")],
  ["evidenceMap", (api: ApiClientPort) => api.evidenceMap()],
  ["workflowRuns", (api: ApiClientPort) => api.workflowRuns()],
  [
    "workflowRun",
    (api: ApiClientPort) => api.workflowRun("run-materials-progress"),
  ],
  ["artifacts", (api: ApiClientPort) => api.artifacts()],
  [
    "artifact",
    (api: ApiClientPort) => api.artifact("artifact-tailored-resume"),
  ],
  [
    "artifactPreviewPdfUrl",
    (api: ApiClientPort) =>
      api.artifactPreviewPdfUrl("artifact-tailored-resume", 7),
  ],
  [
    "artifactPreviewHtmlUrl",
    (api: ApiClientPort) =>
      api.artifactPreviewHtmlUrl("artifact-tailored-resume", 7),
  ],
  ["profile", (api: ApiClientPort) => api.profile()],
  ["profilePreviewPdfUrl", (api: ApiClientPort) => api.profilePreviewPdfUrl(7)],
  [
    "profilePreviewHtmlUrl",
    (api: ApiClientPort) => api.profilePreviewHtmlUrl(7),
  ],
  ["settings", (api: ApiClientPort) => api.settings()],
  ["credentials", (api: ApiClientPort) => api.credentials()],
  ["listContacts", (api: ApiClientPort) => api.listContacts()],
  [
    "contact",
    (api: ApiClientPort) => api.contact("contact-demo-hiring-partner"),
  ],
  ["researchTasks", (api: ApiClientPort) => api.researchTasks()],
  [
    "researchTask",
    (api: ApiClientPort) => api.researchTask("research-demo-hiring-partner"),
  ],
  [
    "outreachThread",
    (api: ApiClientPort) => api.outreachThread("contact-demo-hiring-partner"),
  ],
  ["dueOutreachFollowUps", (api: ApiClientPort) => api.dueOutreachFollowUps()],
] as const satisfies readonly (readonly [
  keyof ApiClientPort,
  (api: ApiClientPort) => unknown,
])[];

const READ_METHODS = new Set<keyof ApiClientPort>(
  READ_CASES.map(([method]) => method),
);

describe("DemoApiClientAdapter", () => {
  it("covers every port member and reserves capability errors for unavailable methods", async () => {
    const { adapter } = await createAdapter();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      for (const [method, invoke] of READ_CASES) {
        const result = await invoke(adapter);
        expect(result, method).not.toBeNull();
        expect(result, method).not.toBeUndefined();
        if (typeof result === "string") {
          expect(result, method).toMatch(/^\/demo\/[^\\]+/);
          expect(result, method).not.toContain("://");
          expect(result, method).not.toContain("..");
        }
      }

      const manifestMethods = Object.keys(
        DEMO_CAPABILITY_MANIFEST,
      ) as (keyof ApiClientPort)[];
      const commandMethods = manifestMethods.filter(
        (method) => !READ_METHODS.has(method),
      );
      expect([...READ_METHODS, ...commandMethods].toSorted()).toEqual(
        manifestMethods.toSorted(),
      );
      const intentionallyDeferred = commandMethods.filter(
        (method) => DEMO_CAPABILITY_MANIFEST[method].class === "unavailable",
      );
      for (const method of intentionallyDeferred) {
        const invoke = adapter[method] as unknown as (
          ...args: unknown[]
        ) => unknown;
        await expect(
          Promise.resolve().then(() => invoke()),
        ).rejects.toMatchObject({
          name: "DemoCapabilityError",
          code: "demo_capability_not_implemented",
          message: expect.stringContaining(String(method)),
        });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("reads fresh immutable snapshots instead of exposing or caching repository authority", async () => {
    const { adapter, repository } = await createAdapter();
    const first = await adapter.jobs();
    first.items[0]!.title = "caller mutation";
    expect((await adapter.jobs()).items[0]!.title).not.toBe("caller mutation");

    await repository.mutate((draft) => {
      draft.state.readModel.jobs.details["job-northwind-platform"]!.job.title =
        "authoritative update";
    });
    expect((await adapter.job("job-northwind-platform")).job.title).toBe(
      "authoritative update",
    );
  });

  it("resolves synchronous previews only from current repository authority", async () => {
    const { adapter, repository } = await createAdapter();
    expect(adapter.artifactPreviewPdfUrl("artifact-tailored-resume")).toBe(
      "/demo/tailored-resume.pdf",
    );

    await repository.mutate((draft) => {
      const artifacts = draft.state.artifacts as unknown as {
        profileResumePdf: { url: `/demo/${string}` };
        tailoredResumePdf: { url: `/demo/${string}` };
      };
      artifacts.profileResumePdf.url = "/demo/profile-replaced.pdf";
      artifacts.tailoredResumePdf.url = "/demo/generated-resume.pdf";
      const details = draft.state.readModel.materials
        .details as unknown as Record<string, ArtifactDetail>;
      details["artifact-tailored-resume"]!.artifact.localPath =
        "/demo/generated-resume.pdf";
    });
    expect(adapter.profilePreviewPdfUrl()).toBe("/demo/profile-replaced.pdf");
    expect(adapter.artifactPreviewPdfUrl("artifact-tailored-resume")).toBe(
      "/demo/generated-resume.pdf",
    );

    await repository.mutate((draft) => {
      const details = draft.state.readModel.materials
        .details as unknown as Record<string, ArtifactDetail>;
      delete details["artifact-tailored-resume"];
    });
    expect(() =>
      adapter.artifactPreviewPdfUrl("artifact-tailored-resume"),
    ).toThrow(DemoResourceNotFoundError);

    await repository.reset();
    expect(adapter.artifactPreviewPdfUrl("artifact-tailored-resume")).toBe(
      "/demo/tailored-resume.pdf",
    );
    expect(adapter.profilePreviewPdfUrl()).toBe("/demo/profile-resume.pdf");

    await repository.mutate((draft) => {
      const details = draft.state.readModel.materials
        .details as unknown as Record<string, ArtifactDetail>;
      const generated = structuredClone(details["artifact-tailored-resume"]!);
      generated.artifact.artifactId = "artifact-generated";
      generated.artifact.localPath = "/demo/generated-new.pdf";
      details["artifact-generated"] = generated;
    });
    expect(() => adapter.artifactPreviewPdfUrl("artifact-generated")).toThrow(
      expect.objectContaining({
        code: "artifact_preview_not_found",
        status: 404,
      }),
    );

    await repository.mutate((draft) => {
      const artifacts = draft.state.artifacts as unknown as {
        tailoredResumePdf: { url: `/demo/${string}` };
      };
      artifacts.tailoredResumePdf.url = "/demo/generated-new.pdf";
    });
    expect(adapter.artifactPreviewPdfUrl("artifact-generated")).toBe(
      "/demo/generated-new.pdf",
    );
  });

  it("delegates artifact opening to the no-host-OS rehearsal", async () => {
    const { adapter, repository } = await createAdapter({
      external: { opener: () => ({ close: vi.fn() }) },
    });
    const before = (await repository.snapshot()).state.receipts.length;

    await expect(
      adapter.openArtifact("artifact-tailored-resume"),
    ).resolves.toMatchObject({
      ok: true,
      opened: true,
      path: "/demo/tailored-resume.pdf",
    });
    expect((await repository.snapshot()).state.receipts).toHaveLength(before + 1);
  });

  it("matches production job filters, sorting, pagination, and filter metadata", async () => {
    const { adapter } = await createAdapter();
    const filtered = await adapter.jobs({
      q: "systems",
      company: "fabrikam",
      source: "northwind",
      minFitScore: 7,
      maxFitScore: 7,
      stage: "score",
      state: "failed",
      sort: "title",
      dir: "asc",
      page: 3,
      pageSize: 1,
    });
    expect(filtered.items.map((job) => job.jobKey)).toEqual([
      "job-fabrikam-systems",
    ]);
    expect(filtered.pagination).toEqual({
      page: 1,
      pageSize: 1,
      total: 1,
      pages: 1,
    });
    expect(filtered.sort).toEqual({ field: "title", dir: "asc" });
    expect(filtered.filter).toMatchObject({
      q: "systems",
      company: "fabrikam",
      source: "northwind",
      minFitScore: 7,
      maxFitScore: 7,
      stage: "score",
      state: "failed",
      deleted: "active",
    });

    const page = await adapter.jobs({
      sort: "fit_score",
      dir: "desc",
      page: 2,
      pageSize: 1,
    });
    expect(page.items.map((job) => job.jobKey)).toEqual([
      "job-fabrikam-systems",
    ]);
    expect(page.pagination).toEqual({
      page: 2,
      pageSize: 1,
      total: 3,
      pages: 3,
    });
  });

  it("keeps the Failures KPI total equal to its failed-jobs query", async () => {
    const { adapter } = await createAdapter();

    const [summary, failedJobs] = await Promise.all([
      adapter.dashboardSummary(),
      adapter.jobs({ state: "failed", deleted: "active" }),
    ]);

    expect(summary.totals.failures).toBe(failedJobs.pagination.total);
    expect(failedJobs.items.map((job) => job.jobKey)).toEqual([
      "job-fabrikam-systems",
    ]);
  });

  it("matches every production job sort arm and stable key tie-break", async () => {
    const { adapter, repository } = await createAdapter();
    const base = repository.snapshotNow().state.readModel.jobs.list.items[0]!;
    const low: JobSummary = {
      ...structuredClone(base),
      jobKey: "sort-low",
      discoveredAt: "2026-01-01T00:00:00.000Z",
      title: "apple",
      company: "alpha",
      source: "alpha",
      discoverySource: "alpha",
      postingSource: "",
      location: "alpha",
      fitScore: 1,
      currentStage: "apply",
      currentSubstage: "apply",
      currentState: "failed",
      applyStatus: null,
      salary: "",
      compensationSummary: compensationSummary({
        postedAmount: 10,
        marketAmount: 10,
        confidenceBand: "low",
        confidenceScore: 0.2,
        warningCount: 0,
      }),
    };
    const high: JobSummary = {
      ...structuredClone(base),
      jobKey: "sort-high",
      discoveredAt: "2026-02-01T00:00:00.000Z",
      title: "Zulu",
      company: "Zulu",
      source: "zulu",
      discoverySource: "zulu",
      postingSource: "",
      location: "Zulu",
      fitScore: 9,
      currentStage: "tailor",
      currentSubstage: "tailor",
      currentState: "succeeded",
      applyStatus: "applied",
      salary: "",
      compensationSummary: compensationSummary({
        postedAmount: 20,
        marketAmount: 20,
        confidenceBand: "high",
        confidenceScore: 0.9,
        warningCount: 2,
      }),
    };
    await replaceJobs(repository, [high, low]);

    for (const sort of JOB_SORT_FIELDS) {
      const result = await adapter.jobs({
        sort,
        dir: "asc",
        deleted: "all",
      });
      expect(
        result.items.map((job) => job.jobKey),
        sort,
      ).toEqual(["sort-low", "sort-high"]);
    }

    const tiedHighKey = { ...structuredClone(low), jobKey: "z-key" };
    const tiedLowKey = { ...structuredClone(low), jobKey: "a-key" };
    await replaceJobs(repository, [tiedHighKey, tiedLowKey]);
    expect(
      (
        await adapter.jobs({
          sort: "title",
          dir: "desc",
          deleted: "all",
        })
      ).items.map((job) => job.jobKey),
    ).toEqual(["a-key", "z-key"]);
  });

  it("matches production compensation state and confidence-band ordering", async () => {
    const { adapter, repository } = await createAdapter();
    const base = repository.snapshotNow().state.readModel.jobs.list.items[0]!;
    const job = (
      jobKey: string,
      summary: JobCompensationSummary | null,
      salary = "",
    ): JobSummary => ({
      ...structuredClone(base),
      jobKey,
      title: jobKey,
      salary,
      compensationSummary: summary,
    });

    await replaceJobs(repository, [
      job("posted-numeric", compensationSummary({ postedAmount: 10 })),
      job("posted-fallback", null, "salary supplied"),
      job(
        "posted-ambiguous",
        compensationSummary({ postedState: "ambiguous" }),
      ),
      job(
        "posted-unparseable",
        compensationSummary({ postedState: "unparseable" }),
      ),
      job("posted-missing", compensationSummary({ postedState: "missing" })),
      job("posted-none", null),
    ]);
    expect(
      (
        await adapter.jobs({
          sort: "compensation_posted",
          dir: "asc",
          deleted: "all",
        })
      ).items.map((item) => item.jobKey),
    ).toEqual([
      "posted-none",
      "posted-missing",
      "posted-unparseable",
      "posted-ambiguous",
      "posted-fallback",
      "posted-numeric",
    ]);

    await replaceJobs(repository, [
      job("market-numeric", compensationSummary({ marketAmount: 10 })),
      job(
        "market-estimated",
        compensationSummary({ marketState: "estimated_range" }),
      ),
      job(
        "market-insufficient",
        compensationSummary({ marketState: "insufficient_evidence" }),
      ),
      job(
        "market-unavailable",
        compensationSummary({ marketState: "source_unavailable" }),
      ),
      job(
        "market-unsupported",
        compensationSummary({ marketState: "unsupported" }),
      ),
      job(
        "market-none",
        compensationSummary({
          marketRecordStatus: "not_requested",
          marketState: "not_requested",
        }),
      ),
    ]);
    expect(
      (
        await adapter.jobs({
          sort: "compensation_market",
          dir: "asc",
          deleted: "all",
        })
      ).items.map((item) => item.jobKey),
    ).toEqual([
      "market-none",
      "market-unsupported",
      "market-unavailable",
      "market-insufficient",
      "market-estimated",
      "market-numeric",
    ]);

    await replaceJobs(repository, [
      job(
        "confidence-score",
        compensationSummary({ confidenceBand: "none", confidenceScore: 0.95 }),
      ),
      job("confidence-high", compensationSummary({ confidenceBand: "high" })),
      job(
        "confidence-medium",
        compensationSummary({ confidenceBand: "medium" }),
      ),
      job("confidence-low", compensationSummary({ confidenceBand: "low" })),
      job("confidence-none", compensationSummary({ confidenceBand: "none" })),
      job(
        "confidence-unrequested",
        compensationSummary({
          marketRecordStatus: "not_requested",
          marketState: "not_requested",
        }),
      ),
    ]);
    expect(
      (
        await adapter.jobs({
          sort: "compensation_confidence",
          dir: "asc",
          deleted: "all",
        })
      ).items.map((item) => item.jobKey),
    ).toEqual([
      "confidence-unrequested",
      "confidence-none",
      "confidence-low",
      "confidence-medium",
      "confidence-high",
      "confidence-score",
    ]);
  });

  it("matches activity, artifact, run, contact, and research query semantics", async () => {
    const { adapter } = await createAdapter();
    await expect(
      adapter.activity({ q: "score", level: "INFO", eventType: "jobscored" }),
    ).resolves.toMatchObject({
      pagination: { total: 1 },
      items: [{ eventId: "event-demo-score" }],
    });
    await expect(adapter.activity({ stage: "apply" })).resolves.toMatchObject({
      pagination: { page: 1, total: 0, pages: 1 },
      items: [],
    });

    const artifacts = await adapter.artifacts({
      q: "Platform systems lead",
      status: "accepted",
      type: "tailored_resume",
      sort: "type",
      dir: "asc",
      page: 2,
      pageSize: 1,
    });
    expect(artifacts.items.map((artifact) => artifact.artifactId)).toEqual([
      "artifact-tailored-resume-html",
    ]);
    expect(artifacts.pagination).toEqual({
      page: 1,
      pageSize: 1,
      total: 1,
      pages: 1,
    });

    const runs = await adapter.workflowRuns({
      status: "succeeded",
      sort: "started_at",
      dir: "asc",
      page: 2,
      pageSize: 1,
    });
    expect(runs.items.map((run) => run.runId)).toEqual(["run-discovery-demo"]);
    expect(runs.pagination).toEqual({
      page: 2,
      pageSize: 1,
      total: 3,
      pages: 3,
    });

    await expect(
      adapter.listContacts({
        jobId: "job-northwind-platform",
        employer: "Northwind Workshop",
      }),
    ).resolves.toMatchObject({
      items: [{ contactId: "contact-demo-hiring-partner" }],
    });
    await expect(
      adapter.listContacts({ employer: "northwind workshop" }),
    ).resolves.toEqual({ ok: true, items: [] });
    await expect(
      adapter.researchTasks({ jobId: "job-northwind-platform" }),
    ).resolves.toMatchObject({
      items: [{ taskId: "research-demo-hiring-partner" }],
    });
    await expect(
      adapter.researchTasks({ employer: "missing" }),
    ).resolves.toEqual({ ok: true, items: [] });
  });

  it("matches case-normalized activity text and contact/research ordering", async () => {
    const { adapter, repository } = await createAdapter();
    const baseEvent =
      repository.snapshotNow().state.readModel.dashboard.activity.items[0]!;
    const event = (eventId: string, value: string): ActivityEventSummary => ({
      ...structuredClone(baseEvent),
      eventId,
      stage: value,
      level: value,
      eventType: value,
      message: value,
    });
    await repository.mutate((draft) => {
      draft.state.readModel.dashboard.activity.items = [
        event("event-z", "Zulu"),
        event("event-a", "apple"),
      ];
    });
    for (const sort of ["stage", "level", "event_type", "message"] as const) {
      expect(
        (await adapter.activity({ sort, dir: "asc" })).items.map(
          (item) => item.eventId,
        ),
        sort,
      ).toEqual(["event-a", "event-z"]);
    }

    const snapshot = repository.snapshotNow();
    const baseContact = snapshot.state.readModel.contacts.list.items[0]!;
    const baseTask = snapshot.state.readModel.contacts.researchTasks.items[0]!;
    await repository.mutate((draft) => {
      draft.state.readModel.contacts.list.items = [
        {
          ...structuredClone(baseContact),
          contactId: "contact-z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
        {
          ...structuredClone(baseContact),
          contactId: "contact-a",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
        {
          ...structuredClone(baseContact),
          contactId: "contact-old",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      draft.state.readModel.contacts.researchTasks.items = [
        {
          ...structuredClone(baseTask),
          taskId: "task-z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
        {
          ...structuredClone(baseTask),
          taskId: "task-a",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
        {
          ...structuredClone(baseTask),
          taskId: "task-old",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
    });
    expect(
      (
        await adapter.listContacts({ employer: baseContact.employer ?? "" })
      ).items.map((contact) => contact.contactId),
    ).toEqual(["contact-a", "contact-z", "contact-old"]);
    expect(
      (
        await adapter.researchTasks({ employer: baseTask.employer ?? "" })
      ).items.map((task) => task.taskId),
    ).toEqual(["task-a", "task-z", "task-old"]);
  });

  it("resolves every seeded dynamic detail and returns stable 404 errors for unknown IDs", async () => {
    const { adapter } = await createAdapter();
    for (const jobKey of [
      "job-northwind-platform",
      "job-contoso-reliability",
      "job-fabrikam-systems",
    ]) {
      await expect(adapter.job(jobKey)).resolves.toMatchObject({
        ok: true,
        job: { jobKey },
      });
      await expect(
        adapter.jobApplicationOutcomes(jobKey),
      ).resolves.toMatchObject({ ok: true, jobKey });
    }
    for (const runId of [
      "run-materials-progress",
      "run-failed-quality-gate",
      "run-score-succeeded",
      "run-application-rehearsal",
      "run-discovery-cancelled",
      "run-discovery-demo",
    ]) {
      await expect(adapter.workflowRun(runId)).resolves.toMatchObject({
        runId,
      });
    }
    for (const artifactId of [
      "artifact-tailored-resume",
      "artifact-tailored-resume-html",
    ]) {
      await expect(adapter.artifact(artifactId)).resolves.toMatchObject({
        ok: true,
        artifact: { artifactId },
      });
      for (const url of [
        adapter.artifactPreviewPdfUrl(artifactId),
        adapter.artifactPreviewHtmlUrl(artifactId),
      ]) {
        expect(url).toMatch(/^\/demo\//);
        expect(url).not.toContain("://");
        expect(url).not.toContain("..");
      }
    }

    const missingReads = [
      () => adapter.activityEvent("missing"),
      () => adapter.discoverySourcePreview("missing"),
      () => adapter.resumeReviewDraft("missing"),
      () => adapter.resumeReviewFeedback("missing"),
      () => adapter.resumeTemplate("missing"),
      () => adapter.jobApplicationOutcomes("missing"),
      () => adapter.job("missing"),
      () => adapter.workflowRun("missing"),
      () => adapter.artifact("missing"),
      () => adapter.contact("missing"),
      () => adapter.researchTask("missing"),
      () => adapter.outreachThread("missing"),
    ];
    for (const read of missingReads) {
      await expect(read()).rejects.toBeInstanceOf(DemoResourceNotFoundError);
      await expect(read()).rejects.toMatchObject({ status: 404 });
    }
    expect(() => adapter.artifactPreviewPdfUrl("missing")).toThrow(
      DemoResourceNotFoundError,
    );
  });

  it("keeps the intentional capability error class stable", () => {
    expect(new DemoCapabilityError("applyJob")).toMatchObject({
      name: "DemoCapabilityError",
      code: "demo_capability_not_implemented",
    });
  });

  it("emits only closed action telemetry without affecting scenario results", async () => {
    const telemetry = new FakeTelemetryPort();
    const { adapter } = await createAdapter({ telemetry });

    await expect(adapter.rescoreJob("job-fabrikam-systems", {})).resolves.toMatchObject({
      status: "queued",
    });
    expect(telemetry.event).toHaveBeenNthCalledWith(1, "demo_action_started", {
      feature: "scoring",
      action: "rescore",
      scenario: "success",
    });
    expect(telemetry.event).toHaveBeenCalledTimes(1);

    telemetry.event.mockClear();
    await expect(adapter.retailorJob("job-fabrikam-systems", {})).resolves.toMatchObject({
      status: "blocked",
    });
    expect(telemetry.event).toHaveBeenNthCalledWith(2, "demo_action_failed", {
      feature: "materials",
      action: "retailor",
      scenario: "retry",
      result: "failed",
      errorCode: "validation_rejected",
      durationBucket: expect.stringMatching(/ms|s/),
    });
    adapter.dispose();
  });
});
