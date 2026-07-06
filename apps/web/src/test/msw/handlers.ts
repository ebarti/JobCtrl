import type {
  ContactAttributeDto,
  ContactCreateRequest,
  ContactUpdateRequest,
} from "@jobhunter/contracts";
import { http, HttpResponse } from "msw";

import {
  makeContactDetail,
  makeContactDetailResponse,
  makeContactListResponse,
  makeContactMutationResponse,
  makeContactProvenance,
  sampleContactDetail,
  sampleContactSummary,
  sampleSecondaryContactSummary,
} from "../fixtures/contacts.js";
import {
  makeConfirmCandidateResponse,
  makeResearchDetailResponse,
  makeResearchListResponse,
  sampleResearchTaskSummary,
} from "../fixtures/contact-research.js";
import {
  makeDueFollowUpSummary,
  makeOutreachFollowUp,
  makeOutreachSendLog,
  makeOutreachThreadDetail,
  makeOutreachThreadResponse,
} from "../fixtures/outreach.js";
import {
  makeArtifactDetail,
  makeArtifactTailoringExplanation,
  makeActivityPage,
  sampleApplicationOutcomes,
  sampleApplyReviewQueue,
  sampleAcceptedResumeArtifact,
  sampleDraftResumeArtifact,
  makeCoverageAudit,
  makeArtifactsPage,
  makeJobDetail,
  makeJobsPage,
  makeWorkflowRunsPage,
  makeWorkflowRunDetail,
  sampleCredentialsResponse,
  sampleDailyDigest,
  sampleDashboardSummary,
  sampleDiscoverySettingsResponse,
  sampleExtensionCapabilityTokenResponse,
  sampleEvidenceMapResponse,
  sampleHealthResponse,
  sampleOutcomeAnalyticsSummary,
  sampleProfileResponse,
  sampleResumeTemplateListResponse,
  sampleSettingsResponse,
} from "../fixtures/projections.js";

function actionRunResponse(jobKey: string, action: string) {
  return {
    ok: true,
    runId: `run-${jobKey}-${Date.now()}`,
    actionId: `action-${jobKey}-${Date.now()}`,
    action,
    status: "queued",
    jobKey,
    command: { action, jobKey },
  };
}

function jobMutationResponse(jobKeys: string[]) {
  return { ok: true, count: jobKeys.length, jobKeys };
}

const sampleDiscoverySource = {
  sourceId: "greenhouse-example",
  kind: "ats_api",
  displayName: "Greenhouse Example",
  owner: "user",
  priority: "canonical",
  state: "experimental",
  policyId: "local:greenhouse-example",
  recommendedState: "normal",
  lastRunId: "run-source-1",
  lastRunCompletedAt: "2026-05-12T10:00:00+00:00",
  lastErrorClass: null,
  consecutiveFailures: 0,
  observedJobs: 12,
  newJobs: 5,
  duplicateRate: 0.08,
  activeVerificationRate: 0.75,
  fullDescriptionSuccessRate: 0.92,
  applyUrlSuccessRate: 0.83,
  politeness: {
    robotsDisallowedCount: 0,
    rateLimitedCount: 0,
    budgetExhaustedCount: 0,
    lastBlockedReason: null,
    lastBlockedAt: null,
  },
  qualityTrend: "flat",
};

