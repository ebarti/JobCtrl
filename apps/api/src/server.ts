import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { type ZodType } from "zod";

import {
  type ActionCommandPayload,
  type ActionRunResponse,
  ApplyJobRequestSchema,
  ArtifactListQuerySchema,
  BulkJobMutationRequestSchema,
  CancelJobActionRequestSchema,
  CorrectScoreRequestSchema,
  PIPELINE_ACTION_JOB_KEY,
  type PipelineStageRunResponse,
  CredentialKeys,
  CredentialUpdateRequestSchema,
  DeleteJobRequestSchema,
  DiscoveryFeedbackRequestSchema,
  GenerateMaterialsRequestSchema,
  JobListQuerySchema,
  JsonRpcErrorCodes,
  JsonRpcRequestSchema,
  MarkJobActionRequestSchema,
  ManualCaptureDismissSchema,
  ManualCaptureImportSchema,
  ProfileImportRequestSchema,
  ProfileUpdateRequestSchema,
  QuarantineDecisionSchema,
  RetryStageRequestSchema,
  RunPipelineStagesRequestSchema,
  SettingsUpdateRequestSchema,
  SourceLocatorDecisionSchema,
  SourceStatePatchSchema,
  SourceUpsertRequestSchema,
  WorkflowRunsListQuerySchema,
} from "./contracts.js";
import { databaseExists, openDatabase } from "./db.js";
import {
  decideQuarantineEntry,
  dismissManualCapture,
  listManualCaptureQueue,
  listQuarantine,
  listSourceLocatorCandidates,
  listSourceRegistry,
  patchSourceState,
  previewDiscoverySource,
  promoteSourceLocatorCandidate,
  recordDiscoveryFeedback,
  rejectSourceLocatorCandidate,
  upsertSourceRegistryEntry,
} from "./discovery-controls.js";
import { registerEventStreamRoute } from "./event-stream.js";
import { KeychainCredentialStore, type CredentialStore } from "./credentials.js";
import {
  buildActionResponse,
  defaultActionDispatcher,
  defaultArtifactOpener,
  defaultProfilePreviewRenderer,
  defaultProfileImporter,
  type ActionDispatcher,
  type ArtifactOpener,
  type ProfilePreviewRenderer,
  type ProfileImporter,
} from "./local-actions.js";
import {
  createWorkerManualCaptureImporter,
  ManualCaptureImportError,
  type ManualCaptureImporter,
} from "./manual-capture-worker.js";
import {
  buildDashboardSummary,
  getArtifactDetail,
  getJobDetail,
  listArtifacts,
  listJobs,
  listWorkflowRuns,
  readSettingsConfig,
} from "./read-model.js";
import { isTrustedMutationSource, LOCAL_CORS_METHODS, LOCAL_ORIGIN_PATTERNS } from "./local-origin.js";
import {
  ProfileInputError,
  readProfileConfig,
  writeProfileConfig,
} from "./profile-store.js";
import {
  cancelJobAction,
  correctScore,
  hideJob,
  hideJobs,
  InputError,
  markJobApplied,
  markJobSkipped,
  resetJobStage,
  restoreJob,
  restoreJobs,
  resolveJobUrl,
  softDeleteJob,
  softDeleteJobs,
  unhideJob,
  unhideJobs,
  writeSettingsConfig,
} from "./write-model.js";

const UNSAFE_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);

