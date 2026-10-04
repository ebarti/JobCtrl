import { describe, expect, it, vi } from "vitest";

import {
  JOB_SORT_FIELDS,
  ProfileSchema,
  RequiredBulletSuggestionResponseSchema,
  type ActivityEventSummary,
  type ArtifactDetail,
  type JobCompensationSummary,
  type JobSummary,
} from "@jobctrl/contracts";

import coachingFixtures from "../../../../packages/domain-types/test/fixtures/required-bullet-suggestions.json" with { type: "json" };
import type { ApiClientPort } from "../shared/ports/ApiClientPort.js";
import { sampleProviderModelsResponse } from "../test/fixtures/projections.js";
import { makeQuestionPrep } from "../test/fixtures/interviews.js";
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
      benchmarkKind: null,
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
  ["interviewCatalog", (api: ApiClientPort) => api.interviewCatalog()],
  ["interviewQuestion", (api: ApiClientPort) => api.interviewQuestion("B11")],
  ["interviewPrepHistory", (api: ApiClientPort) => api.interviewPrepHistory("job-contoso-reliability")],
  ["interviewNotes", (api: ApiClientPort) => api.interviewNotes("job-contoso-reliability")],
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
    (api: ApiClientPort) =>
      api.resumeReviewDraft("6e2f4a10-20be-4d5f-98a4-a4bb9a877a35"),
  ],
  [
    "resumeReviewFeedback",
    (api: ApiClientPort) =>
      api.resumeReviewFeedback("6e2f4a10-20be-4d5f-98a4-a4bb9a877a35"),
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
      api.jobApplicationOutcomes("6e2f4a10-20be-4d5f-98a4-a4bb9a877a35"),
  ],
  ["jobs", (api: ApiClientPort) => api.jobs()],
  [
    "job",
    (api: ApiClientPort) =>
      api.job("6e2f4a10-20be-4d5f-98a4-a4bb9a877a35"),
  ],
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
  [
    "targetRoleSuggestions",
    (api: ApiClientPort) => api.targetRoleSuggestions({ expectedProfileVersion: 1, maximumSuggestions: 3 }),
  ],
  [
    "requiredBulletSuggestions",
    (api: ApiClientPort) => api.requiredBulletSuggestions({ expectedProfileVersion: 1, maximumSuggestions: 12 }),
  ],
  ["profilePreviewPdfUrl", (api: ApiClientPort) => api.profilePreviewPdfUrl(7)],
  [
    "profilePreviewHtmlUrl",
    (api: ApiClientPort) => api.profilePreviewHtmlUrl(7),
  ],
  ["settings", (api: ApiClientPort) => api.settings()],
  ["credentials", (api: ApiClientPort) => api.credentials()],
  ["providerModels", (api: ApiClientPort) => api.providerModels()],
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
  it("keeps the read-only synthetic model catalog aligned with the frontend contract fixture", async () => {
    const { adapter } = await createAdapter();
    const catalog = await adapter.providerModels();
    expect(catalog.providers.find((provider) => provider.provider === "claude")?.models).toEqual(
      sampleProviderModelsResponse.providers.find((provider) => provider.provider === "claude")?.models,
    );
  });

  it("labels synthetic target-role suggestions and rejects stale profile versions", async () => {
    const { adapter } = await createAdapter();

    await expect(
      adapter.targetRoleSuggestions({ expectedProfileVersion: 1, maximumSuggestions: 1 }),
    ).resolves.toMatchObject({
      profileVersion: 1,
      strategy: "model_stub",
      warnings: ["stubbed_model_evidence"],
      suggestions: [{ evidenceIds: ["experience:experience-platform-delivery"] }],
    });
    await expect(
      adapter.targetRoleSuggestions({ expectedProfileVersion: 2, maximumSuggestions: 1 }),
    ).rejects.toMatchObject({ status: 409, statusText: "stale_profile_version" });
  });

  it.each(coachingFixtures)("conforms to the shared coaching fixture: $name", async (fixture) => {
    const { adapter, repository } = await createAdapter();
    await repository.mutate((draft) => {
      draft.state.readModel.profile.config.profile = ProfileSchema.parse(fixture.profile);
      draft.state.readModel.profile.config.profileVersion = fixture.profileVersion;
    });
    const before = repository.snapshotNow();
    const inspected = await adapter.requiredBulletSuggestions({
      expectedProfileVersion: fixture.profileVersion,
      maximumSuggestions: fixture.maximumSuggestions,
    });
    expect(inspected).toEqual(fixture.expected);
    expect(RequiredBulletSuggestionResponseSchema.parse(inspected)).toEqual(fixture.expected);
    // Read-only means no profile, revision, event, pending action or blob writes.
    expect(repository.snapshotNow()).toEqual(before);
    expect(await adapter.requiredBulletSuggestions({
      expectedProfileVersion: fixture.profileVersion,
      maximumSuggestions: fixture.maximumSuggestions,
    })).toEqual(fixture.expected);
    await expect(adapter.requiredBulletSuggestions({
      expectedProfileVersion: fixture.profileVersion + 1,
      maximumSuggestions: fixture.maximumSuggestions,
    })).rejects.toMatchObject({ status: 409, statusText: "stale_profile_version" });
    expect(repository.snapshotNow()).toEqual(before);
  });

  it("rejects invalid saved synthetic evidence without a workspace write", async () => {
    const { adapter, repository } = await createAdapter();
    await repository.mutate((draft) => {
      draft.state.readModel.profile.config.profile = {
        resume: { experience_entries: [{
          id: "invalid-evidence", title: "Synthetic Engineer", company: "Synthetic Co",
          achievement_evidence: [{ user_confirmed: "yes", claim_confidence: 2 }],
        }] },
      };
    });
    const before = repository.snapshotNow();
    await expect(adapter.requiredBulletSuggestions({
      expectedProfileVersion: before.state.readModel.profile.config.profileVersion!,
      maximumSuggestions: 12,
    })).rejects.toMatchObject({ status: 422, statusText: "invalid_saved_profile" });
    expect(repository.snapshotNow()).toEqual(before);
  });

  it("inspects saved synthetic Required bullets without changing the demo profile", async () => {
    const { adapter } = await createAdapter();
    const before = await adapter.profile();
    const profile = ProfileSchema.parse(before.profile);
    const entry = profile.resume.experience_entries[0]!;
    entry.bullets[0] = "  Worked   on platform delivery.  ";
    profile.resume.tailoring_rules.required_bullets_by_experience_id = {
      ...profile.resume.tailoring_rules.required_bullets_by_experience_id,
      [entry.id]: [entry.bullets[0]],
    };
    const saved = await adapter.updateProfile({
      expectedProfileVersion: before.profileVersion!,
      profileText: JSON.stringify(profile),
    });
    const snapshot = await adapter.profile();
    expect(snapshot).toEqual(saved);

    const inspected = await adapter.requiredBulletSuggestions({
      expectedProfileVersion: saved.profileVersion!,
      maximumSuggestions: 12,
    });
    expect(inspected).toMatchObject({
      profileVersion: saved.profileVersion,
      strategy: "deterministic_rules_v1",
      modelUsed: false,
    });
    expect(inspected.suggestions[0]).toMatchObject({
      kind: "grammar",
      originalText: "  Worked   on platform delivery.  ",
      proposedText: "Worked on platform delivery.",
      canApply: true,
      source: { experienceId: entry.id, fieldPath: "profile.resume.experience_entries[0].bullets[0]" },
    });
    expect(inspected.suggestions.map((suggestion) => suggestion.kind)).toEqual([
      "grammar", "relevance", "achievement_framing", "missing_evidence",
    ]);
    expect(inspected.suggestions.filter((suggestion) => suggestion.kind !== "grammar")
      .every((suggestion) => suggestion.proposedText === null && !suggestion.canApply)).toBe(true);
    const bounded = await adapter.requiredBulletSuggestions({
      expectedProfileVersion: saved.profileVersion!,
      maximumSuggestions: 1,
    });
    expect(bounded.suggestions).toHaveLength(1);
    expect(bounded.truncated).toBe(true);
    expect(await adapter.profile()).toEqual(snapshot);
    await expect(adapter.requiredBulletSuggestions({
      expectedProfileVersion: saved.profileVersion! - 1,
      maximumSuggestions: 12,
    })).rejects.toMatchObject({ status: 409, statusText: "stale_profile_version" });

    entry.bullets[1] = "Worked on platform delivery.";
    const withCollision = await adapter.updateProfile({
      expectedProfileVersion: saved.profileVersion!,
      profileText: JSON.stringify(profile),
    });
    const colliding = await adapter.requiredBulletSuggestions({
      expectedProfileVersion: withCollision.profileVersion!,
      maximumSuggestions: 12,
    });
    expect(colliding.suggestions.find((suggestion) => suggestion.kind === "grammar"))
      .toMatchObject({ canApply: false, proposedText: null });

    profile.resume.tailoring_rules.required_bullets_by_experience_id = {
      [entry.id]: [`Unmatched Required claim ${"x".repeat(2_000)}`],
    };
    const withOverlongPin = await adapter.updateProfile({
      expectedProfileVersion: withCollision.profileVersion!,
      profileText: JSON.stringify(profile),
    });
    const incomplete = await adapter.requiredBulletSuggestions({
      expectedProfileVersion: withOverlongPin.profileVersion!,
      maximumSuggestions: 12,
    });
    expect(incomplete).toMatchObject({ suggestions: [], truncated: true, modelUsed: false });

    profile.resume.tailoring_rules.required_bullets_by_experience_id = {
      deleted_role: [`Orphan Required claim ${"x".repeat(2_000)}`],
    };
    const withDeletedRolePin = await adapter.updateProfile({
      expectedProfileVersion: withOverlongPin.profileVersion!,
      profileText: JSON.stringify(profile),
    });
    expect(await adapter.requiredBulletSuggestions({
      expectedProfileVersion: withDeletedRolePin.profileVersion!,
      maximumSuggestions: 12,
    })).toMatchObject({ suggestions: [], truncated: true, modelUsed: false });
  });

  it("keeps grammar-only restatements as questions in saved demo evidence", async () => {
    const { adapter } = await createAdapter();
    const before = await adapter.profile();
    const profile = ProfileSchema.parse(before.profile);
    const entry = profile.resume.experience_entries[0]!;
    entry.bullets = ["Reduced process latency."];
    entry.achievement_evidence = [{
      id: "demo-possessive-restatement",
      source_text: entry.bullets[0]!,
      scope: "Synthetic team",
      action: "Reduced process latency",
      tools: [],
      metrics: [],
      outcome: "Reduced processes' latency in this role.",
      seniority_signal: "",
      evidence_strength: "supported",
      claim_confidence: 0.8,
      user_confirmed: true,
      tags: [],
    }];
    profile.resume.tailoring_rules.required_bullets_by_experience_id = {
      [entry.id]: [entry.bullets[0]!],
    };
    const saved = await adapter.updateProfile({
      expectedProfileVersion: before.profileVersion!,
      profileText: JSON.stringify(profile),
    });
    const inspected = await adapter.requiredBulletSuggestions({
      expectedProfileVersion: saved.profileVersion!,
      maximumSuggestions: 12,
    });
    expect(inspected.suggestions.filter((suggestion) =>
      suggestion.source.sourceId === "demo-possessive-restatement",
    ).map((suggestion) => suggestion.kind)).toEqual(["achievement_framing", "missing_evidence"]);
    expect(await adapter.profile()).toEqual(saved);

    entry.achievement_evidence[0]!.outcome = "Improved reliability across the platform.";
    const withNewWords = await adapter.updateProfile({
      expectedProfileVersion: saved.profileVersion!,
      profileText: JSON.stringify(profile),
    });
    const inspectedNewWords = await adapter.requiredBulletSuggestions({
      expectedProfileVersion: withNewWords.profileVersion!,
      maximumSuggestions: 12,
    });
    expect(inspectedNewWords.suggestions.filter((suggestion) =>
      suggestion.source.sourceId === "demo-possessive-restatement",
    ).map((suggestion) => suggestion.kind)).toEqual(["missing_evidence"]);
  });

  it("keeps result framing for a contextual restatement in the saved demo profile", async () => {
    const { adapter } = await createAdapter();
    const before = await adapter.profile();
    const profile = ProfileSchema.parse(before.profile);
    const entry = profile.resume.experience_entries[0]!;
    entry.bullets = ["Reduced API latency."];
    entry.achievement_evidence = [{
      id: "demo-context-only-outcome",
      source_text: entry.bullets[0]!,
      scope: "Synthetic team",
      action: "Reduced API latency",
      tools: [],
      metrics: [],
      outcome: "Reduced API latency during planning.",
      seniority_signal: "",
      evidence_strength: "verified",
      claim_confidence: 1,
      user_confirmed: true,
      tags: [],
    }];
    profile.resume.tailoring_rules.required_bullets_by_experience_id = {
      [entry.id]: [entry.bullets[0]!],
    };
    const saved = await adapter.updateProfile({
      expectedProfileVersion: before.profileVersion!, profileText: JSON.stringify(profile),
    });
    const inspected = await adapter.requiredBulletSuggestions({
      expectedProfileVersion: saved.profileVersion!, maximumSuggestions: 12,
    });
    expect(inspected.suggestions.filter((suggestion) =>
      suggestion.source.sourceId === "demo-context-only-outcome",
    ).map((suggestion) => suggestion.kind)).toEqual(["achievement_framing"]);
    expect(await adapter.profile()).toEqual(saved);

    entry.achievement_evidence[0]!.outcome = "Reduced API latency by 35%.";
    const withMeasure = await adapter.updateProfile({
      expectedProfileVersion: saved.profileVersion!, profileText: JSON.stringify(profile),
    });
    expect((await adapter.requiredBulletSuggestions({
      expectedProfileVersion: withMeasure.profileVersion!, maximumSuggestions: 12,
    })).suggestions.filter((suggestion) =>
      suggestion.source.sourceId === "demo-context-only-outcome",
    )).toEqual([]);
  });

  it("keeps framing advice for a verified action count in the saved demo profile", async () => {
    const { adapter } = await createAdapter();
    const before = await adapter.profile();
    const profile = ProfileSchema.parse(before.profile);
    const entry = profile.resume.experience_entries[0]!;
    entry.bullets = ["Improved 10 dashboards."];
    entry.achievement_evidence = [{
      id: "demo-verified-action-count",
      source_text: entry.bullets[0]!,
      scope: "Synthetic team",
      action: "Improved dashboards",
      tools: [],
      metrics: ["10 dashboards"],
      outcome: "",
      seniority_signal: "",
      evidence_strength: "verified",
      claim_confidence: 1,
      user_confirmed: true,
      tags: [],
    }];
    profile.resume.tailoring_rules.required_bullets_by_experience_id = {
      [entry.id]: [entry.bullets[0]!],
    };
    const saved = await adapter.updateProfile({
      expectedProfileVersion: before.profileVersion!, profileText: JSON.stringify(profile),
    });
    const inspected = await adapter.requiredBulletSuggestions({
      expectedProfileVersion: saved.profileVersion!, maximumSuggestions: 12,
    });
    expect(inspected.suggestions.filter((suggestion) =>
      suggestion.source.sourceId === "demo-verified-action-count",
    ).map((suggestion) => suggestion.kind)).toEqual(["achievement_framing"]);
    expect(await adapter.profile()).toEqual(saved);

    entry.achievement_evidence[0]!.outcome = "Improved 10 dashboards for teams.";
    const contextualAction = await adapter.updateProfile({
      expectedProfileVersion: saved.profileVersion!, profileText: JSON.stringify(profile),
    });
    expect((await adapter.requiredBulletSuggestions({
      expectedProfileVersion: contextualAction.profileVersion!, maximumSuggestions: 12,
    })).suggestions.filter((suggestion) =>
      suggestion.source.sourceId === "demo-verified-action-count",
    ).map((suggestion) => suggestion.kind)).toEqual(["achievement_framing"]);
    entry.achievement_evidence[0]!.outcome = "";

    entry.achievement_evidence[0]!.metrics = ["35% latency reduction"];
    const withMeasuredResult = await adapter.updateProfile({
      expectedProfileVersion: contextualAction.profileVersion!, profileText: JSON.stringify(profile),
    });
    const measured = await adapter.requiredBulletSuggestions({
      expectedProfileVersion: withMeasuredResult.profileVersion!, maximumSuggestions: 12,
    });
    expect(measured.suggestions.filter((suggestion) =>
      suggestion.source.sourceId === "demo-verified-action-count",
    )).toEqual([]);
  });

  it("recognizes a verified, confirmed deployment-time result in the saved demo profile", async () => {
    const { adapter } = await createAdapter();
    const before = await adapter.profile();
    const profile = ProfileSchema.parse(before.profile);
    const entry = profile.resume.experience_entries[0]!;
    const bullet = "Reduced synthetic deployment time by 40%.";
    entry.bullets = [bullet];
    entry.achievement_evidence = [{
      id: "demo-verified-deployment-time",
      source_text: bullet,
      scope: "Synthetic deployment",
      action: "Reduced synthetic deployment time",
      tools: [],
      metrics: ["40%"],
      outcome: bullet,
      seniority_signal: "",
      evidence_strength: "verified",
      claim_confidence: 1,
      user_confirmed: true,
      tags: [],
    }];
    profile.resume.tailoring_rules.required_bullets_by_experience_id = { [entry.id]: [bullet] };
    const saved = await adapter.updateProfile({
      expectedProfileVersion: before.profileVersion!, profileText: JSON.stringify(profile),
    });

    expect((await adapter.requiredBulletSuggestions({
      expectedProfileVersion: saved.profileVersion!, maximumSuggestions: 12,
    })).suggestions.filter((suggestion) =>
      suggestion.source.sourceId === "demo-verified-deployment-time",
    )).toEqual([]);
    expect(await adapter.profile()).toEqual(saved);
  });

  it.each(["constructor", "toString", "__proto__"])(
    "treats %s as own synthetic experience-ID data during inspection",
    async (experienceId) => {
      const { adapter } = await createAdapter();
      const before = await adapter.profile();
      const profile = ProfileSchema.parse(before.profile);
      const entry = profile.resume.experience_entries[0]!;
      entry.id = experienceId;
      entry.bullets = ["  Special   Required claim  "];
      const pins = Object.create(null) as Record<string, string[]>;
      profile.resume.tailoring_rules.required_bullets_by_experience_id = pins;
      const saved = await adapter.updateProfile({
        expectedProfileVersion: before.profileVersion!, profileText: JSON.stringify(profile),
      });
      const withoutPin = await adapter.requiredBulletSuggestions({
        expectedProfileVersion: saved.profileVersion!, maximumSuggestions: 12,
      });
      expect(withoutPin.suggestions.some((suggestion) =>
        suggestion.source.experienceId === experienceId)).toBe(false);

      pins[experienceId] = [entry.bullets[0]!];
      const withPin = await adapter.updateProfile({
        expectedProfileVersion: saved.profileVersion!, profileText: JSON.stringify(profile),
      });
      const inspected = await adapter.requiredBulletSuggestions({
        expectedProfileVersion: withPin.profileVersion!, maximumSuggestions: 12,
      });
      expect(inspected.suggestions).toContainEqual(expect.objectContaining({
        kind: "grammar", canApply: experienceId !== "__proto__",
        source: expect.objectContaining({ experienceId, bulletIndex: 0 }),
      }));
      const stored = ProfileSchema.parse((await adapter.profile()).profile);
      expect(Object.hasOwn(stored.resume.tailoring_rules.required_bullets_by_experience_id!, experienceId))
        .toBe(true);
    },
  );

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
      draft.state.readModel.jobs.details[
        "6e2f4a10-20be-4d5f-98a4-a4bb9a877a35"
      ]!.job.title = "authoritative update";
    });
    expect(
      (
        await adapter.job("6e2f4a10-20be-4d5f-98a4-a4bb9a877a35")
      ).job.title,
    ).toBe("authoritative update");
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

  it("matches production job-state precedence, OR filtering, and pagination", async () => {
    const { adapter, repository } = await createAdapter();
    const base = repository.snapshotNow().state.readModel.jobs.list.items[0]!;
    await replaceJobs(repository, [
      {
        ...structuredClone(base),
        jobKey: "state-active",
        title: "Active job",
        deletedAt: null,
        hiddenAt: null,
      },
      {
        ...structuredClone(base),
        jobKey: "state-deleted",
        title: "Deleted job",
        deletedAt: "2026-07-10T09:00:00.000Z",
        hiddenAt: null,
      },
      {
        ...structuredClone(base),
        jobKey: "state-hidden",
        title: "Hidden job",
        deletedAt: "2026-07-10T09:00:00.000Z",
        hiddenAt: "2026-07-11T09:00:00.000Z",
      },
      {
        ...structuredClone(base),
        jobKey: "state-closed",
        title: "Closed job",
        activeState: "expired",
        deletedAt: null,
        hiddenAt: null,
      },
    ]);

    await expect(
      adapter.jobs({ deleted: "active", jobStates: ["deleted"] }),
    ).resolves.toMatchObject({
      items: [{ jobKey: "state-deleted" }],
      pagination: { total: 1, pages: 1 },
      filter: { jobStates: ["deleted"] },
    });
    const mixed = await adapter.jobs({
      jobStates: ["active", "hidden"],
      sort: "title",
      dir: "asc",
      page: 1,
      pageSize: 1,
    });
    expect(mixed.items.map((job) => job.jobKey)).toEqual(["state-active"]);
    expect(mixed.pagination).toEqual({
      page: 1,
      pageSize: 1,
      total: 2,
      pages: 2,
    });
    await expect(
      adapter.jobs({ deleted: "closed", jobStates: ["active"] }),
    ).resolves.toMatchObject({
      items: [{ jobKey: "state-active" }],
      pagination: { total: 1 },
    });
    await expect(adapter.jobs({ deleted: "closed" })).resolves.toMatchObject({
      items: [{ jobKey: "state-closed" }],
      pagination: { total: 1 },
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
      pagination: { page: 1, total: 1, pages: 1 },
      items: [{ workflowId: "run-application-rehearsal" }],
    });

    const visibleRuns = await adapter.workflowRuns();
    for (const run of visibleRuns.items) {
      await expect(
        adapter.activity({ q: run.workflowId }),
      ).resolves.toMatchObject({
        pagination: { total: 1 },
        items: [{ workflowId: run.workflowId }],
      });
    }

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

    const filteredRuns = await adapter.workflowRuns({
      workflowType: "JobPipelineWorkflow",
      startedSince: "2026-07-11T08:00:00.000Z",
      startedBefore: "2026-07-11T08:30:00.000Z",
      sort: "started_at",
      dir: "asc",
      page: 2,
      pageSize: 1,
    });
    expect(filteredRuns.items.map((run) => run.runId)).toEqual([
      "run-failed-quality-gate",
    ]);
    expect(filteredRuns.pagination).toEqual({
      page: 2,
      pageSize: 1,
      total: 3,
      pages: 3,
    });
    expect(filteredRuns.filter).toEqual({
      status: "all",
      workflowType: "JobPipelineWorkflow",
      startedSince: "2026-07-11T08:00:00.000Z",
      startedBefore: "2026-07-11T08:30:00.000Z",
    });

    await expect(
      adapter.listContacts({
        jobId: "6e2f4a10-20be-4d5f-98a4-a4bb9a877a35",
        employer: "Northwind Workshop",
      }),
    ).resolves.toMatchObject({
      items: [{ contactId: "contact-demo-hiring-partner" }],
    });
    await expect(
      adapter.listContacts({ employer: "northwind workshop" }),
    ).resolves.toEqual({ ok: true, items: [] });
    await expect(
      adapter.researchTasks({
        jobId: "6e2f4a10-20be-4d5f-98a4-a4bb9a877a35",
      }),
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
      "6e2f4a10-20be-4d5f-98a4-a4bb9a877a35",
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


describe("interview demo contract", () => {
  it("derives note origins, rejects forged bindings and detaches missing retained origins without rewriting history", async () => {
    const { adapter, repository } = await createAdapter();
    const jobId = "job-contoso-reliability";
    const prep = makeQuestionPrep("B11", jobId);
    await repository.mutate((draft) => { draft.state.readModel.jobs.details[jobId]!.interviewPrep = prep; });
    await expect(adapter.saveInterviewNote(jobId, { questionId: "TS09", expectedRevision: 0, noteText: "Invalid origin", sourceGeneration: prep.generation })).rejects.toMatchObject({ status: 400, message: "invalid_interview_note_source" });
    await expect(adapter.saveInterviewNote(jobId, { questionId: "B11", expectedRevision: 0, noteText: "Forged context", sourceGeneration: prep.generation, bindings: { catalogBinding: null, cardRevision: null, cardDigest: null, contextDigest: "a".repeat(64) } })).rejects.toMatchObject({ status: 400, message: "invalid_interview_note_bindings" });
    const saved = await adapter.saveInterviewNote(jobId, { questionId: "B11", expectedRevision: 0, noteText: "Retained note", sourceGeneration: prep.generation });
    expect(saved.note).toMatchObject({ sourceGeneration: prep.generation, bindings: { catalogBinding: prep.generationContext!.catalogBinding, contextDigest: prep.generationContext!.contextDigest } });
    await repository.mutate((draft) => { draft.state.readModel.jobs.details[jobId]!.interviewPrep = null; });
    const orphan = await adapter.saveInterviewNote(jobId, { questionId: "B11", expectedRevision: 1, noteText: "Retained independent edit" });
    expect(orphan.note).toMatchObject({ sourceGeneration: null, bindings: { contextDigest: null }, revision: 2 });
    const history = await adapter.interviewNotes(jobId, { questionId: "B11", history: true });
    expect(history.notes.find((note) => note.revision === 1)?.sourceGeneration).toBe(prep.generation);
  });

  it("shares all 121 questions with principle, negotiation and retired semantics", async () => {
    const { adapter } = await createAdapter();
    const response = await adapter.interviewCatalog();
    expect(response.total).toBe(121);
    expect((await adapter.interviewQuestion("B11")).question.defaultAnswerFormat).toBe("principle");
    expect((await adapter.interviewQuestion("TS09")).question.defaultAnswerFormat).toBe("principle");
    expect((await adapter.interviewQuestion("C07")).question.answer).toMatch(/range/i);
    await expect(adapter.interviewQuestion("C08")).rejects.toMatchObject({ status: 410 });
  });

  it("keeps independent notes, CAS conflicts, history and safe events inside the workspace", async () => {
    const { adapter, repository } = await createAdapter();
    const before = await adapter.profile();
    const saved = await adapter.saveInterviewNote("job-contoso-reliability", { questionId: "B11", expectedRevision: 0, noteText: "Synthetic unverified recollection" });
    expect(saved.note).toMatchObject({ revision: 1, factualSupport: "unverified_user_statement", editStatus: "user_edited" });
    await expect(adapter.saveInterviewNote("job-contoso-reliability", { questionId: "B11", expectedRevision: 0, noteText: "stale text" })).rejects.toMatchObject({ status: 409 });
    await adapter.saveInterviewNote("job-contoso-reliability", { questionId: "B11", expectedRevision: 1, noteText: "Newer synthetic note" });
    expect((await adapter.interviewNotes("job-contoso-reliability", { questionId: "B11", history: true })).notes).toHaveLength(2);
    expect((await adapter.interviewNotes("job-contoso-reliability", { questionId: "B11" })).notes[0]?.noteText).toBe("Newer synthetic note");
    expect((await adapter.interviewNotes("job-contoso-reliability", { questionId: "TS09" })).notes).toHaveLength(0);
    expect(await adapter.profile()).toEqual(before);
    const snapshot = await repository.snapshot();
    expect(JSON.stringify(snapshot.eventLog)).not.toContain("Synthetic unverified recollection");
  });
});