const sampleCompensationSourcePolicy = {
  ok: true,
  sources: [
    {
      sourceId: "manual_reported_compensation",
      displayName: "Manual reported compensation import",
      sourceType: "reported_compensation",
      accessMode: "manual_import",
      availability: "available",
      licenseStatus: "not_required",
      termsUrl: null,
      sourceUrl: null,
      freshnessPolicy: "Uses the reported year/snapshot supplied in the local JSON import.",
      attributionRequirement: "Show as a manual reported-compensation import.",
      supportedFields: ["base_salary", "total_compensation", "sample_count", "freshness", "attribution"],
      disabledReason: null,
      configured: true,
      coverage: {
        geography: "import_file",
        regions: ["Europe"],
        notes: "Coverage follows imported rows.",
      },
      notes: ["Explicit local imports are additive with configured licensed sources and Euro Top Tech refresh data."],
    },
    {
      sourceId: "euro_top_tech",
      displayName: "Euro Top Tech",
      sourceType: "reported_compensation",
      accessMode: "public_dataset",
      availability: "available",
      licenseStatus: "not_required",
      termsUrl: "https://www.eurotoptech.com/terms",
      sourceUrl: "https://www.eurotoptech.com/data",
      freshnessPolicy: "Uses approved public data-entry rows exposed by Euro Top Tech at refresh time.",
      attributionRequirement: "Show attribution to Euro Top Tech when its observations contribute to an estimate.",
      supportedFields: ["total_compensation", "sample_count", "freshness", "attribution"],
      disabledReason: null,
      configured: true,
      coverage: {
        geography: "public_dataset",
        regions: ["Europe"],
        notes: "Coverage follows Euro Top Tech submitted European data-entry rows.",
      },
      notes: ["Public crowdsourced software-engineer compensation rows are imported during compensation refresh."],
    },
    {
      sourceId: "levels_fyi",
      displayName: "Levels.fyi",
      sourceType: "reported_compensation",
      accessMode: "unavailable_until_permitted",
      availability: "unavailable",
      licenseStatus: "requires_license",
      termsUrl: "https://www.levels.fyi/offerings/data/",
      sourceUrl: "https://www.levels.fyi/",
      freshnessPolicy: "Unavailable until permitted access and Europe coverage are explicitly configured.",
      attributionRequirement: "Do not display imported Levels.fyi compensation data.",
      supportedFields: [],
      disabledReason: "Requires licensed Levels.fyi access mode and explicit Europe coverage confirmation.",
      configured: false,
      coverage: {
        geography: "licensed_provider_configured",
        regions: [],
        notes: "Europe coverage is not configured.",
      },
      notes: ["Refresh automatically loads configured licensed rows from JOBHUNTER_LEVELS_FYI_OBSERVATIONS_PATH or JOBHUNTER_LEVELS_FYI_OBSERVATIONS_URL when access is permitted."],
    },
    {
      sourceId: "glassdoor",
      displayName: "Glassdoor",
      sourceType: "reported_compensation",
      accessMode: "unavailable_until_permitted",
      availability: "unavailable",
      licenseStatus: "requires_permission",
      termsUrl: "https://www.glassdoor.com/about/terms/",
      sourceUrl: "https://www.glassdoor.com/",
      freshnessPolicy: "Unavailable until partner API or written permission is configured.",
      attributionRequirement: "Do not display imported Glassdoor compensation data.",
      supportedFields: [],
      disabledReason: "Requires Glassdoor partner API access or written permission.",
      configured: false,
      coverage: {
        geography: "licensed_provider_configured",
        regions: [],
        notes: "Coverage is not configured.",
      },
      notes: ["Refresh automatically loads configured permitted rows from JOBHUNTER_GLASSDOOR_OBSERVATIONS_PATH or JOBHUNTER_GLASSDOOR_OBSERVATIONS_URL when access is permitted."],
    },
  ],
};

function makeStoryArtifactDetail(artifactId: string) {
  if (artifactId === sampleAcceptedResumeArtifact.artifactId) {
    return makeArtifactDetail(
      sampleAcceptedResumeArtifact,
      makeArtifactTailoringExplanation(
        makeCoverageAudit({
          covered: ["platform reliability", "typescript"],
          declared: ["terraform", "gcp"],
          missing: ["incident response", "kubernetes"],
        }),
      ),
    );
  }
  if (artifactId === sampleDraftResumeArtifact.artifactId) {
    return makeArtifactDetail(
      sampleDraftResumeArtifact,
      makeArtifactTailoringExplanation(
        makeCoverageAudit({
          covered: ["platform reliability", "incident response", "terraform"],
          declared: ["kubernetes", "gcp"],
          missing: ["typescript"],
        }),
        {
          quality: {
            passed: true,
            errors: [],
            warnings: ["Residual wording warning recorded on the rendered draft."],
            notes: [],
            metricClaims: [],
            repeatedKeywords: [],
          },
        },
      ),
    );
  }
  return makeArtifactDetail({
    ...makeArtifactsPage().items[0]!,
    artifactId,
  });
}

