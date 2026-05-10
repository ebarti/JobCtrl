import { http, HttpResponse } from "msw";

import {
  makeArtifactDetail,
  makeArtifactsPage,
  makeJobDetail,
  makeJobsPage,
  makeWorkflowRunsPage,
  sampleCredentialsResponse,
  sampleDashboardSummary,
  sampleHealthResponse,
  sampleProfileResponse,
  sampleSettingsResponse,
} from "../fixtures/projections.js";

function actionRunResponse(jobKey: string, action: string, status = "queued") {
  return {
    ok: true,
    runId: `run-${jobKey}-${Date.now()}`,
    actionId: `action-${jobKey}-${Date.now()}`,
    action,
    status,
    jobKey,
    command: { action, jobKey },
  };
}

function aggregateActionStatus(actions: Array<{ status: string }>): string {
  if (actions.some((action) => action.status === "failed")) return "failed";
  const first = actions[0]?.status ?? "accepted";
  return actions.every((action) => action.status === first) ? first : "accepted";
}

function jobMutationResponse(jobKeys: string[]) {
  return { ok: true, count: jobKeys.length, jobKeys };
}

export const handlers = [
  http.get("*/v1/health", () => HttpResponse.json(sampleHealthResponse)),
  http.get("*/v1/dashboard/summary", () => HttpResponse.json(sampleDashboardSummary)),

  http.get("*/v1/jobs", () => HttpResponse.json(makeJobsPage())),
  http.post("*/v1/jobs/bulk-delete", async ({ request }) => {
    const body = (await request.json()) as { jobKeys?: string[] };
    return HttpResponse.json(jobMutationResponse(body.jobKeys ?? []));
  }),
  http.post("*/v1/jobs/bulk-restore", async ({ request }) => {
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
  http.post("*/v1/jobs/:jobKey/restore", ({ params }) =>
    HttpResponse.json(jobMutationResponse([String(params["jobKey"])])),
  ),
  http.post("*/v1/jobs/:jobKey/actions/retry-stage", ({ params }) =>
    HttpResponse.json(actionRunResponse(String(params["jobKey"]), "retry_stage")),
  ),
  http.post("*/v1/jobs/:jobKey/actions/generate-materials", ({ params }) =>
    HttpResponse.json(actionRunResponse(String(params["jobKey"]), "generate_materials")),
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
    const body = (await request.json()) as { dryRun?: boolean; stages?: string[] };
    const stages = body.stages ?? [];
    const actions = stages.map((stage) =>
      actionRunResponse(
        "pipeline",
        stage === "apply" ? "apply" : "run_stage",
        stage === "apply" ? "queued" : body.dryRun === false ? "succeeded" : "dry_run",
      ),
    );
    return HttpResponse.json(
      {
        ok: true,
        action: "run_stage",
        status: aggregateActionStatus(actions),
        jobKey: "pipeline",
        count: stages.length,
        command: body,
        actions,
      },
      { status: stages.includes("apply") ? 202 : 200 },
    );
  }),

  http.get("*/v1/workflow-runs", () => HttpResponse.json(makeWorkflowRunsPage())),

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