export interface BuildAppOptions {
  appDir?: string;
  dbPath: string;
  profilePath: string;
  resumeStylePath: string;
  resumeTemplatePath: string;
  settingsPath: string;
  actionDispatcher?: ActionDispatcher;
  artifactOpener?: ArtifactOpener;
  credentialStore?: CredentialStore;
  manualCaptureImporter?: ManualCaptureImporter;
  profileImporter?: ProfileImporter;
  profilePreviewRenderer?: ProfilePreviewRenderer;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, routerOptions: { maxParamLength: 4096 } });
  const appDir = options.appDir ?? path.dirname(options.dbPath);
  const actionDispatcher = options.actionDispatcher ?? defaultActionDispatcher;
  const artifactOpener = options.artifactOpener ?? defaultArtifactOpener;
  const credentialStore = options.credentialStore ?? new KeychainCredentialStore();
  const manualCaptureImporter = options.manualCaptureImporter ?? createWorkerManualCaptureImporter();
  const profileImporter = options.profileImporter ?? defaultProfileImporter;
  const profilePreviewRenderer = options.profilePreviewRenderer ?? defaultProfilePreviewRenderer;
  const actionContext = { appDir };

  void app.register(cors, {
    origin: LOCAL_ORIGIN_PATTERNS,
    methods: LOCAL_CORS_METHODS,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!UNSAFE_METHODS.has(request.method)) {
      return;
    }
    if (isTrustedMutationSource(request.headers.origin, request.headers.referer)) {
      return;
    }
    return reply.code(403).send({
      ok: false,
      error: "cross_site_request",
      message: "Mutation requests require a loopback Origin or Referer.",
    });
  });

  app.get("/v1/health", async () => ({
    ok: true,
    dbPath: options.dbPath,
    dbExists: databaseExists(options.dbPath),
  }));

  registerEventStreamRoute(app, { dbPath: options.dbPath });

  app.get("/v1/dashboard/summary", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) => buildDashboardSummary(db)),
  );

  app.get("/v1/discovery/sources", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) => listSourceRegistry(db)),
  );

  app.post("/v1/discovery/sources", async (request, reply) => {
    const body = parseBody(reply, SourceUpsertRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) => ({
      ok: true,
      source: upsertSourceRegistryEntry(db, body),
    }));
  });

  app.patch<{ Params: { sourceId: string } }>(
    "/v1/discovery/sources/:sourceId/state",
    async (request, reply) => {
      const body = parseBody(reply, SourceStatePatchSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      return withWritableDb(reply, options.dbPath, (db) => ({
        ok: true,
        source: patchSourceState(db, decodeRouteParam(request.params.sourceId), body),
      }));
    },
  );

  app.get<{ Params: { sourceId: string } }>(
    "/v1/discovery/sources/:sourceId/preview",
    async (request, reply) =>
      withDb(reply, options.dbPath, (db) =>
        previewDiscoverySource(db, decodeRouteParam(request.params.sourceId)),
      ),
  );

  app.get("/v1/discovery/locator-candidates", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) => listSourceLocatorCandidates(db)),
  );

  app.post<{ Params: { candidateId: string } }>(
    "/v1/discovery/locator-candidates/:candidateId/promote",
    async (request, reply) => {
      const body = parseBody(reply, SourceLocatorDecisionSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      return withWritableDb(reply, options.dbPath, (db) =>
        promoteSourceLocatorCandidate(db, decodeRouteParam(request.params.candidateId)),
      );
    },
  );

  app.post<{ Params: { candidateId: string } }>(
    "/v1/discovery/locator-candidates/:candidateId/reject",
    async (request, reply) => {
      const body = parseBody(reply, SourceLocatorDecisionSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      return withWritableDb(reply, options.dbPath, (db) =>
        rejectSourceLocatorCandidate(db, decodeRouteParam(request.params.candidateId)),
      );
    },
  );

  app.get("/v1/discovery/quarantine", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) => listQuarantine(db)),
  );

  app.post<{ Params: { jobKey: string } }>(
    "/v1/discovery/quarantine/:jobKey/decision",
    async (request, reply) => {
      const body = parseBody(reply, QuarantineDecisionSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      return withWritableDb(reply, options.dbPath, (db) =>
        decideQuarantineEntry(db, decodeRouteParam(request.params.jobKey), body),
      );
    },
  );

  app.get("/v1/discovery/manual-capture", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) => listManualCaptureQueue(db)),
  );

  app.post<{ Params: { itemId: string } }>(
    "/v1/discovery/manual-capture/:itemId/import",
    async (request, reply) => {
      const body = parseBody(reply, ManualCaptureImportSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      if (!databaseExists(options.dbPath)) {
        void reply.code(503);
        return { ok: false, error: "db_not_found", message: `No JobHunter database found at ${options.dbPath}` };
      }
      try {
        return await manualCaptureImporter(decodeRouteParam(request.params.itemId), body, {
          appDir,
          dbPath: options.dbPath,
        });
      } catch (error) {
        if (error instanceof ManualCaptureImportError) {
          void reply.code(error.statusCode);
          return {
            ok: false,
            error: error.statusCode === 404 ? "not_found" : "manual_capture_import_failed",
            message: error.message,
          };
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { itemId: string } }>(
    "/v1/discovery/manual-capture/:itemId/dismiss",
    async (request, reply) => {
      const body = parseBody(reply, ManualCaptureDismissSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      return withWritableDb(reply, options.dbPath, (db) =>
        dismissManualCapture(db, decodeRouteParam(request.params.itemId), body.reason),
      );
    },
  );

  app.post("/v1/discovery/feedback", async (request, reply) => {
    const body = parseBody(reply, DiscoveryFeedbackRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) => recordDiscoveryFeedback(db, body));
  });

  app.post("/v1/pipeline/actions/run-stage", async (request, reply) => {
    const body = parseBody(reply, RunPipelineStagesRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    const actions: ActionRunResponse[] = [];
    let applyQueued = false;
    for (const stage of body.stages) {
      const command: ActionCommandPayload =
        stage === "apply"
          ? {
              action: "apply" as const,
              jobKey: PIPELINE_ACTION_JOB_KEY,
              stage,
              limit: body.limit,
              workers: body.workers,
              minScore: body.minScore,
              dryRun: body.dryRun,
              headless: body.headless,
              model: body.model,
              continuous: body.continuous,
            }
          : {
              action: "run_stage" as const,
              jobKey: PIPELINE_ACTION_JOB_KEY,
              stage,
              limit: body.limit,
              workers: body.workers,
              minScore: body.minScore,
              validationMode: body.validationMode,
              dryRun: body.dryRun,
              rescore: body.rescore,
              retailor: body.retailor,
            };
      const dispatch = await actionDispatcher(command, actionContext);
      actions.push(buildActionResponse(command, dispatch));
      if (command.action === "apply" && dispatch.status === "queued") {
        applyQueued = true;
      }
      if (dispatch.status === "failed") {
        break;
      }
    }
    void reply.code(applyQueued ? 202 : 200);
    return {
      ok: true,
      action: "run_stage",
      status: stageRunStatus(actions),
      jobKey: PIPELINE_ACTION_JOB_KEY,
      count: actions.length,
      command: body,
      actions,
    } satisfies PipelineStageRunResponse;
  });

  app.get("/v1/jobs", async (request, reply) =>
    withDb(reply, options.dbPath, (db) => listJobs(db, JobListQuerySchema.parse(request.query))),
  );

  app.post("/v1/jobs/bulk-delete", async (request, reply) => {
    const body = parseBody(reply, BulkJobMutationRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) => softDeleteJobs(db, body));
  });

  app.post("/v1/jobs/bulk-restore", async (request, reply) => {
    const body = parseBody(reply, BulkJobMutationRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) => restoreJobs(db, body));
  });

  app.post("/v1/jobs/bulk-hide", async (request, reply) => {
    const body = parseBody(reply, BulkJobMutationRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) => hideJobs(db, body));
  });

  app.post("/v1/jobs/bulk-unhide", async (request, reply) => {
    const body = parseBody(reply, BulkJobMutationRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) => unhideJobs(db, body));
  });

  app.get<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey", async (request, reply) =>
    withDb(reply, options.dbPath, (db) => {
      const detail = getJobDetail(db, decodeRouteParam(request.params.jobKey));
      if (!detail) {
        void reply.code(404);
        return { ok: false, error: "job_not_found" };
      }
      return detail;
    }),
  );

  app.post<{ Params: { jobKey: string } }>(
    "/v1/jobs/:jobKey/score-correction",
    async (request, reply) => {
      const body = parseBody(reply, CorrectScoreRequestSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      return withWritableDb(reply, options.dbPath, (db) => {
        const { jobUrl } = correctScore(db, decodeRouteParam(request.params.jobKey), body);
        const detail = getJobDetail(db, jobUrl);
        if (!detail) {
          void reply.code(404);
          return { ok: false, error: "job_not_found" };
        }
        return detail;
      });
    },
  );

  app.delete<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey", async (request, reply) => {
    const body = parseBody(reply, DeleteJobRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) => softDeleteJob(db, decodeRouteParam(request.params.jobKey), body));
  });

  app.post<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey/restore", async (request, reply) =>
    withWritableDb(reply, options.dbPath, (db) => restoreJob(db, decodeRouteParam(request.params.jobKey))),
  );

  app.post<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey/hide", async (request, reply) => {
    const body = parseBody(reply, DeleteJobRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) => hideJob(db, decodeRouteParam(request.params.jobKey), body));
  });

  app.post<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey/unhide", async (request, reply) =>
    withWritableDb(reply, options.dbPath, (db) => unhideJob(db, decodeRouteParam(request.params.jobKey))),
  );

  app.post<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey/actions/retry-stage", async (request, reply) => {
    const body = parseBody(reply, RetryStageRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    if (body.runAfter && body.stage !== "apply") {
      void reply.code(400);
      return unsupportedPerJobMaterialAction();
    }
    return withWritableDb(reply, options.dbPath, async (db) => {
      const reset = resetJobStage(db, decodeRouteParam(request.params.jobKey), body.stage, {
        resetAttempts: body.resetAttempts,
      });
      const command = {
        action: "retry_stage" as const,
        jobKey: reset.jobUrl,
        stage: body.stage,
        resetAttempts: body.resetAttempts,
        runAfter: body.runAfter,
        dryRun: body.dryRun,
        limit: 1,
      };
      const dispatch = body.runAfter ? await actionDispatcher(command, actionContext) : { status: "reset" };
      void reply.code(body.runAfter ? 202 : 200);
      return buildActionResponse(command, dispatch, { stage: reset.stage });
    });
  });

  app.post<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey/actions/generate-materials", async (request, reply) => {
    const body = parseBody(reply, GenerateMaterialsRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, async (db) => {
      const jobUrl = resolveExistingJob(reply, db, decodeRouteParam(request.params.jobKey));
      if (!jobUrl) {
        return { ok: false, error: "job_not_found" };
      }
      void body;
      void reply.code(400);
      return unsupportedPerJobMaterialAction(jobUrl);
    });
  });

  app.post<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey/actions/apply", async (request, reply) => {
    const body = parseBody(reply, ApplyJobRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, async (db) => {
      const jobUrl = resolveExistingJob(reply, db, decodeRouteParam(request.params.jobKey));
      if (!jobUrl) {
        return { ok: false, error: "job_not_found" };
      }
      const command = {
        action: "apply" as const,
        jobKey: jobUrl,
        dryRun: body.dryRun,
        headless: body.headless,
        limit: body.limit,
        model: body.model,
      };
      const dispatch = await actionDispatcher(command, actionContext);
      void reply.code(202);
      return buildActionResponse(command, dispatch);
    });
  });

  app.post<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey/actions/cancel", async (request, reply) => {
    const body = parseBody(reply, CancelJobActionRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    const writeOutcome = await withWritableDb(reply, options.dbPath, (db) => {
      const canceled = cancelJobAction(db, decodeRouteParam(request.params.jobKey), body.runId ?? "");
      const command: ActionCommandPayload = {
        action: "cancel" as const,
        jobKey: canceled.jobUrl,
      };
      if (body.runId) {
        command.runId = body.runId;
      }
      return { command, stage: canceled.stage };
    });
    if ("ok" in writeOutcome) {
      return writeOutcome;
    }
    // Forward the cancel to the worker so the running Temporal workflow
    // (started by PR 3's mode="workflow" cut-over) actually receives a
    // cancellation signal. Without this, the SQLite event-flip succeeds
    // but the workflow keeps polling Chrome and the stage row drifts
    // back to running on the next worker_loop cycle.
    const { command: cancelCommand, stage: cancelStage } = writeOutcome;
    const runId = cancelCommand.runId;
    if (runId) {
      try {
        await actionDispatcher(cancelCommand, actionContext);
      } catch (err) {
        request.log?.warn(
          { err, jobKey: cancelCommand.jobKey, runId },
          "cancel route: worker dispatch failed; SQLite cancel event still recorded",
        );
      }
    }
    return buildActionResponse(
      cancelCommand,
      { status: "cancel_requested" },
      { stage: cancelStage },
    );
  });

  app.post<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey/actions/mark-applied", async (request, reply) => {
    const body = parseBody(reply, MarkJobActionRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) => {
      const marked = markJobApplied(db, decodeRouteParam(request.params.jobKey), body);
      const command: ActionCommandPayload = {
        action: "mark_applied" as const,
        jobKey: marked.jobUrl,
      };
      if (body.reason) {
        command.reason = body.reason;
      }
      return buildActionResponse(command, { status: "succeeded" }, { stage: marked.stage });
    });
  });

  app.post<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey/actions/mark-skipped", async (request, reply) => {
    const body = parseBody(reply, MarkJobActionRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) => {
      const marked = markJobSkipped(db, decodeRouteParam(request.params.jobKey), body);
      const command: ActionCommandPayload = {
        action: "mark_skipped" as const,
        jobKey: marked.jobUrl,
      };
      if (body.reason) {
        command.reason = body.reason;
      }
      return buildActionResponse(command, { status: "skipped" }, { stage: marked.stage });
    });
  });

  /**
   * Internal JSON-RPC 2.0 envelope endpoint (target §6.5).
   *
   * Stub for Phase 9 — proxies a JSON-RPC request body into the existing
   * action dispatcher.  Body must be a valid {@link JsonRpcRequest}; the
   * response is the matching {@link JsonRpcResponse}.  Method routing into
   * the Python worker subprocess happens in Phase 9 (S-34); for now the
   * endpoint validates the envelope shape and returns a placeholder.
   */
  app.post("/v1/_internal/rpc", async (request, reply) => {
    const parsed = JsonRpcRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      void reply.code(400);
      const id =
        typeof request.body === "object" && request.body !== null && "id" in request.body
          ? ((request.body as { id?: unknown }).id ?? null)
          : null;
      return {
        jsonrpc: "2.0",
        id: typeof id === "string" || typeof id === "number" || id === null ? id : null,
        error: {
          code: JsonRpcErrorCodes.InvalidRequest,
          message: "Invalid JSON-RPC envelope",
          data: parsed.error.message,
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id: parsed.data.id ?? null,
      result: {
        method: parsed.data.method,
        params: parsed.data.params,
        // Phase 9 will swap this stub for a real subprocess dispatch via
        // `defaultActionDispatcher`; for now the endpoint surface is in
        // place so consumers can compile against it.
        status: "accepted",
      },
    };
  });

  app.get("/v1/workflow-runs", async (request, reply) =>
    withDb(reply, options.dbPath, (db) =>
      listWorkflowRuns(db, WorkflowRunsListQuerySchema.parse(request.query)),
    ),
  );

  app.get("/v1/artifacts", async (request, reply) =>
    withDb(reply, options.dbPath, (db) => listArtifacts(db, ArtifactListQuerySchema.parse(request.query))),
  );

  app.get<{ Params: { artifactId: string } }>("/v1/artifacts/:artifactId", async (request, reply) =>
    withDb(reply, options.dbPath, (db) => {
      const detail = getArtifactDetail(db, decodeRouteParam(request.params.artifactId));
      if (!detail) {
        void reply.code(404);
        return { ok: false, error: "artifact_not_found" };
      }
      return detail;
    }),
  );

  app.post<{ Params: { artifactId: string } }>("/v1/artifacts/:artifactId/open", async (request, reply) => {
    const detail = withDb(reply, options.dbPath, (db) => getArtifactDetail(db, decodeRouteParam(request.params.artifactId)));
    if (!detail) {
      void reply.code(404);
      return { ok: false, error: "artifact_not_found" };
    }
    if ("ok" in detail && detail.ok === false) {
      return detail;
    }
    if (!fs.existsSync(detail.artifact.localPath) || !fs.statSync(detail.artifact.localPath).isFile()) {
      void reply.code(404);
      return { ok: false, error: "artifact_missing" };
    }
    await artifactOpener(detail.artifact.localPath);
    return {
      ok: true,
      artifact: detail.artifact,
      opened: true,
      path: detail.artifact.localPath,
    };
  });

  app.get("/v1/profile", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) =>
      readProfileConfig(db, {
        profilePath: options.profilePath,
        resumeStylePath: options.resumeStylePath,
        resumeTemplatePath: options.resumeTemplatePath,
      }),
    ),
  );

  app.get("/v1/profile/preview.pdf", async (_request, reply) => {
    try {
      const profileConfig = withDb(reply, options.dbPath, (db) =>
        readProfileConfig(db, {
          profilePath: options.profilePath,
          resumeStylePath: options.resumeStylePath,
          resumeTemplatePath: options.resumeTemplatePath,
        }),
      );
      if ("ok" in profileConfig && profileConfig.ok === false) {
        return profileConfig;
      }
      const pdfBytes = await profilePreviewRenderer(
        {
          profile: profileConfig.profile,
          templateText: profileConfig.templateText,
        },
        actionContext,
      );
      return reply
        .header("content-type", "application/pdf")
        .header("cache-control", "no-store")
        .send(pdfBytes);
    } catch (error) {
      void reply.code(500);
      return {
        ok: false,
        error: "profile_preview_failed",
        message: error instanceof Error ? error.message : "Unable to render profile preview.",
      };
    }
  });

  app.patch("/v1/profile", async (request, reply) => {
    const body = parseBody(reply, ProfileUpdateRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    if (!databaseExists(options.dbPath)) {
      void reply.code(503);
      return { ok: false, error: "db_not_found", message: `No JobHunter database found at ${options.dbPath}` };
    }
    const db = openDatabase(options.dbPath);
    try {
      return writeProfileConfig(
        db,
        {
          profilePath: options.profilePath,
          resumeStylePath: options.resumeStylePath,
          resumeTemplatePath: options.resumeTemplatePath,
        },
        body,
      );
    } catch (error) {
      if (error instanceof InputError || error instanceof ProfileInputError) {
        void reply.code(400);
        return { ok: false, error: "invalid_profile", message: error.message };
      }
      throw error;
    } finally {
      db.close();
    }
  });

  app.post("/v1/profile/import-resume", async (request, reply) => {
    const body = parseBody(reply, ProfileImportRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    try {
      const pdfBytes = decodeBase64Pdf(body.pdfBase64);
      const draft = await profileImporter(
        {
          filename: body.filename,
          pdfBytes,
          importProfile: body.importProfile,
          importStyle: body.importStyle,
        },
        actionContext,
      );
      return { ok: true, ...draft };
    } catch (error) {
      if (error instanceof InputError) {
        void reply.code(400);
        return { ok: false, error: "invalid_profile_import", message: error.message };
      }
      throw error;
    }
  });

  app.get("/v1/settings", async () => readSettingsConfig({ settingsPath: options.settingsPath }));

  app.patch("/v1/settings", async (request, reply) => {
    const body = parseBody(reply, SettingsUpdateRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    try {
      return writeSettingsConfig({ settingsPath: options.settingsPath }, body);
    } catch (error) {
      if (error instanceof InputError) {
        void reply.code(400);
        return { ok: false, error: "invalid_settings", message: error.message };
      }
      throw error;
    }
  });

  app.get("/v1/credentials", async () => credentialStore.list());

  app.patch("/v1/credentials", async (request, reply) => {
    const body = parseBody(reply, CredentialUpdateRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return credentialStore.set(body.key, body.value);
  });

  app.delete<{ Params: { key: string } }>("/v1/credentials/:key", async (request, reply) => {
    const key = decodeRouteParam(request.params.key);
    if (!CredentialKeys.includes(key as (typeof CredentialKeys)[number])) {
      void reply.code(400);
      return { ok: false, error: "invalid_credential_key" };
    }
    return credentialStore.delete(key as (typeof CredentialKeys)[number]);
  });

  return app;
}

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function unsupportedPerJobMaterialAction(jobKey?: string): {
  ok: false;
  accepted: false;
  error: string;
  jobKey?: string;
  message: string;
} {
  return {
    ok: false,
    accepted: false,
    error: "unsupported_per_job_material_action",
    ...(jobKey ? { jobKey } : {}),
    message: "Per-job material generation is disabled until targeted stage execution is implemented.",
  };
}

function withDb<T>(
  reply: { code: (statusCode: number) => unknown },
  dbPath: string,
  read: (db: ReturnType<typeof openDatabase>) => T,
): T | { ok: false; error: string; message: string } {
  if (!databaseExists(dbPath)) {
    void reply.code(503);
    return { ok: false, error: "db_not_found", message: `No JobHunter database found at ${dbPath}` };
  }

  // Phase 9 (S-33): read endpoints maintain the projection tables
  // (refreshProjections runs at the top of every read-model call), so
  // they need a writable connection.  Read-only mode is preserved for
  // explicitly read-only callers via openReadOnlyDatabase, but the
  // read-model uses the writable path so the canonical projections
  // stay current with new ``job_events`` rows from the worker.
  let db: ReturnType<typeof openDatabase> | null = null;
  try {
    db = openDatabase(dbPath);
    return read(db);
  } catch (error) {
    if (error instanceof ProfileInputError) {
      void reply.code(400);
      return {
        ok: false,
        error: "invalid_profile",
        message: error.message,
      };
    }
    const opened = db !== null;
    void reply.code(opened ? 500 : 503);
    return {
      ok: false,
      error: opened ? "db_read_failed" : "db_open_failed",
      message: error instanceof Error ? error.message : "Unable to read the JobHunter database.",
    };
  } finally {
    db?.close();
  }
}

async function withWritableDb<T>(
  reply: { code: (statusCode: number) => unknown },
  dbPath: string,
  write: (db: ReturnType<typeof openDatabase>) => T | Promise<T>,
): Promise<T | { ok: false; error: string; message: string }> {
  if (!databaseExists(dbPath)) {
    void reply.code(503);
    return { ok: false, error: "db_not_found", message: `No JobHunter database found at ${dbPath}` };
  }

  let db: ReturnType<typeof openDatabase> | null = null;
  try {
    db = openDatabase(dbPath);
    return await write(db);
  } catch (error) {
    if (error instanceof InputError) {
      void reply.code(404);
      return { ok: false, error: "not_found", message: error.message };
    }
    void reply.code(500);
    return {
      ok: false,
      error: "db_write_failed",
      message: error instanceof Error ? error.message : "Unable to write the JobHunter database.",
    };
  } finally {
    db?.close();
  }
}

function parseBody<T>(reply: { code: (statusCode: number) => unknown }, schema: ZodType<T>, body: unknown): T | null {
  const parsed = schema.safeParse(body);
  if (parsed.success) {
    return parsed.data;
  }
  void reply.code(400);
  return null;
}

function stageRunStatus(actions: ActionRunResponse[]): string {
  if (actions.length === 0) {
    return "accepted";
  }
  const statuses = actions.map((action) => action.status);
  if (statuses.some((status) => status === "failed")) {
    return "failed";
  }
  const firstStatus = statuses[0];
  if (!firstStatus) {
    return "accepted";
  }
  if (statuses.every((status) => status === firstStatus)) {
    return firstStatus;
  }
  return "accepted";
}

function resolveExistingJob(
  reply: { code: (statusCode: number) => unknown },
  db: ReturnType<typeof openDatabase>,
  jobKey: string,
): string | null {
  const jobUrl = resolveJobUrl(db, jobKey);
  if (!jobUrl) {
    void reply.code(404);
    return null;
  }
  return jobUrl;
}

function decodeBase64Pdf(value: string): Buffer {
  const normalized = value.replace(/\s/g, "");
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new InputError("Uploaded PDF payload must be base64 encoded.");
  }
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length === 0) {
    throw new InputError("Uploaded PDF is empty.");
  }
  if (bytes.length > 12 * 1024 * 1024) {
    throw new InputError("Uploaded PDF must be 12MB or smaller.");
  }
  return bytes;
}