export const handlers = [
  http.get("*/v1/health", () => HttpResponse.json(sampleHealthResponse)),
  http.get("*/v1/dashboard/summary", () => HttpResponse.json(sampleDashboardSummary)),
  http.get("*/v1/analytics/outcomes", () => HttpResponse.json(sampleOutcomeAnalyticsSummary)),
  http.get("*/v1/digest", () => HttpResponse.json(sampleDailyDigest)),
  http.post("*/v1/digest/acknowledge", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { acknowledgedAt?: string };
    return HttpResponse.json({
      ok: true,
      state: {
        lastAcknowledgedAt: body.acknowledgedAt ?? sampleDailyDigest.generatedAt,
        updatedAt: sampleDailyDigest.generatedAt,
      },
    });
  }),
  http.get("*/v1/evidence-map", () => HttpResponse.json(sampleEvidenceMapResponse)),
  http.get("*/v1/debug/activity", () =>
    HttpResponse.json(makeActivityPage(sampleDashboardSummary.activity)),
  ),
  http.get("*/v1/debug/activity/:eventId", ({ params }) => {
    const event =
      sampleDashboardSummary.activity.find((entry) => entry.eventId === String(params["eventId"])) ?? null;
    return event
      ? HttpResponse.json({ ok: true, event })
      : HttpResponse.json({ ok: false, error: "activity_event_not_found" }, { status: 404 });
  }),
  http.get("*/v1/discovery/sources", () =>
    HttpResponse.json({ ok: true, sources: [sampleDiscoverySource] }),
  ),
  http.get("*/v1/discovery/settings", () => HttpResponse.json(sampleDiscoverySettingsResponse)),
  http.get("*/v1/compensation/sources", () => HttpResponse.json(sampleCompensationSourcePolicy)),
  http.patch("*/v1/discovery/settings", async ({ request }) => {
    const body = (await request.json()) as Partial<typeof sampleDiscoverySettingsResponse.settings>;
    return HttpResponse.json({
      ok: true,
      settings: { ...sampleDiscoverySettingsResponse.settings, ...body },
    });
  }),
  http.post("*/v1/discovery/sources", async ({ request }) => {
    const body = (await request.json()) as { sourceId: string; displayName: string; kind: string };
    return HttpResponse.json({
      ok: true,
      source: {
        ...sampleDiscoverySource,
        sourceId: body.sourceId,
        displayName: body.displayName,
        kind: body.kind,
      },
    });
  }),
  http.patch("*/v1/discovery/sources/:sourceId/state", async ({ params, request }) => {
    const body = (await request.json()) as { state: string };
    return HttpResponse.json({
      ok: true,
      source: { ...sampleDiscoverySource, sourceId: String(params["sourceId"]), state: body.state },
    });
  }),
  http.get("*/v1/discovery/sources/:sourceId/preview", ({ params }) =>
    HttpResponse.json({
      ok: true,
      sourceId: String(params["sourceId"]),
      leads: [
        {
          candidateUrl: "https://example.com/jobs/preview",
          title: "Product Engineer",
          company: "ExampleCo",
          location: "Remote",
          estimatedConfidence: 0.91,
        },
      ],
      generatedAt: "2026-05-12T10:00:00+00:00",
    }),
  ),
  http.get("*/v1/discovery/locator-candidates", () =>
    HttpResponse.json({
      ok: true,
      candidates: [
        {
          candidateId: "candidate-1",
          candidateUrl: "https://example.com/careers",
          sourceKind: "employer_careers_page",
          confidence: 0.86,
          detectedAtsKind: "greenhouse",
          employerDomainMatched: true,
          manualActionReason: null,
          discoveredAt: "2026-05-12T10:00:00+00:00",
        },
      ],
    }),
  ),
  http.post("*/v1/discovery/locator-candidates/:candidateId/promote", ({ params }) =>
    HttpResponse.json({
      ok: true,
      candidateId: String(params["candidateId"]),
      decision: "promote",
      source: sampleDiscoverySource,
      decidedAt: "2026-05-12T10:00:00+00:00",
    }),
  ),
  http.post("*/v1/discovery/locator-candidates/:candidateId/reject", ({ params }) =>
    HttpResponse.json({
      ok: true,
      candidateId: String(params["candidateId"]),
      decision: "reject",
      source: null,
      decidedAt: "2026-05-12T10:00:00+00:00",
    }),
  ),
  http.get("*/v1/discovery/quarantine", () =>
    HttpResponse.json({
      ok: true,
      entries: [
        {
          jobId: "job-1",
          jobKey: "https://example.com/jobs/quarantined",
          title: "Engineering Manager",
          company: "ExampleCo",
          sourceId: "greenhouse-example",
          postingUrl: "https://example.com/jobs/quarantined",
          reason: "unknown_active_state",
          confidence: 0.62,
          snapshotVersion: 1,
          capturedAt: "2026-05-12T10:00:00+00:00",
          noticeText: null,
        },
      ],
    }),
  ),
  http.post("*/v1/discovery/quarantine/:jobKey/decision", ({ params }) =>
    HttpResponse.json({
      ok: true,
      jobKey: String(params["jobKey"]),
      decision: "approve",
      recordedAt: "2026-05-12T10:00:00+00:00",
    }),
  ),
  http.get("*/v1/discovery/manual-capture", () =>
    HttpResponse.json({
      ok: true,
      items: [
        {
          itemId: "manual-1",
          originatingUrl: "https://example.com/protected/job",
          sourceId: "greenhouse-example",
          reason: "login_required",
          retryContext: { sourceId: "greenhouse-example" },
          requiredAt: "2026-05-12T10:00:00+00:00",
          status: "pending",
        },
      ],
    }),
  ),
  http.post("*/v1/discovery/manual-capture/:itemId/import", ({ params }) =>
    HttpResponse.json({
      ok: true,
      itemId: String(params["itemId"]),
      jobKey: "https://example.com/protected/job",
      importedAt: "2026-05-12T10:00:00+00:00",
      provenance: {
        sourceKind: "user_mediated_capture",
        originatingUrl: "https://example.com/protected/job",
        captureMode: "copied_url",
        futureManualActionRequired: false,
      },
    }),
  ),
  http.post("*/v1/discovery/manual-capture/:itemId/dismiss", ({ params }) =>
    HttpResponse.json({
      ok: true,
      itemId: String(params["itemId"]),
      status: "dismissed",
      dismissedAt: "2026-05-12T10:00:00+00:00",
    }),
  ),
  http.post("*/v1/discovery/feedback", async ({ request }) => {
    const body = (await request.json()) as { jobKey: string; sourceId?: string; kind: string };
    return HttpResponse.json({
      ok: true,
      feedbackId: "feedback-1",
      jobKey: body.jobKey,
      sourceId: body.sourceId ?? null,
      kind: body.kind,
      recordedAt: "2026-05-12T10:00:00+00:00",
    });
  }),
  http.get("*/v1/discovery/role-match-feedback", () =>
    HttpResponse.json({
      ok: true,
      suggestions: [
        {
          suggestionId: "role-title-exclusion-manager-test-engineering",
          status: "pending",
          ruleKind: "exact_title_exclusion",
          titlePattern: "manager test engineering",
          titleDisplay: "Manager, Test Engineering",
          reasonCode: "low_role_fit",
          reason: "Role fit is 1/10 on a job scored 2/10.",
          sampleCount: 1,
          sourceIds: ["jobspy:linkedin"],
          evidence: [
            {
              jobKey: "https://example.com/jobs/test-engineering",
              title: "Manager, Test Engineering",
              company: "ExampleCo",
              sourceId: "jobspy:linkedin",
              fitScore: 2,
              roleFit: 1,
              reason: "Role fit is 1/10 on a job scored 2/10.",
              scoredAt: "2026-05-12T10:00:00+00:00",
            },
          ],
          createdAt: "2026-05-12T10:00:00+00:00",
          updatedAt: "2026-05-12T10:00:00+00:00",
          decidedAt: null,
          decisionReason: null,
        },
      ],
    }),
  ),
  http.post("*/v1/discovery/role-match-feedback/:suggestionId/decision", async ({ params, request }) => {
    const body = (await request.json()) as { decision: "approve" | "decline"; reason?: string };
    return HttpResponse.json({
      ok: true,
      suggestion: {
        suggestionId: String(params["suggestionId"]),
        status: body.decision === "approve" ? "approved" : "declined",
        ruleKind: "exact_title_exclusion",
        titlePattern: "manager test engineering",
        titleDisplay: "Manager, Test Engineering",
        reasonCode: "low_role_fit",
        reason: "Role fit is 1/10 on a job scored 2/10.",
        sampleCount: 1,
        sourceIds: ["jobspy:linkedin"],
        evidence: [],
        createdAt: "2026-05-12T10:00:00+00:00",
        updatedAt: "2026-05-12T10:01:00+00:00",
        decidedAt: "2026-05-12T10:01:00+00:00",
        decisionReason: body.reason ?? null,
      },
    });
  }),

  http.get("*/v1/apply/review-queue", () => HttpResponse.json(sampleApplyReviewQueue)),
  http.post("*/v1/jobs/:jobKey/apply-review/decision", async ({ params, request }) => {
    const body = (await request.json()) as {
      decision: "approve_submit" | "approve_dry_run" | "defer" | "decline" | "reset";
      reason?: string;
      decidedBy?: string;
    };
    return HttpResponse.json({
      ok: true,
      decision: {
        decisionId: `decision-${String(params["jobKey"])}`,
        jobKey: String(params["jobKey"]),
        decision: body.decision,
        reason: body.reason ?? null,
        decidedBy: body.decidedBy ?? "user",
        decidedAt: "2026-05-06T08:30:00Z",
      },
    });
  }),
  http.get("*/v1/outcomes", () => HttpResponse.json(sampleApplicationOutcomes)),
  http.get("*/v1/jobs/:jobKey/outcomes", ({ params }) =>
    HttpResponse.json({
      ...sampleApplicationOutcomes,
      jobKey: String(params["jobKey"]),
      outcomes: sampleApplicationOutcomes.outcomes.filter(
        (outcome) => outcome.jobKey === String(params["jobKey"]),
      ),
      suggestions: sampleApplicationOutcomes.suggestions.filter(
        (suggestion) => suggestion.jobKey === String(params["jobKey"]),
      ),
    }),
  ),
  http.post("*/v1/jobs/:jobKey/outcomes", async ({ params, request }) => {
    const body = (await request.json()) as {
      kind: string;
      occurredAt?: string;
      note?: string;
      interviewPrepGeneration?: number;
    };
    return HttpResponse.json({
      ok: true,
      outcome: {
        outcomeId: `outcome-${String(params["jobKey"])}`,
        jobKey: String(params["jobKey"]),
        kind: body.kind,
        source: "manual",
        note: body.note ?? null,
        occurredAt: body.occurredAt ?? "2026-05-06T08:35:00Z",
        recordedAt: "2026-05-06T08:35:00Z",
        suggestionId: null,
        evidenceId: null,
        interviewPrepGeneration: body.interviewPrepGeneration ?? null,
      },
    });
  }),
  http.post("*/v1/outcome-suggestions/:suggestionId/decision", async ({ params, request }) => {
    const body = (await request.json()) as {
      decision: "accept" | "correct" | "ignore";
      outcomeKind?: string;
      occurredAt?: string;
      note?: string;
      reason?: string;
    };
    const baseSuggestion =
      sampleApplicationOutcomes.suggestions.find(
        (suggestion) => suggestion.suggestionId === String(params["suggestionId"]),
      ) ?? sampleApplicationOutcomes.suggestions[0]!;
    const status =
      body.decision === "accept" ? "accepted" : body.decision === "correct" ? "corrected" : "ignored";
    const outcome =
      body.decision === "ignore"
        ? null
        : {
            outcomeId: `outcome-${String(params["suggestionId"])}`,
            jobKey: baseSuggestion.jobKey,
            kind: body.decision === "correct" ? body.outcomeKind : baseSuggestion.suggestedKind,
            source: "email_suggestion",
            note: body.note ?? null,
            occurredAt: body.occurredAt ?? "2026-05-06T08:40:00Z",
            recordedAt: "2026-05-06T08:40:00Z",
            suggestionId: String(params["suggestionId"]),
            evidenceId: baseSuggestion.evidenceId,
          };
    return HttpResponse.json({
      ok: true,
      suggestion: {
        ...baseSuggestion,
        status,
        decidedAt: "2026-05-06T08:40:00Z",
        decisionReason: body.reason ?? null,
        decidedOutcomeId: outcome?.outcomeId ?? null,
      },
      outcome,
    });
  }),

  http.get("*/v1/jobs", () => HttpResponse.json(makeJobsPage())),
  http.post("*/v1/jobs/bulk-delete", async ({ request }) => {
    const body = (await request.json()) as { jobKeys?: string[] };
    return HttpResponse.json(jobMutationResponse(body.jobKeys ?? []));
  }),
  http.post("*/v1/jobs/bulk-delete-permanent", async ({ request }) => {
    const body = (await request.json()) as { jobKeys?: string[] };
    return HttpResponse.json(jobMutationResponse(body.jobKeys ?? []));
  }),
  http.post("*/v1/jobs/bulk-restore", async ({ request }) => {
    const body = (await request.json()) as { jobKeys?: string[] };
    return HttpResponse.json(jobMutationResponse(body.jobKeys ?? []));
  }),
  http.post("*/v1/jobs/bulk-hide", async ({ request }) => {
    const body = (await request.json()) as { jobKeys?: string[] };
    return HttpResponse.json(jobMutationResponse(body.jobKeys ?? []));
  }),
  http.post("*/v1/jobs/bulk-unhide", async ({ request }) => {
    const body = (await request.json()) as { jobKeys?: string[] };
    return HttpResponse.json(jobMutationResponse(body.jobKeys ?? []));
  }),
  http.post("*/v1/jobs/bulk-retry-failed", async ({ request }) => {
    const body = (await request.json()) as { jobKeys?: string[] };
    return HttpResponse.json(jobMutationResponse(body.jobKeys ?? []));
  }),
  http.post("*/v1/jobs/bulk-run-pending-preparation", async ({ request }) => {
    const body = (await request.json()) as { jobKeys?: string[] };
    return HttpResponse.json({
      ...jobMutationResponse(body.jobKeys ?? []),
      stageCounts: {},
      status: "accepted",
      actions: [],
    });
  }),
  http.get("*/v1/jobs/:jobKey", ({ params }) =>
    HttpResponse.json(makeJobDetail({
      ...makeJobsPage().items[0]!,
      jobKey: String(params["jobKey"]),
    })),
  ),
  http.delete("*/v1/jobs/:jobKey", ({ params }) =>
    HttpResponse.json(jobMutationResponse([String(params["jobKey"])])),
  ),
  http.delete("*/v1/jobs/:jobKey/permanent", ({ params }) =>
    HttpResponse.json(jobMutationResponse([String(params["jobKey"])])),
  ),
  http.post("*/v1/jobs/:jobKey/restore", ({ params }) =>
    HttpResponse.json(jobMutationResponse([String(params["jobKey"])])),
  ),
  http.post("*/v1/jobs/:jobKey/hide", ({ params }) =>
    HttpResponse.json(jobMutationResponse([String(params["jobKey"])])),
  ),
  http.post("*/v1/jobs/:jobKey/unhide", ({ params }) =>
    HttpResponse.json(jobMutationResponse([String(params["jobKey"])])),
  ),
  http.post("*/v1/jobs/:jobKey/score-correction", async ({ params, request }) => {
    const body = (await request.json()) as { correctedScore: number; reason: string };
    return HttpResponse.json(makeJobDetail({
      ...makeJobsPage().items[0]!,
      jobKey: String(params["jobKey"]),
      fitScore: body.correctedScore,
      scoreCorrection: {
        correctedScore: body.correctedScore,
        rationale: body.reason,
        correctedBy: "local",
        correctedAt: "2026-05-14T10:00:00+00:00",
      },
    }));
  }),
  http.post("*/v1/scoring/stale-scores/actions/reset-for-rescore", async ({ request }) => {
    const body = (await request.json()) as { jobKeys?: string[] };
    return HttpResponse.json({
      ok: true,
      count: body.jobKeys?.length ?? 0,
      jobKeys: body.jobKeys ?? [],
      nextAction: "jobhunter run score --rescore",
    });
  }),
  http.post("*/v1/jobs/:jobKey/actions/rescore-current-policy", ({ params }) =>
    HttpResponse.json(actionRunResponse(String(params["jobKey"]), "rescore_job")),
  ),
  http.post("*/v1/scoring/actions/rescore-current-policy", () =>
    HttpResponse.json(actionRunResponse("pipeline", "rescore_jobs_not_on_current_scoring_policy")),
  ),
  http.post("*/v1/jobs/:jobKey/actions/retry-stage", ({ params }) =>
    HttpResponse.json(actionRunResponse(String(params["jobKey"]), "retry_stage")),
  ),
  http.post("*/v1/jobs/:jobKey/actions/generate-materials", ({ params }) =>
    HttpResponse.json(actionRunResponse(String(params["jobKey"]), "generate_materials")),
  ),
  http.post("*/v1/jobs/:jobKey/actions/generate-interview-prep", ({ params }) =>
    HttpResponse.json(actionRunResponse(String(params["jobKey"]), "generate_interview_prep")),
  ),
  http.post("*/v1/jobs/:jobKey/actions/tailor", ({ params }) =>
    HttpResponse.json(actionRunResponse(String(params["jobKey"]), "tailor_job")),
  ),
  http.post("*/v1/jobs/:jobKey/actions/retailor-current-policy", ({ params }) =>
    HttpResponse.json(actionRunResponse(String(params["jobKey"]), "retailor_job")),
  ),
  http.post("*/v1/materials/actions/retailor-current-policy", () =>
    HttpResponse.json(actionRunResponse("pipeline", "retailor_current_policy")),
  ),
  http.post("*/v1/jobs/:jobKey/actions/apply", ({ params }) =>
    HttpResponse.json(actionRunResponse(String(params["jobKey"]), "apply")),
  ),
  http.post("*/v1/jobs/:jobKey/actions/cancel", ({ params }) =>
    HttpResponse.json(actionRunResponse(String(params["jobKey"]), "cancel")),
  ),
  http.post("*/v1/jobs/:jobKey/actions/mark-applied", ({ params }) =>
    HttpResponse.json(actionRunResponse(String(params["jobKey"]), "mark_applied")),
  ),
  http.post("*/v1/jobs/:jobKey/actions/mark-skipped", ({ params }) =>
    HttpResponse.json(actionRunResponse(String(params["jobKey"]), "mark_skipped")),
  ),
  http.post("*/v1/pipeline/actions/run-stage", async ({ request }) => {
    const body = (await request.json()) as { stages?: string[] };
    return HttpResponse.json({
      ok: true,
      action: "run_stage",
      status: "queued",
      jobKey: "pipeline",
      count: body.stages?.length ?? 0,
      command: body,
      actions: (body.stages ?? []).map((stage) =>
        actionRunResponse("pipeline", stage === "apply" ? "apply" : "run_stage"),
      ),
    });
  }),

  http.get("*/v1/workflow-runs", () => HttpResponse.json(makeWorkflowRunsPage())),
  http.get("*/v1/workflow-runs/:runId", ({ params }) =>
    HttpResponse.json(makeWorkflowRunDetail({ workflowId: String(params["runId"]), runId: String(params["runId"]) })),
  ),
  http.post("*/v1/workflow-runs/:runId/actions/cancel", ({ params }) =>
    HttpResponse.json({
      ...actionRunResponse("pipeline", "cancel"),
      runId: String(params["runId"]),
      command: {
        action: "cancel",
        jobKey: "pipeline",
        runId: String(params["runId"]),
      },
    }),
  ),

  http.get("*/v1/artifacts", () =>
    HttpResponse.json(makeArtifactsPage([sampleDraftResumeArtifact, sampleAcceptedResumeArtifact])),
  ),
  http.get("*/v1/artifacts/:artifactId", ({ params }) =>
    HttpResponse.json(makeStoryArtifactDetail(String(params["artifactId"]))),
  ),
  http.post("*/v1/artifacts/:artifactId/open", ({ params }) =>
    HttpResponse.json({
      ok: true,
      artifact: {
        ...makeArtifactsPage().items[0]!,
        artifactId: String(params["artifactId"]),
      },
      opened: true,
      path: `/tmp/jobhunter-test/artifacts/${String(params["artifactId"])}.pdf`,
    }),
  ),

  http.get("*/v1/profile", () => HttpResponse.json(sampleProfileResponse)),
  http.patch("*/v1/profile", () => HttpResponse.json(sampleProfileResponse)),
  http.post("*/v1/profile/import-resume", () =>
    HttpResponse.json({ ok: true, profile: sampleProfileResponse.profile }),
  ),
  http.get("*/v1/profile/preview.html", () =>
    new HttpResponse(
      `
        <main class="resume-page">
          <section class="resume-section">
            <h1 data-resume-layout-target="profile-name">Jordan Vale</h1>
            <p>Engineering leader with platform, security, and infrastructure experience.</p>
          </section>
        </main>
      `,
      {
        status: 200,
        headers: { "Content-Type": "text/html" },
      },
    ),
  ),

  http.get("*/v1/resume-templates", () => HttpResponse.json(sampleResumeTemplateListResponse)),
  http.get("*/v1/resume-templates/:templateId", ({ params }) => {
    const template =
      sampleResumeTemplateListResponse.templates.find((item) => item.templateId === String(params["templateId"])) ??
      sampleResumeTemplateListResponse.templates[0]!;
    return HttpResponse.json({ ok: true, template });
  }),
  http.post("*/v1/resume-templates", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { displayName?: string; templateId?: string };
    return HttpResponse.json({
      ok: true,
      template: {
        ...sampleResumeTemplateListResponse.templates[0]!,
        templateId: body.templateId ?? "custom-template-1",
        displayName: body.displayName ?? "Custom template",
        builtIn: false,
      },
    });
  }),
  http.patch("*/v1/resume-templates/default", () =>
    HttpResponse.json({
      ok: true,
      defaultTemplate: {
        ...sampleResumeTemplateListResponse.builtInDefault,
        assignmentSource: "profile_default",
      },
    }),
  ),
  http.patch("*/v1/jobs/:jobKey/resume-template", ({ params }) =>
    HttpResponse.json({
      ok: true,
      jobKey: String(params["jobKey"]),
      effectiveTemplate: sampleResumeTemplateListResponse.builtInDefault,
      overrideTemplate: null,
      templateState: null,
    }),
  ),
  http.post("*/v1/jobs/:jobKey/resume-template/ensure-current", ({ params }) =>
    HttpResponse.json({
      ok: true,
      jobKey: String(params["jobKey"]),
      status: "not_required",
      templateState: null,
      attempt: null,
      generation: null,
      message: "Resume materials already use the effective template.",
    }),
  ),

  http.get("*/v1/settings", () => HttpResponse.json(sampleSettingsResponse)),
  http.patch("*/v1/settings", () => HttpResponse.json(sampleSettingsResponse)),
  http.get("*/v1/extension/pairing-token", () =>
    HttpResponse.json(sampleExtensionCapabilityTokenResponse),
  ),
  http.post("*/v1/extension/pairing-token/rotate", () =>
    HttpResponse.json({
      ...sampleExtensionCapabilityTokenResponse,
      token: "jh_ext_rotated_token_123456789012345678901234567",
      created: true,
    }),
  ),

  http.get("*/v1/credentials", () => HttpResponse.json(sampleCredentialsResponse)),
  http.patch("*/v1/credentials", () => HttpResponse.json(sampleCredentialsResponse)),
  http.delete("*/v1/credentials/:key", () => HttpResponse.json(sampleCredentialsResponse)),

  http.get("*/v1/contacts", ({ request }) => {
    const url = new URL(request.url);
    const jobId = url.searchParams.get("jobId");
    const employer = url.searchParams.get("employer");
    const all = [sampleContactSummary, sampleSecondaryContactSummary];
    const items = all.filter(
      (contact) =>
        (!jobId || contact.jobId === jobId) &&
        (!employer || contact.employer === employer),
    );
    return HttpResponse.json(makeContactListResponse(items));
  }),
  http.post("*/v1/contacts/import", async ({ request }) => {
    const body = (await request.json()) as { csvText?: string };
    const rows = (body.csvText ?? "").split(/\r?\n/).filter((line) => line.trim().length > 0);
    const imported = Math.max(rows.length - 1, 0);
    return HttpResponse.json({
      ok: true,
      imported,
      skipped: 0,
      contactIds: Array.from({ length: imported }, (_, index) => `imported-contact-${index + 1}`),
    });
  }),
  http.post("*/v1/contacts", async ({ request }) => {
    const body = (await request.json()) as ContactCreateRequest;
    const attributes: ContactAttributeDto[] = (body.attributes ?? []).map((attribute, index) => ({
      attributeId: `new-attr-${index + 1}`,
      kind: attribute.kind,
      value: attribute.value,
      provenance: makeContactProvenance(),
    }));
    const nameValue = attributes.find((attribute) => attribute.kind === "name")?.value;
    return HttpResponse.json(
      makeContactMutationResponse(
        makeContactDetail({
          contactId: "contact-created",
          displayName: nameValue ?? body.employer ?? "New contact",
          role: body.role,
          employer: body.employer ?? null,
          jobId: body.jobId ?? null,
          attributes,
        }),
      ),
    );
  }),
  // Research routes must precede ``/v1/contacts/:contactId`` (MSW matches in
  // array order; ``/v1/contacts/research`` would otherwise bind :contactId).
  http.get("*/v1/contacts/research", ({ request }) => {
    const url = new URL(request.url);
    const jobId = url.searchParams.get("jobId");
    const employer = url.searchParams.get("employer");
    const items = [sampleResearchTaskSummary].filter(
      (task) => (!jobId || task.jobId === jobId) && (!employer || task.employer === employer),
    );
    return HttpResponse.json(makeResearchListResponse(items));
  }),
  http.get("*/v1/contacts/research/:taskId", () =>
    HttpResponse.json(makeResearchDetailResponse()),
  ),
  http.post("*/v1/contacts/research", () =>
    HttpResponse.json(
      { ok: true, taskId: "task-new", runId: "run-1", workflowId: "contact-research-x", status: "queued" },
      { status: 202 },
    ),
  ),
  http.post("*/v1/contacts/research/:taskId/candidates/:candidateId/confirm", () =>
    HttpResponse.json(makeConfirmCandidateResponse()),
  ),
  // Outreach draft routes. The contact-scoped ``/outreach`` reads/writes precede
  // ``/v1/contacts/:contactId`` for clarity; the ``/v1/outreach/threads`` writes
  // return the updated gated thread (no send transport anywhere — INV-1).
  http.get("*/v1/contacts/:contactId/outreach", () =>
    HttpResponse.json(makeOutreachThreadResponse()),
  ),
  http.post("*/v1/contacts/:contactId/outreach/drafts", () =>
    HttpResponse.json(makeOutreachThreadResponse()),
  ),
  http.post("*/v1/outreach/threads/:threadId/drafts/:draftId/approve", () =>
    HttpResponse.json(makeOutreachThreadResponse()),
  ),
  http.post("*/v1/outreach/threads/:threadId/drafts/:draftId/reject", () =>
    HttpResponse.json(makeOutreachThreadResponse()),
  ),
  http.post("*/v1/outreach/threads/:threadId/drafts", () =>
    HttpResponse.json(makeOutreachThreadResponse()),
  ),
  // R6 Phase 4: user-attested send log + follow-ups. `send-logs` RECORDS a fact
  // (no transport, INV-1); the follow-up routes schedule/complete/dismiss a
  // surfaced-only reminder; `follow-ups/due` is the derived due list.
  http.post("*/v1/outreach/threads/:threadId/send-logs", () =>
    HttpResponse.json(
      makeOutreachThreadResponse(
        makeOutreachThreadDetail({ sendLogs: [makeOutreachSendLog()], isSent: true }),
      ),
    ),
  ),
  http.post("*/v1/outreach/threads/:threadId/follow-up/schedule", () =>
    HttpResponse.json(
      makeOutreachThreadResponse(
        makeOutreachThreadDetail({ followUp: makeOutreachFollowUp({ state: "scheduled" }) }),
      ),
    ),
  ),
  http.post("*/v1/outreach/threads/:threadId/follow-up/complete", () =>
    HttpResponse.json(
      makeOutreachThreadResponse(
        makeOutreachThreadDetail({ followUp: makeOutreachFollowUp({ state: "completed" }) }),
      ),
    ),
  ),
  http.post("*/v1/outreach/threads/:threadId/follow-up/dismiss", () =>
    HttpResponse.json(
      makeOutreachThreadResponse(
        makeOutreachThreadDetail({ followUp: makeOutreachFollowUp({ state: "dismissed" }) }),
      ),
    ),
  ),
  http.get("*/v1/outreach/follow-ups/due", () =>
    HttpResponse.json({ ok: true, followUps: [makeDueFollowUpSummary()] }),
  ),
  http.get("*/v1/contacts/:contactId", ({ params }) =>
    HttpResponse.json(
      makeContactDetailResponse(
        makeContactDetail({ contactId: String(params["contactId"]) }),
      ),
    ),
  ),
  http.patch("*/v1/contacts/:contactId", async ({ params, request }) => {
    const body = (await request.json()) as ContactUpdateRequest;
    return HttpResponse.json(
      makeContactMutationResponse(
        makeContactDetail({
          ...sampleContactDetail,
          contactId: String(params["contactId"]),
          role: body.role ?? sampleContactDetail.role,
          employer: body.employer ?? sampleContactDetail.employer,
          jobId: body.jobId ?? sampleContactDetail.jobId,
        }),
      ),
    );
  }),
  http.delete("*/v1/contacts/:contactId", ({ params }) =>
    HttpResponse.json({
      ok: true,
      contactId: String(params["contactId"]),
      deletedAt: "2026-07-01T00:00:00+00:00",
    }),
  ),
];

export function failingHandler(method: "get" | "post" | "patch" | "delete", path: string, status = 500) {
  return http[method](`*${path}`, () =>
    new HttpResponse(JSON.stringify({ ok: false, error: `Mock failure ${status}` }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}
