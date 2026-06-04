import { http, HttpResponse } from "msw";

import {
  makeArtifactDetail,
  makeActivityPage,
  sampleApplicationOutcomes,
  sampleApplyReviewQueue,
  makeArtifactsPage,
  makeJobDetail,
  makeJobsPage,
  makeWorkflowRunsPage,
  sampleCredentialsResponse,
  sampleDashboardSummary,
  sampleDiscoverySettingsResponse,
  sampleHealthResponse,
  sampleProfileResponse,
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
  qualityTrend: "flat",
};

export const handlers = [
  http.get("*/v1/health", () => HttpResponse.json(sampleHealthResponse)),
  http.get("*/v1/dashboard/summary", () => HttpResponse.json(sampleDashboardSummary)),
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

  http.get("*/v1/artifacts", () => HttpResponse.json(makeArtifactsPage())),
  http.get("*/v1/artifacts/:artifactId", ({ params }) =>
    HttpResponse.json(
      makeArtifactDetail({
        ...makeArtifactsPage().items[0]!,
        artifactId: String(params["artifactId"]),
      }),
    ),
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
  http.get("*/v1/profile/preview.pdf", () =>
    new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    }),
  ),

  http.get("*/v1/settings", () => HttpResponse.json(sampleSettingsResponse)),
  http.patch("*/v1/settings", () => HttpResponse.json(sampleSettingsResponse)),

  http.get("*/v1/credentials", () => HttpResponse.json(sampleCredentialsResponse)),
  http.patch("*/v1/credentials", () => HttpResponse.json(sampleCredentialsResponse)),
  http.delete("*/v1/credentials/:key", () => HttpResponse.json(sampleCredentialsResponse)),
];

export function failingHandler(method: "get" | "post" | "patch" | "delete", path: string, status = 500) {
  return http[method](`*${path}`, () =>
    new HttpResponse(JSON.stringify({ ok: false, error: `Mock failure ${status}` }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}
