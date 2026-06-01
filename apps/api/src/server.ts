import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { type ZodType } from "zod";

import {
  type ActionCommandPayload,
  type ActionRunResponse,
  ActivityListQuerySchema,
  ApplyReviewDecisionRequestSchema,
  ApplyJobRequestSchema,
  ArtifactListQuerySchema,
  BulkJobMutationRequestSchema,
  BulkRescoreJobsNotOnCurrentScoringPolicyRequestSchema,
  BulkRetailorCurrentPolicyRequestSchema,
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
  ManualApplicationOutcomeRequestSchema,
  ManualCaptureDismissSchema,
  ManualCaptureImportSchema,
  OutcomeSuggestionDecisionRequestSchema,
  ProfileImportRequestSchema,
  type ProfileConfigResponse,
  ProfileUpdateRequestSchema,
  QuarantineDecisionSchema,
  RescoreJobRequestSchema,
  ResetStaleScoresForRescoreRequestSchema,
  RetryStageRequestSchema,
  RoleMatchFeedbackDecisionSchema,
  RetailorJobRequestSchema,
  RunPipelineStagesRequestSchema,
  SettingsUpdateRequestSchema,
  SourceLocatorDecisionSchema,
  SourceStatePatchSchema,
  SourceUpsertRequestSchema,
  type Stage,
  WorkflowRunsListQuerySchema,
} from "./contracts.js";
import {
  decideOutcomeSuggestion,
  listApplicationOutcomes,
  listApplyReviewQueue,
  listJobApplicationOutcomes,
  recordApplyReviewDecision,
  recordManualApplicationOutcome,
} from "./application-feedback.js";
import { databaseExists, openDatabase } from "./db.js";
import {
  decideQuarantineEntry,
  dismissManualCapture,
  decideRoleMatchFeedbackSuggestion,
  listManualCaptureQueue,
  listQuarantine,
  listRoleMatchFeedbackSuggestions,
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
  getActivityEvent,
  getArtifactDetail,
  getJobDetail,
  listActivity,
  listArtifacts,
  listJobs,
  listWorkflowRuns,
  readSettingsConfig,
} from "./read-model.js";
import { isTrustedMutationSource, LOCAL_CORS_METHODS, LOCAL_ORIGIN_PATTERNS } from "./local-origin.js";
import {
  ProfileInputError,
  parseProfileUpdateProfile,
  readProfileConfig,
  writeProfileConfig,
} from "./profile-store.js";
import { validateProfileTargetPlaces, type PlaceValidator } from "./place-validation.js";
import {
  handleProfileUpdatedEvent,
  hasRetailorableResumes,
  profileChangedSections,
  recordProfileUpdatedEvent,
  shouldRetailorForProfileUpdate,
} from "./profile-events.js";
import { dbFileIdentity, readWorkerHealth } from "./worker-health.js";
import {
  cancelJobAction,
  correctScore,
  hideJob,
  hideJobs,
  InputError,
  markJobApplied,
  markJobSkipped,
  permanentlyDeleteJob,
  permanentlyDeleteJobs,
  resetJobStage,
  retryFailedJobs,
  restoreJob,
  restoreJobs,
  resetStaleScoresForRescore,
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
  placeValidator?: PlaceValidator;
  profileImporter?: ProfileImporter;
  profilePreviewRenderer?: ProfilePreviewRenderer;
  requireHealthyWorkerForActions?: boolean;
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
  const actionContext = { appDir, dbPath: options.dbPath };
  const requireHealthyWorkerForActions =
    options.requireHealthyWorkerForActions ?? !options.actionDispatcher;

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
    appDir,
    dbExists: databaseExists(options.dbPath),
    dbIdentity: dbFileIdentity(options.dbPath),
    worker: readWorkerHealth(options.dbPath),
  }));

  registerEventStreamRoute(app, { dbPath: options.dbPath });

  app.get("/v1/dashboard/summary", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) => buildDashboardSummary(db)),
  );

  app.get("/v1/debug/activity", async (request, reply) =>
    withDb(reply, options.dbPath, (db) => listActivity(db, ActivityListQuerySchema.parse(request.query))),
  );

  app.get<{ Params: { eventId: string } }>("/v1/debug/activity/:eventId", async (request, reply) =>
    withDb(reply, options.dbPath, (db) => {
      const event = getActivityEvent(db, decodeRouteParam(request.params.eventId));
      if (!event) {
        void reply.code(404);
        return { ok: false, error: "activity_event_not_found" };
      }
      return { ok: true, event };
    }),
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

  app.get("/v1/discovery/role-match-feedback", async (_request, reply) =>
    withWritableDb(reply, options.dbPath, (db) => listRoleMatchFeedbackSuggestions(db)),
  );

  app.post<{ Params: { suggestionId: string } }>(
    "/v1/discovery/role-match-feedback/:suggestionId/decision",
    async (request, reply) => {
      const body = parseBody(reply, RoleMatchFeedbackDecisionSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      return withWritableDb(reply, options.dbPath, (db) =>
        decideRoleMatchFeedbackSuggestion(
          db,
          decodeRouteParam(request.params.suggestionId),
          body,
        ),
      );
    },
  );

  app.post("/v1/pipeline/actions/run-stage", async (request, reply) => {
    const body = parseBody(reply, RunPipelineStagesRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    const actions: ActionRunResponse[] = [];
    const firstStage = body.stages[0] as Stage | undefined;
    if (!firstStage) {
      void reply.code(400);
      return undefined;
    }
    const command: ActionCommandPayload = {
      action: "run_stage" as const,
      jobKey: PIPELINE_ACTION_JOB_KEY,
      stage: firstStage,
      stages: body.stages,
      limit: body.limit,
      workers: body.workers,
      minScore: body.minScore,
      validationMode: body.validationMode,
      dryRun: body.dryRun,
      rescore: body.rescore,
      retailor: body.retailor,
      headless: body.headless,
      model: body.model,
      llmModel: body.llmModel,
      tailorModels: body.tailorModels,
      continuous: body.continuous,
    };
    if (body.tailorJudgeModel) {
      command.tailorJudgeModel = body.tailorJudgeModel;
    }
    if (body.tailorJudgeMinScore !== undefined) {
      command.tailorJudgeMinScore = body.tailorJudgeMinScore;
    }
    const workerReady = requireWorkerReady(reply, options.dbPath, requireHealthyWorkerForActions);
    if (!workerReady) {
      return undefined;
    }
    const dispatch = await actionDispatcher(command, actionContext);
    actions.push(buildActionResponse(command, dispatch));
    const status = stageRunStatus(actions);
    void reply.code(dispatch.status === "queued" && status !== "failed" ? 202 : 200);
    return {
      ok: true,
      action: "run_stage",
      status,
      jobKey: PIPELINE_ACTION_JOB_KEY,
      count: actions.length,
      command: body,
      actions,
    } satisfies PipelineStageRunResponse;
  });

  app.get("/v1/jobs", async (request, reply) =>
    withDb(reply, options.dbPath, (db) => listJobs(db, JobListQuerySchema.parse(request.query))),
  );

  app.get("/v1/apply/review-queue", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) => listApplyReviewQueue(db)),
  );

  app.get("/v1/outcomes", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) => listApplicationOutcomes(db)),
  );

  app.post("/v1/jobs/bulk-delete", async (request, reply) => {
    const body = parseBody(reply, BulkJobMutationRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) => softDeleteJobs(db, body));
  });

  app.post("/v1/jobs/bulk-delete-permanent", async (request, reply) => {
    const body = parseBody(reply, BulkJobMutationRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) => permanentlyDeleteJobs(db, body));
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

  app.post("/v1/jobs/bulk-retry-failed", async (request, reply) => {
    const body = parseBody(reply, BulkJobMutationRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) => retryFailedJobs(db, body));
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
    "/v1/jobs/:jobKey/apply-review/decision",
    async (request, reply) => {
      const body = parseBody(reply, ApplyReviewDecisionRequestSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      return withWritableDb(reply, options.dbPath, (db) =>
        recordApplyReviewDecision(db, decodeRouteParam(request.params.jobKey), body),
      );
    },
  );

  app.get<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey/outcomes", async (request, reply) =>
    withDb(reply, options.dbPath, (db) => {
      const outcomes = listJobApplicationOutcomes(db, decodeRouteParam(request.params.jobKey));
      if (!outcomes) {
        void reply.code(404);
        return { ok: false, error: "job_not_found" };
      }
      return outcomes;
    }),
  );

  app.post<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey/outcomes", async (request, reply) => {
    const body = parseBody(reply, ManualApplicationOutcomeRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) =>
      recordManualApplicationOutcome(db, decodeRouteParam(request.params.jobKey), body),
    );
  });

  app.post<{ Params: { suggestionId: string } }>(
    "/v1/outcome-suggestions/:suggestionId/decision",
    async (request, reply) => {
      const body = parseBody(reply, OutcomeSuggestionDecisionRequestSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      return withWritableDb(reply, options.dbPath, (db) =>
        decideOutcomeSuggestion(db, decodeRouteParam(request.params.suggestionId), body),
      );
    },
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

  app.post("/v1/scoring/stale-scores/actions/reset-for-rescore", async (request, reply) => {
    const body = parseBody(reply, ResetStaleScoresForRescoreRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) => resetStaleScoresForRescore(db, body));
  });

  app.post<{ Params: { jobKey: string } }>(
    "/v1/jobs/:jobKey/actions/rescore-current-policy",
    async (request, reply) => {
      const body = parseBody(reply, RescoreJobRequestSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      const outcome = await withWritableDb(reply, options.dbPath, async (db) => {
        const jobUrl = resolveExistingJob(reply, db, decodeRouteParam(request.params.jobKey));
        if (!jobUrl) {
          return { ok: false, error: "job_not_found" };
        }
        const command: ActionCommandPayload = {
          action: "rescore_job",
          jobKey: jobUrl,
          dryRun: body.dryRun,
        };
        if (body.reason) command.reason = body.reason;
        const workerReady = requireWorkerReady(reply, options.dbPath, requireHealthyWorkerForActions);
        if (!workerReady) {
          return undefined;
        }
        const dispatch = await actionDispatcher(command, actionContext);
        void reply.code(202);
        return buildActionResponse(command, dispatch);
      });
      return outcome;
    },
  );

  app.post("/v1/scoring/actions/rescore-current-policy", async (request, reply) => {
    const body = parseBody(reply, BulkRescoreJobsNotOnCurrentScoringPolicyRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    const command: ActionCommandPayload = {
      action: "rescore_jobs_not_on_current_scoring_policy",
      jobKey: PIPELINE_ACTION_JOB_KEY,
      jobKeys: body.jobKeys,
      limit: body.limit,
      dryRun: body.dryRun,
    };
    if (body.reason) command.reason = body.reason;
    const workerReady = requireWorkerReady(reply, options.dbPath, requireHealthyWorkerForActions);
    if (!workerReady) {
      return undefined;
    }
    const dispatch = await actionDispatcher(command, actionContext);
    void reply.code(202);
    return buildActionResponse(command, dispatch);
  });

  app.delete<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey", async (request, reply) => {
    const body = parseBody(reply, DeleteJobRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) => softDeleteJob(db, decodeRouteParam(request.params.jobKey), body));
  });

  app.delete<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey/permanent", async (request, reply) =>
    withWritableDb(reply, options.dbPath, (db) => permanentlyDeleteJob(db, decodeRouteParam(request.params.jobKey))),
  );

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
      if (body.runAfter) {
        const workerReady = requireWorkerReady(reply, options.dbPath, requireHealthyWorkerForActions);
        if (!workerReady) {
          return undefined;
        }
      }
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

  app.post<{ Params: { jobKey: string } }>(
    "/v1/jobs/:jobKey/actions/retailor-current-policy",
    async (request, reply) => {
      const body = parseBody(reply, RetailorJobRequestSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      const outcome = await withWritableDb(reply, options.dbPath, async (db) => {
        const jobUrl = resolveExistingJob(reply, db, decodeRouteParam(request.params.jobKey));
        if (!jobUrl) {
          return { ok: false, error: "job_not_found" };
        }
        const command: ActionCommandPayload = {
          action: "retailor_job",
          jobKey: jobUrl,
          dryRun: body.dryRun,
          suppressExistingArtifacts: body.suppressExistingArtifacts,
          tailorModels: body.tailorModels,
        };
        if (body.reason) command.reason = body.reason;
        if (body.tailorJudgeModel) command.tailorJudgeModel = body.tailorJudgeModel;
        if (body.tailorJudgeMinScore !== undefined) {
          command.tailorJudgeMinScore = body.tailorJudgeMinScore;
        }
        const workerReady = requireWorkerReady(reply, options.dbPath, requireHealthyWorkerForActions);
        if (!workerReady) {
          return undefined;
        }
        const dispatch = await actionDispatcher(command, actionContext);
        void reply.code(202);
        return buildActionResponse(command, dispatch);
      });
      return outcome;
    },
  );

  app.post("/v1/materials/actions/retailor-current-policy", async (request, reply) => {
    const body = parseBody(reply, BulkRetailorCurrentPolicyRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    const command: ActionCommandPayload = {
      action: "retailor_current_policy",
      jobKey: PIPELINE_ACTION_JOB_KEY,
      jobKeys: body.jobKeys,
      limit: body.limit,
      dryRun: body.dryRun,
      suppressExistingArtifacts: body.suppressExistingArtifacts,
      tailorModels: body.tailorModels,
    };
    if (body.reason) command.reason = body.reason;
    if (body.tailorJudgeModel) command.tailorJudgeModel = body.tailorJudgeModel;
    if (body.tailorJudgeMinScore !== undefined) {
      command.tailorJudgeMinScore = body.tailorJudgeMinScore;
    }
    const workerReady = requireWorkerReady(reply, options.dbPath, requireHealthyWorkerForActions);
    if (!workerReady) {
      return undefined;
    }
    const dispatch = await actionDispatcher(command, actionContext);
    void reply.code(202);
    return buildActionResponse(command, dispatch);
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
      const workerReady = requireWorkerReady(reply, options.dbPath, requireHealthyWorkerForActions);
      if (!workerReady) {
        return undefined;
      }
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

  app.get<{ Params: { artifactId: string } }>("/v1/artifacts/:artifactId/preview.pdf", async (request, reply) => {
    const detail = withDb(reply, options.dbPath, (db) => getArtifactDetail(db, decodeRouteParam(request.params.artifactId)));
    if (!detail) {
      void reply.code(404);
      return { ok: false, error: "artifact_not_found" };
    }
    if ("ok" in detail && detail.ok === false) {
      return detail;
    }
    if (!isPdfArtifact(detail.artifact.type, detail.artifact.localPath)) {
      void reply.code(415);
      return { ok: false, error: "artifact_preview_unsupported" };
    }
    if (!fs.existsSync(detail.artifact.localPath) || !fs.statSync(detail.artifact.localPath).isFile()) {
      void reply.code(404);
      return { ok: false, error: "artifact_missing" };
    }

    return reply
      .type("application/pdf")
      .header("cache-control", "no-store")
      .header(
        "content-disposition",
        `inline; filename="${path.basename(detail.artifact.localPath).replaceAll('"', "")}"`,
      )
      .send(fs.createReadStream(detail.artifact.localPath));
  });

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
    try {
      const nextProfile = parseProfileUpdateProfile(body);
      if (nextProfile) {
        await validateProfileTargetPlaces(nextProfile, options.placeValidator);
      }
    } catch (error) {
      if (error instanceof ProfileInputError) {
        void reply.code(400);
        return { ok: false, error: "invalid_profile", message: error.message };
      }
      throw error;
    }
    const db = openDatabase(options.dbPath);
    let profileResponse: ProfileConfigResponse | undefined;
    let profileUpdatedEvent: ReturnType<typeof recordProfileUpdatedEvent> = null;
    let queueRetailor = false;
    try {
      profileResponse = writeProfileConfig(
        db,
        {
          profilePath: options.profilePath,
          resumeStylePath: options.resumeStylePath,
          resumeTemplatePath: options.resumeTemplatePath,
        },
        body,
      );
      profileUpdatedEvent = recordProfileUpdatedEvent(db, profileChangedSections(body));
      queueRetailor = shouldRetailorForProfileUpdate(body) && hasRetailorableResumes(db);
    } catch (error) {
      if (error instanceof InputError || error instanceof ProfileInputError) {
        void reply.code(400);
        return { ok: false, error: "invalid_profile", message: error.message };
      }
      throw error;
    } finally {
      db.close();
    }
    if (profileUpdatedEvent && queueRetailor) {
      try {
        const workerHealth = readWorkerHealth(options.dbPath);
        if (requireHealthyWorkerForActions && workerHealth.status !== "healthy") {
          request.log.warn(
            { workerHealth },
            "Skipped profile-update re-tailoring run because the worker runtime is not healthy",
          );
        } else {
          await handleProfileUpdatedEvent(profileUpdatedEvent, actionDispatcher, actionContext);
        }
      } catch (error) {
        request.log.error({ err: error }, "Failed to dispatch profile-update re-tailoring run");
      }
    }
    return profileResponse;
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

function requireWorkerReady(reply: FastifyReply, dbPath: string, enabled: boolean): boolean {
  if (!enabled) {
    return true;
  }
  const worker = readWorkerHealth(dbPath);
  if (worker.status === "healthy") {
    return true;
  }
  void reply.code(503).send({
    ok: false,
    error: "worker_runtime_unavailable",
    message: worker.message,
    worker,
  });
  return false;
}

function isPdfArtifact(artifactType: string, localPath: string): boolean {
  return artifactType.toLowerCase().endsWith("_pdf") || localPath.toLowerCase().endsWith(".pdf");
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
