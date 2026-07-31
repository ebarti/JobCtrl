import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type ZodType } from "zod";

import {
  type ActionCommandPayload,
  type ActionRunResponse,
  ActivityListQuerySchema,
  ApplyReviewDecisionRequestSchema,
  ApplyJobRequestSchema,
  RepeatApplicationOverrideRequestSchema,
  ArtifactListQuerySchema,
  BulkJobMutationRequestSchema,
  type BulkRunPendingPreparationRequest,
  BulkRunPendingPreparationRequestSchema,
  type BulkRunPendingPreparationResponse,
  type BulkRetryFailedRequest,
  BulkRetryFailedRequestSchema,
  type BulkRetryFailedResponse,
  BulkRescoreJobsNotOnCurrentScoringPolicyRequestSchema,
  BulkRetailorCurrentPolicyRequestSchema,
  BrowserCapabilityIds,
  BrowserCapabilityEnableRequestSchema,
  BrowserCapabilitiesResultSchema,
  BrowserProfileCopyRequestSchema,
  CancelJobActionRequestSchema,
  CompensationSourcePolicyUpdateRequestSchema,
  CorrectScoreRequestSchema,
  PIPELINE_ACTION_JOB_KEY,
  type PipelineStageRunResponse,
  CredentialKeys,
  CredentialBatchUpdateRequestSchema,
  CredentialUpdateRequestSchema,
  CodexVerifyResultSchema,
  DeleteJobRequestSchema,
  DigestAcknowledgeRequestSchema,
  DiscoverySettingsUpdateRequestSchema,
  DiscoveryFeedbackRequestSchema,
  GenerateMaterialsRequestSchema,
  GenerateInterviewPrepRequestSchema,
  GmailOutcomeScanRequestSchema,
  EnsureCurrentResumeMaterialsRequestSchema,
  JobResumeTemplateAssignmentRequestSchema,
  JobListQuerySchema,
  JsonRpcErrorCodes,
  JsonRpcRequestSchema,
  MarkJobActionRequestSchema,
  ManualApplicationOutcomeRequestSchema,
  ManualCaptureDismissSchema,
  ManualCaptureImportSchema,
  OutcomeSuggestionDecisionRequestSchema,
  ExtensionCaptureIngestSchema,
  ProfileImportRequestSchema,
  type ProfileConfigResponse,
  ProfileUpdateRequestSchema,
  type ProviderModelCatalogItem,
  ProviderModelCatalogResultSchema,
  ProviderStatusResultSchema,
  QuarantineDecisionSchema,
  RescoreJobRequestSchema,
  RefreshCompensationRequestSchema,
  ResetStaleScoresForRescoreRequestSchema,
  RetryStageRequestSchema,
  RunJobStageRequestSchema,
  RoleMatchFeedbackDecisionSchema,
  RetailorJobRequestSchema,
  ResumeTemplateDefaultSelectionRequestSchema,
  ResumeTemplateVersionSaveRequestSchema,
  ResumeCommentReplyRequestSchema,
  ResumeReviewCommentThreadSeedRequestSchema,
  ResumeReviewDraftCreateRequestSchema,
  ResumeReviewDraftRenderRequestSchema,
  ResumeReviewDraftRevisionSaveRequestSchema,
  RunPipelineStagesRequestSchema,
  SettingsUpdateRequestSchema,
  type ExtensionCapabilityTokenResponse,
  type ExtensionAuthStatusResponse,
  type ExtensionAutofillProfileResponse,
  type ExtensionCaptureIngestRequest,
  type ManualCaptureImportRequest,
  SourceLocatorDecisionSchema,
  SourceStatePatchSchema,
  SourceUpsertRequestSchema,
  STAGES,
  TailorJobRequestSchema,
  type Stage,
  WorkflowRunsListQuerySchema,
  ContactCreateRequestSchema,
  ContactUpdateRequestSchema,
  ContactImportRequestSchema,
  ContactListQuerySchema,
  ContactDeleteRequestSchema,
  ConfirmContactCandidateRequestSchema,
  ContactResearchListQuerySchema,
  RunContactResearchRequestSchema,
  GenerateOutreachDraftRequestSchema,
  ReviseOutreachDraftRequestSchema,
  RejectOutreachDraftRequestSchema,
  LogOutreachSendRequestSchema,
  ScheduleFollowUpRequestSchema,
  OutreachThreadQuerySchema,
} from "./contracts.js";
import {
  ContactInputError,
  ContactNotFoundError,
  createContact,
  deleteContact,
  getContactDetail,
  importContacts,
  listContacts,
  updateContact,
} from "./contacts.js";
import {
  ContactResearchInputError,
  ContactResearchNotFoundError,
  confirmContactCandidate,
  createQueuedResearchTask,
  getResearchTaskDetail,
  listResearchTasks,
} from "./contact-research.js";
import {
  OutreachDraftGatesNotPassedError,
  OutreachInputError,
  OutreachNotFoundError,
  approveOutreachDraft,
  completeOutreachFollowUp,
  dismissOutreachFollowUp,
  findOutreachThreadIdForContact,
  getDueFollowUps,
  getOutreachThreadDetail,
  getOutreachThreadForContact,
  logOutreachSend,
  rejectOutreachDraft,
  scheduleOutreachFollowUp,
} from "./outreach.js";
import {
  decideOutcomeSuggestion,
  listApplicationOutcomes,
  listApplyReviewQueue,
  listJobApplicationOutcomes,
  recordApplyReviewDecision,
  recordManualApplicationOutcome,
} from "./application-feedback.js";
import {
  CompensationSourcePolicyInputError,
  listCompensationSources,
  readCompensationSourcePreferences,
  updateCompensationSourcePolicy,
} from "./compensation-source-policy.js";
import { databaseExists, openDatabase } from "./db.js";
import { ConfigFileInputError } from "./config-file.js";
import { getMarketCompensationEstimate } from "./market-compensation-estimates.js";
import { getPostedCompensationFact } from "./posted-compensation-facts.js";
import {
  decideQuarantineEntry,
  dismissManualCapture,
  decideRoleMatchFeedbackSuggestion,
  listManualCaptureQueue,
  listQuarantine,
  listRoleMatchFeedbackSuggestions,
  readDiscoverySettings,
  listSourceLocatorCandidates,
  listSourceRegistry,
  patchSourceState,
  previewDiscoverySource,
  promoteSourceLocatorCandidate,
  recordDiscoveryFeedback,
  rejectSourceLocatorCandidate,
  seedExtensionManualCapture,
  upsertSourceRegistryEntry,
  writeDiscoverySettings,
} from "./discovery-controls.js";
import { registerEventStreamRoute } from "./event-stream.js";
import {
  assertLiveApplicationMayDispatch,
  recordRepeatApplicationOverride,
} from "./repeat-application.js";
import {
  ensureLocalCapabilityToken,
  isAuthorizedLocalCapabilityToken,
  rotateLocalCapabilityToken,
} from "./extension-auth.js";
import {
  CredentialStoreUnavailableError,
  CredentialManagedByEnvironmentError,
  KeychainCredentialStore,
  type CredentialStore,
} from "./credentials.js";
import {
  type ActionDispatchResult,
  buildActionResponse,
  createActionDispatcher,
  createContactResearchStarter,
  createOutreachDraftGenerator,
  createProfileImporter,
  createProfilePreviewRenderer,
  createRuntimeJsonRpcDispatcherFactory,
  defaultArtifactOpener,
  type ActionDispatcher,
  type ArtifactOpener,
  type ContactResearchStarter,
  type OutreachDraftGenerator,
  type ProfilePreviewRenderer,
  type ProfileImporter,
} from "./local-actions.js";
import type { JsonRpcDispatcher } from "./json-rpc-adapter.js";
import {
  createWorkerManualCaptureImporter,
  ManualCaptureImportError,
  type ManualCaptureImporter,
} from "./manual-capture-worker.js";
import {
  createWorkerGmailFeedbackScanner,
  GmailFeedbackScanError,
  sanitizeGmailFeedbackScanResponse,
  type GmailFeedbackScanner,
} from "./gmail-feedback-worker.js";
import {
  acknowledgeDigest,
  buildDashboardSummary,
  buildOutcomeAnalyticsSummary,
  buildDigest,
  getActivityEvent,
  getArtifactDetail,
  getJobDetail,
  listActivity,
  listArtifacts,
  listEvidenceMap,
  listJobs,
  matchingJobKeys,
  listWorkflowRuns,
  getWorkflowRunDetail,
  readSettingsConfig,
} from "./read-model.js";
import { buildPipelineOperationsSnapshot } from "./pipeline-operations.js";
import { refreshProjections } from "./projections.js";
import { createResumeHtmlPdfRenderer, type ResumeHtmlPdfRenderer } from "./resume-pdf-render.js";
import {
  defaultSourcePythonRuntime,
  type PythonRuntimeCommandResolver,
} from "./python-runtime.js";
import {
  createOrLoadResumeReviewDraft,
  getResumeReviewDraftForJob,
  listResumeReviewFeedback,
  replyToResumeReviewComment,
  renderResumeReviewDraft,
  saveResumeReviewDraftRevision,
  seedResumeReviewCommentThreads,
} from "./resume-review-drafts.js";
import {
  createResumeTemplateVersion,
  ensureCurrentResumeTemplateMaterials,
  getResumeTemplateDetail,
  listResumeTemplates,
  ResumeTemplateInputError,
  resolveCurrentResumeArtifactIdForOpen,
  resolveEffectiveResumeTemplate,
  setDefaultResumeTemplate,
  setJobResumeTemplateAssignment,
} from "./resume-templates.js";
import {
  isLoopbackHostHeader,
  isLoopbackPeerAddress,
  isTrustedMutationSource,
  LOCAL_CORS_ALLOWED_HEADERS,
  LOCAL_CORS_METHODS,
  LOCAL_ORIGIN_PATTERNS,
  resolveExtensionCorsOrigin,
} from "./local-origin.js";
import {
  ProfileInputError,
  parseProfileUpdateProfile,
  readExtensionAutofillProfile,
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
import { dbFileIdentity, readLlmSpendHealth, readWorkerHealth } from "./worker-health.js";
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
  queueRetriedJobsForWorkflow,
  resetJobStage,
  retryFailedJobs,
  type RetryFailedJobTarget,
  restoreJob,
  restoreJobs,
  resolveJobId,
  resetStaleScoresForRescore,
  resolveJobUrl,
  softDeleteJob,
  softDeleteJobs,
  unhideJob,
  unhideJobs,
  writeSettingsConfig,
} from "./write-model.js";

const UNSAFE_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);
const APPLY_REVIEW_PRECONDITION_ERRORS = new Set([
  "awaiting_dry_run",
  "approval_stale_materials",
  "approval_stale_profile",
  "approval_stale_url",
  "approval_stale_email_candidate",
  "partial_override_evidence_invalid",
  "repeat_application_blocked",
  "repeat_application_confirmation_required",
  "repeat_application_override_consumed",
  "repeat_application_evidence_stale",
  "repeat_application_prior_mismatch",
  "repeat_application_confirmation_not_required",
]);
const TRUSTED_SEC_FETCH_SITE_VALUES = new Set(["same-origin", "none"]);
const LOOPBACK_ORIGIN_SEC_FETCH_SITE_VALUES = new Set(["same-origin", "same-site", "none"]);
const FIRST_PARTY_PAIRING_SEC_FETCH_SITE_VALUES = new Set(["same-origin", "same-site"]);
const EXTENSION_API_PREFIX = "/v1/extension/";
const EXTENSION_PAIRING_TOKEN_PATH = "/v1/extension/pairing-token";
const EXTENSION_PAIRING_TOKEN_ROTATE_PATH = "/v1/extension/pairing-token/rotate";
const SEC_FETCH_HEADER_NAMES = ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user"] as const;

export interface BuildAppOptions {
  appDir?: string;
  dbPath: string;
  configPath: string;
  /** Testable process environment for credential/native runtime boundaries. */
  runtimeEnvironment?: Readonly<Record<string, string | undefined>>;
  /** Absolute path to the prebuilt web root. Omit in source development. */
  webAssetsDir?: string;
  /** Private Python runtime command resolver. Defaults to source-checkout uv. */
  pythonRuntime?: PythonRuntimeCommandResolver;
  actionDispatcher?: ActionDispatcher;
  contactResearchStarter?: ContactResearchStarter;
  outreachDraftGenerator?: OutreachDraftGenerator;
  artifactOpener?: ArtifactOpener;
  credentialStore?: CredentialStore;
  /** Test seam for provider status and verification over the long-lived RPC worker. */
  providerDispatcher?: JsonRpcDispatcher;
  manualCaptureImporter?: ManualCaptureImporter;
  gmailFeedbackScanner?: GmailFeedbackScanner;
  placeValidator?: PlaceValidator;
  profileImporter?: ProfileImporter;
  profilePreviewRenderer?: ProfilePreviewRenderer;
  resumePdfRenderer?: ResumeHtmlPdfRenderer;
  requireHealthyWorkerForActions?: boolean;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  normalizeExistingDatabase(options.dbPath);
  const app = Fastify({ logger: options.logger ?? false, routerOptions: { maxParamLength: 4096 } });
  installVitestInjectMutationDefaults(app);
  const appDir = options.appDir ?? path.dirname(options.dbPath);
  const pythonRuntime = options.pythonRuntime ?? defaultSourcePythonRuntime;
  const actionContext = { appDir, dbPath: options.dbPath, configPath: options.configPath };
  const actionDispatcher =
    options.actionDispatcher ??
    createActionDispatcher(undefined, createRuntimeJsonRpcDispatcherFactory(pythonRuntime));
  const contactResearchStarter = options.contactResearchStarter ?? createContactResearchStarter(pythonRuntime);
  const outreachDraftGenerator = options.outreachDraftGenerator ?? createOutreachDraftGenerator(pythonRuntime);
  const artifactOpener = options.artifactOpener ?? defaultArtifactOpener;
  const credentialStore = options.credentialStore ?? new KeychainCredentialStore({
    env: options.runtimeEnvironment ?? process.env,
    configPath: options.configPath,
  });
  const providerDispatcher =
    options.providerDispatcher ??
    createRuntimeJsonRpcDispatcherFactory(pythonRuntime)(actionContext);
  const manualCaptureImporter =
    options.manualCaptureImporter ?? createWorkerManualCaptureImporter({ pythonRuntime });
  const gmailFeedbackScanner =
    options.gmailFeedbackScanner ?? createWorkerGmailFeedbackScanner({ pythonRuntime });
  const profileImporter = options.profileImporter ?? createProfileImporter(pythonRuntime);
  const profilePreviewRenderer = options.profilePreviewRenderer ?? createProfilePreviewRenderer(pythonRuntime);
  const resumePdfRenderer = options.resumePdfRenderer ?? createResumeHtmlPdfRenderer(pythonRuntime, appDir);
  const requireHealthyWorkerForActions =
    options.requireHealthyWorkerForActions ?? !options.actionDispatcher;
  ensureLocalCapabilityToken(appDir);

  void app.register(cors, {
    delegator: (request, callback) => {
      const extensionOrigin = isExtensionCorsPath(request.url)
        ? resolveExtensionCorsOrigin(request.headers.origin)
        : undefined;
      if (extensionOrigin) {
        callback(null, {
          origin: extensionOrigin,
          methods: LOCAL_CORS_METHODS,
          allowedHeaders: LOCAL_CORS_ALLOWED_HEADERS,
        });
        return;
      }
      callback(null, {
        origin: LOCAL_ORIGIN_PATTERNS,
        methods: LOCAL_CORS_METHODS,
      });
    },
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!isLoopbackHostHeader(request.headers.host)) {
      return reply.code(403).send({
        ok: false,
        error: "forbidden_host",
        message: "Requests must target a loopback host (127.0.0.1, localhost, or [::1]).",
      });
    }
    if (!isLoopbackPeerAddress(request.ip || request.raw.socket.remoteAddress)) {
      return reply.code(403).send({
        ok: false,
        error: "forbidden_remote_client",
        message: "Requests must originate from a loopback network address.",
      });
    }
    if (!UNSAFE_METHODS.has(request.method)) {
      if (!isAuthorizedExtensionApiRequest(request, appDir)) {
        return rejectInvalidExtensionToken(request, reply);
      }
      return;
    }
    const extensionTokenTrusted = hasTrustedExtensionToken(request, appDir);
    const localCapabilityTokenTrusted = hasTrustedLocalCapabilityToken(request, appDir);
    const capabilityTokenTrusted = extensionTokenTrusted || localCapabilityTokenTrusted;
    if (!capabilityTokenTrusted && !isTrustedMutationSource(request.headers.origin, request.headers.referer)) {
      return reply.code(403).send({
        ok: false,
        error: "cross_site_request",
        message: "Mutation requests require a first-party local Origin or Referer, or a local capability token.",
      });
    }
    if (
      !capabilityTokenTrusted &&
      !isTrustedSecFetchSite(request.headers["sec-fetch-site"], {
        allowLoopbackSameSite: true,
      })
    ) {
      return reply.code(403).send({
        ok: false,
        error: "cross_site_request",
        message: "Mutation requests require trusted Sec-Fetch-Site metadata.",
      });
    }
    if (!isAuthorizedExtensionApiRequest(request, appDir)) {
      return rejectInvalidExtensionToken(request, reply);
    }
    return;
  });

  app.get("/v1/health", async () => ({
    ok: true,
    dbPath: options.dbPath,
    appDir,
    dbExists: databaseExists(options.dbPath),
    dbIdentity: dbFileIdentity(options.dbPath),
    llmSpend: readLlmSpendHealth(options.dbPath, options.configPath),
    worker: readWorkerHealth(options.dbPath),
  }));

  app.get(EXTENSION_PAIRING_TOKEN_PATH, async (request, reply) => {
    if (!isTrustedExtensionPairingRequest(request)) {
      void reply.code(403);
      return { ok: false, error: "untrusted_extension_pairing_request" };
    }
    const token = ensureLocalCapabilityToken(appDir);
    void reply.header("cache-control", "no-store");
    return {
      ok: true,
      token: token.token,
      tokenPath: token.tokenPath,
      created: token.created,
    } satisfies ExtensionCapabilityTokenResponse;
  });

  app.post(EXTENSION_PAIRING_TOKEN_ROTATE_PATH, async (request, reply) => {
    if (!isTrustedExtensionPairingRequest(request)) {
      void reply.code(403);
      return { ok: false, error: "untrusted_extension_pairing_request" };
    }
    const token = rotateLocalCapabilityToken(appDir);
    void reply.header("cache-control", "no-store");
    return {
      ok: true,
      token: token.token,
      tokenPath: token.tokenPath,
      created: token.created,
    } satisfies ExtensionCapabilityTokenResponse;
  });

  app.get("/v1/extension/auth/status", async (): Promise<ExtensionAuthStatusResponse> => extensionAuthStatus());
  app.post("/v1/extension/auth/status", async (): Promise<ExtensionAuthStatusResponse> => extensionAuthStatus());

  app.get(
    "/v1/extension/autofill/profile",
    async (_request, reply): Promise<ExtensionAutofillProfileResponse | { ok: false; error: string; message: string }> =>
      withDb(reply, options.dbPath, (db) => readExtensionAutofillProfile(db)),
  );

  app.post("/v1/extension/captures", async (request, reply) => {
    const body = parseBody(reply, ExtensionCaptureIngestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    if (!databaseExists(options.dbPath)) {
      void reply.code(503);
      return { ok: false, error: "db_not_found", message: `No JobCtrl database found at ${options.dbPath}` };
    }
    const seeded = await withWritableDb(reply, options.dbPath, (db) => seedExtensionManualCapture(db, body));
    if (!seeded || "ok" in seeded) {
      return seeded;
    }
    try {
      return await manualCaptureImporter(seeded.itemId, extensionCaptureToManualCapture(body), {
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
  });

  registerEventStreamRoute(app, { dbPath: options.dbPath });

  app.get("/v1/dashboard/summary", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) => buildDashboardSummary(db)),
  );

  app.get("/v1/pipeline/operations", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) =>
      buildPipelineOperationsSnapshot(db, {
        dbPath: options.dbPath,
        configPath: options.configPath,
      }),
    ),
  );

  app.get("/v1/analytics/outcomes", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) => buildOutcomeAnalyticsSummary(db)),
  );

  app.get("/v1/digest", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) => {
      const discoverySettings = readDiscoverySettings(db).settings;
      return buildDigest(db, {
        applyReviewQueue: listApplyReviewQueue(db),
        budget: readLlmSpendHealth(options.dbPath, options.configPath),
        minFitScore: discoverySettings.minFitScore,
      });
    }),
  );

  app.post("/v1/digest/acknowledge", async (request, reply) => {
    const body = parseBody(reply, DigestAcknowledgeRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) => acknowledgeDigest(db, body));
  });

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

  app.get("/v1/discovery/settings", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) => readDiscoverySettings(db)),
  );

  app.get("/v1/compensation/sources", async () =>
    listCompensationSources(readCompensationSourcePreferences(options.configPath)),
  );

  app.patch("/v1/compensation/sources", async (request, reply) => {
    const body = parseBody(
      reply,
      CompensationSourcePolicyUpdateRequestSchema,
      request.body ?? {},
    );
    if (!body) {
      return undefined;
    }
    try {
      return updateCompensationSourcePolicy(
        options.configPath,
        body,
      );
    } catch (error) {
      if (error instanceof CompensationSourcePolicyInputError) {
        void reply.code(400);
        return {
          ok: false,
          error: "invalid_compensation_source_settings",
          message: error.message,
        };
      }
      throw error;
    }
  });

  app.patch("/v1/discovery/settings", async (request, reply) => {
    const body = parseBody(reply, DiscoverySettingsUpdateRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) =>
      writeDiscoverySettings(db, body),
    );
  });

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
        return { ok: false, error: "db_not_found", message: `No JobCtrl database found at ${options.dbPath}` };
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
    if (body.sourceIds?.length) {
      command.sourceIds = body.sourceIds;
    }
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
    if (dispatch.workflowId) {
      recordPipelineWorkflowStarted(options.dbPath, firstStage, dispatch.workflowId, dispatch.runId);
    }
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

  app.get("/v1/evidence-map", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) => listEvidenceMap(db)),
  );

  app.get<{ Params: { jobKey: string } }>(
    "/v1/jobs/:jobKey/compensation/posted",
    async (request, reply) =>
      withDb(reply, options.dbPath, (db) => {
        const jobId = resolveJobId(db, "local", decodeRouteParam(request.params.jobKey));
        const response = jobId ? getPostedCompensationFact(db, "local", jobId) : null;
        if (!response) {
          void reply.code(404);
          return { ok: false, error: "job_not_found" };
        }
        return response;
      }),
  );

  app.get<{ Params: { jobKey: string } }>(
    "/v1/jobs/:jobKey/compensation/market",
    async (request, reply) =>
      withDb(reply, options.dbPath, (db) => {
        const jobId = resolveJobId(db, "local", decodeRouteParam(request.params.jobKey));
        const response = jobId ? getMarketCompensationEstimate(db, "local", jobId) : null;
        if (!response) {
          void reply.code(404);
          return { ok: false, error: "job_not_found" };
        }
        return response;
      }),
  );

  app.post<{ Params: { jobKey: string } }>(
    "/v1/jobs/:jobKey/actions/refresh-compensation",
    async (request, reply) => {
      const body = parseBody(reply, RefreshCompensationRequestSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      const outcome = await withWritableDb(reply, options.dbPath, async (db) => {
        const jobId = resolveJobId(db, "local", decodeRouteParam(request.params.jobKey));
        if (!jobId) {
          void reply.code(404);
          return { ok: false, error: "job_not_found" };
        }
        const command: ActionCommandPayload = {
          action: "refresh_compensation",
          jobKey: jobId,
        };
        if (body.observationsJsonPath) {
          command.observationsJsonPath = body.observationsJsonPath;
        }
        if (body.includeEuroTopTech !== undefined) {
          command.includeEuroTopTech = body.includeEuroTopTech;
        }
        if (body.euroTopTechMaxPages !== undefined) {
          command.euroTopTechMaxPages = body.euroTopTechMaxPages;
        }
        const dispatch = await actionDispatcher(command, actionContext);
        void reply.code(dispatch.status === "queued" ? 202 : 200);
        return buildActionResponse(command, dispatch);
      });
      return outcome;
    },
  );

  app.post("/v1/jobs/actions/refresh-compensation", async (request, reply) => {
    const body = parseBody(reply, RefreshCompensationRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    const command: ActionCommandPayload = {
      action: "refresh_compensation",
      jobKey: PIPELINE_ACTION_JOB_KEY,
    };
    if (body.observationsJsonPath) {
      command.observationsJsonPath = body.observationsJsonPath;
    }
    if (body.includeEuroTopTech !== undefined) {
      command.includeEuroTopTech = body.includeEuroTopTech;
    }
    if (body.euroTopTechMaxPages !== undefined) {
      command.euroTopTechMaxPages = body.euroTopTechMaxPages;
    }
    const dispatch = await actionDispatcher(command, actionContext);
    void reply.code(dispatch.status === "queued" ? 202 : 200);
    return buildActionResponse(command, dispatch);
  });

  app.get("/v1/apply/review-queue", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) => listApplyReviewQueue(db)),
  );

  app.get("/v1/resume-templates", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) => listResumeTemplates(db)),
  );

  app.get<{ Params: { templateId: string } }>("/v1/resume-templates/:templateId", async (request, reply) =>
    withDb(reply, options.dbPath, (db) => {
      const detail = getResumeTemplateDetail(db, decodeRouteParam(request.params.templateId));
      if (!detail) {
        void reply.code(404);
        return { ok: false, error: "resume_template_not_found" };
      }
      return detail;
    }),
  );

  app.post("/v1/resume-templates", async (request, reply) => {
    const body = parseBody(reply, ResumeTemplateVersionSaveRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) => createResumeTemplateVersion(db, body));
  });

  app.patch("/v1/resume-templates/default", async (request, reply) => {
    const body = parseBody(reply, ResumeTemplateDefaultSelectionRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) => setDefaultResumeTemplate(db, body));
  });

  app.patch<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey/resume-template", async (request, reply) => {
    const body = parseBody(reply, JobResumeTemplateAssignmentRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, (db) =>
      setJobResumeTemplateAssignment(db, decodeRouteParam(request.params.jobKey), body),
    );
  });

  app.post<{ Params: { jobKey: string } }>(
    "/v1/jobs/:jobKey/resume-template/ensure-current",
    async (request, reply) => {
      const body = parseBody(reply, EnsureCurrentResumeMaterialsRequestSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      return withWritableDb(reply, options.dbPath, (db) =>
        ensureCurrentResumeTemplateMaterials(db, decodeRouteParam(request.params.jobKey), body, resumePdfRenderer),
      );
    },
  );

  app.get<{ Params: { jobKey: string } }>(
    "/v1/jobs/:jobKey/resume-review/draft",
    async (request, reply) =>
      withDb(reply, options.dbPath, (db) => {
        const response = getResumeReviewDraftForJob(db, decodeRouteParam(request.params.jobKey));
        if (!response) {
          void reply.code(404);
          return { ok: false, error: "resume_review_draft_not_found" };
        }
        return response;
      }),
  );

  app.post<{ Params: { jobKey: string } }>(
    "/v1/jobs/:jobKey/resume-review/draft",
    async (request, reply) => {
      const body = parseBody(reply, ResumeReviewDraftCreateRequestSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      return withWritableDb(reply, options.dbPath, (db) =>
        createOrLoadResumeReviewDraft(db, decodeRouteParam(request.params.jobKey), body, resumePdfRenderer),
      );
    },
  );

  app.get<{ Params: { jobKey: string } }>(
    "/v1/jobs/:jobKey/resume-review/feedback",
    async (request, reply) =>
      withDb(reply, options.dbPath, (db) =>
        listResumeReviewFeedback(db, decodeRouteParam(request.params.jobKey)),
      ),
  );

  app.post<{ Params: { draftId: string } }>(
    "/v1/resume-review/drafts/:draftId/revisions",
    async (request, reply) => {
      const body = parseBody(reply, ResumeReviewDraftRevisionSaveRequestSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      return withWritableDb(reply, options.dbPath, (db) =>
        saveResumeReviewDraftRevision(db, decodeRouteParam(request.params.draftId), body),
      );
    },
  );

  app.post<{ Params: { draftId: string } }>(
    "/v1/resume-review/drafts/:draftId/comment-threads",
    async (request, reply) => {
      const body = parseBody(reply, ResumeReviewCommentThreadSeedRequestSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      return withWritableDb(reply, options.dbPath, (db) =>
        seedResumeReviewCommentThreads(db, decodeRouteParam(request.params.draftId), body),
      );
    },
  );

  app.post<{ Params: { draftId: string } }>(
    "/v1/resume-review/drafts/:draftId/render",
    async (request, reply) => {
      const body = parseBody(reply, ResumeReviewDraftRenderRequestSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      return withWritableDb(reply, options.dbPath, (db) => {
        const result = renderResumeReviewDraft(db, decodeRouteParam(request.params.draftId), body, resumePdfRenderer);
        if (result.ok) {
          refreshProjections(db);
        }
        return result;
      });
    },
  );

  app.post<{ Params: { threadId: string } }>(
    "/v1/resume-review/comment-threads/:threadId/replies",
    async (request, reply) => {
      const body = parseBody(reply, ResumeCommentReplyRequestSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      return withWritableDb(reply, options.dbPath, (db) =>
        replyToResumeReviewComment(db, decodeRouteParam(request.params.threadId), body),
      );
    },
  );

  app.get("/v1/outcomes", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) => listApplicationOutcomes(db)),
  );

  app.post("/v1/outcomes/gmail/scan", async (request, reply) => {
    const body = parseBody(reply, GmailOutcomeScanRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    if (!databaseExists(options.dbPath)) {
      void reply.code(503);
      return { ok: false, error: "db_not_found", message: `No JobCtrl database found at ${options.dbPath}` };
    }
    try {
      const output = await gmailFeedbackScanner(body, { appDir, dbPath: options.dbPath });
      return sanitizeGmailFeedbackScanResponse(output);
    } catch (error) {
      if (error instanceof GmailFeedbackScanError) {
        void reply.code(error.statusCode);
        return {
          ok: false,
          error:
            error.statusCode === 400
              ? "invalid_gmail_feedback_scan"
              : "gmail_feedback_scan_failed",
          message: error.message,
        };
      }
      throw error;
    }
  });

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
    const body = parseBody(reply, BulkRetryFailedRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    if (body.runAfter) {
      const workerReady = requireWorkerReady(reply, options.dbPath, requireHealthyWorkerForActions);
      if (!workerReady) {
        return undefined;
      }
    }
    return withWritableDb(reply, options.dbPath, async (db) => {
      const reset = retryFailedJobs(db, body);
      const actions: ActionRunResponse[] = [];
      const runnableGroups = body.runAfter
        ? groupRunnableBulkRetryTargets(reset.targets)
        : [];

      for (const group of runnableGroups) {
        const command = bulkRetryRunStageCommand(group.stage, group.jobUrls, body);
        const dispatch = await actionDispatcher(command, actionContext);
        if (dispatch.workflowId) {
          recordPipelineWorkflowStarted(
            options.dbPath,
            group.stage,
            dispatch.workflowId,
            dispatch.runId,
            bulkRetryWorkflowPayload(command, dispatch, group.jobUrls),
          );
        }
        if (dispatch.status === "queued") {
          queueRetriedJobsForWorkflow(
            db,
            group.jobUrls.map((jobUrl) => ({ jobUrl, stage: group.stage })),
            {
              ...(dispatch.workflowId ? { workflowId: dispatch.workflowId } : {}),
              ...(dispatch.runId ? { runId: dispatch.runId } : {}),
              ...(dispatch.actionId ? { actionId: dispatch.actionId } : {}),
              ...(command.workers !== undefined ? { requestedWorkers: command.workers } : {}),
              ...(command.limit !== undefined ? { requestedLimit: command.limit } : {}),
            },
          );
        }
        actions.push(buildActionResponse(command, dispatch));
      }

      const status = body.runAfter ? stageRunStatus(actions) : "reset";
      void reply.code(body.runAfter && actions.some((action) => action.status === "queued") ? 202 : 200);
      return {
        ok: true,
        count: reset.count,
        jobKeys: reset.jobKeys,
        stageCounts: reset.stageCounts,
        runAfter: body.runAfter,
        status,
        actions,
        ...(body.runAfter && reset.count > 0 && actions.length === 0
          ? { message: "Failed stages were reset; no preparation stages were eligible for automatic run-after dispatch." }
          : {}),
      } satisfies BulkRetryFailedResponse;
    });
  });

  app.post("/v1/jobs/bulk-run-pending-preparation", async (request, reply) => {
    const body = parseBody(reply, BulkRunPendingPreparationRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, async (db) => {
      refreshProjections(db);
      const targets = pendingPreparationTargets(db, body);
      const actions: ActionRunResponse[] = [];
      const runnableGroups = groupRunnableBulkRetryTargets(targets);

      if (targets.length > 0) {
        const workerReady = requireWorkerReady(reply, options.dbPath, requireHealthyWorkerForActions);
        if (!workerReady) {
          return undefined;
        }
      }

      for (const group of runnableGroups) {
        const command = pendingPreparationRunStageCommand(group.stage, group.jobUrls, body);
        const dispatch = await actionDispatcher(command, actionContext);
        if (dispatch.workflowId) {
          recordPipelineWorkflowStarted(
            options.dbPath,
            group.stage,
            dispatch.workflowId,
            dispatch.runId,
            pendingPreparationWorkflowPayload(command, dispatch, group.jobUrls),
          );
        }
        if (dispatch.status === "queued") {
          queueRetriedJobsForWorkflow(
            db,
            group.jobUrls.map((jobUrl) => ({ jobUrl, stage: group.stage })),
            {
              ...(dispatch.workflowId ? { workflowId: dispatch.workflowId } : {}),
              ...(dispatch.runId ? { runId: dispatch.runId } : {}),
              ...(dispatch.actionId ? { actionId: dispatch.actionId } : {}),
              ...(command.workers !== undefined ? { requestedWorkers: command.workers } : {}),
              ...(command.limit !== undefined ? { requestedLimit: command.limit } : {}),
              source: "bulk_run_pending_preparation",
              message: `${group.stage} queued by pending preparation action`,
            },
          );
        }
        actions.push(buildActionResponse(command, dispatch));
      }

      const status = stageRunStatus(actions);
      void reply.code(actions.some((action) => action.status === "queued") ? 202 : 200);
      return {
        ok: true,
        count: targets.length,
        jobKeys: targets.map((target) => target.jobUrl),
        stageCounts: stageCountsForTargets(targets),
        status,
        actions,
        ...(targets.length === 0
          ? { message: "No eligible pending preparation jobs matched the request." }
          : {}),
      } satisfies BulkRunPendingPreparationResponse;
    });
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

  app.post<{ Params: { jobKey: string } }>(
    "/v1/jobs/:jobKey/repeat-application/override",
    async (request, reply) => {
      const body = parseBody(reply, RepeatApplicationOverrideRequestSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      return withWritableDb(reply, options.dbPath, (db) => {
        const jobId = resolveJobId(db, "local", decodeRouteParam(request.params.jobKey));
        if (!jobId) {
          return { ok: false, error: "job_not_found" };
        }
        return recordRepeatApplicationOverride(db, jobId, body);
      });
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
        const jobId = resolveJobId(db, "local", decodeRouteParam(request.params.jobKey));
        if (!jobId) {
          void reply.code(404);
          return { ok: false, error: "job_not_found" };
        }
        correctScore(db, "local", jobId, body);
        const detail = getJobDetail(db, jobId);
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
    return withWritableDb(reply, options.dbPath, (db) => {
      const jobIds = [...new Set(
        body.jobKeys
          .map((jobKey) => resolveJobId(db, "local", jobKey))
          .filter((jobId): jobId is string => jobId !== null),
      )];
      return resetStaleScoresForRescore(db, {
        limit: body.limit,
        ...(body.jobKeys.length > 0 ? { jobIds } : {}),
      });
    });
  });

  app.post<{ Params: { jobKey: string } }>(
    "/v1/jobs/:jobKey/actions/rescore-current-policy",
    async (request, reply) => {
      const body = parseBody(reply, RescoreJobRequestSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      const outcome = await withWritableDb(reply, options.dbPath, async (db) => {
        const jobId = resolveExistingJobId(reply, db, decodeRouteParam(request.params.jobKey));
        if (!jobId) {
          return { ok: false, error: "job_not_found" };
        }
        const command: ActionCommandPayload = {
          action: "rescore_job",
          jobKey: jobId,
          jobId,
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
    const continuationStages = body.runAfter ? retryContinuationStages(body.stage) : [];
    if (body.runAfter && continuationStages.length === 0) {
      void reply.code(400);
      return { ok: false, error: "unsupported_retry_run_after_stage", stage: body.stage };
    }
    return withWritableDb(reply, options.dbPath, async (db) => {
      if (body.runAfter) {
        const workerReady = requireWorkerReady(reply, options.dbPath, requireHealthyWorkerForActions);
        if (!workerReady) {
          return undefined;
        }
      }
      const reset = resetJobStage(db, decodeRouteParam(request.params.jobKey), body.stage, {
        resetAttempts: body.resetAttempts,
      });
      const command: ActionCommandPayload = {
        action: "retry_stage" as const,
        jobKey: reset.jobUrl,
        stage: body.stage,
        resetAttempts: body.resetAttempts,
        runAfter: body.runAfter,
        dryRun: body.dryRun,
        limit: 1,
      };
      if (continuationStages.length > 0 && body.stage !== "apply") {
        command.stages = continuationStages;
      }
      const dispatch = body.runAfter ? await actionDispatcher(command, actionContext) : { status: "reset" };
      void reply.code(body.runAfter ? 202 : 200);
      return buildActionResponse(command, dispatch, { stage: reset.stage });
    });
  });

  app.post<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey/actions/run-stage", async (request, reply) => {
    const body = parseBody(reply, RunJobStageRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    if (!PREPARATION_PICKUP_STAGES.has(body.stage)) {
      void reply.code(400);
      return { ok: false, error: "unsupported_job_stage_run", stage: body.stage };
    }
    const stages = retryContinuationStages(body.stage);
    return withWritableDb(reply, options.dbPath, async (db) => {
      const jobUrl = resolveExistingJob(reply, db, decodeRouteParam(request.params.jobKey));
      if (!jobUrl) {
        return { ok: false, error: "job_not_found" };
      }
      refreshProjections(db);
      const command: ActionCommandPayload = {
        action: "run_stage",
        jobKey: jobUrl,
        stage: body.stage,
        stages,
        dryRun: body.dryRun,
        limit: body.limit,
        workers: body.workers,
        minScore: body.minScore,
        validationMode: body.validationMode,
        llmModel: body.llmModel,
      };
      const eligibility = preparationPickupEligibility(db, jobUrl, body.stage, body.minScore);
      if (!eligibility.eligible) {
        void reply.code(200);
        return buildActionResponse(command, {
          status: "not_eligible",
          message: eligibility.message,
          result: { reason: eligibility.reason },
        });
      }
      const workerReady = requireWorkerReady(reply, options.dbPath, requireHealthyWorkerForActions);
      if (!workerReady) {
        return undefined;
      }
      const dispatch = await actionDispatcher(command, actionContext);
      if (dispatch.workflowId) {
        recordPipelineWorkflowStarted(options.dbPath, body.stage, dispatch.workflowId, dispatch.runId);
      }
      void reply.code(dispatch.status === "queued" ? 202 : 200);
      return buildActionResponse(command, dispatch);
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
      refreshProjections(db);
      // INSPECT-01: per-job material generation runs the canonical material
      // stages (tailor → cover) through the same run_stage path the pipeline
      // pickup uses. The tailor stage runs the Phase 1-4 analyze → tailor →
      // voice → audit flow and supersedes the prior accepted artifact only after
      // a replacement is approved (INSPECT-06 is enforced by the worker's
      // generation-versioning, not the read side). Unlike scheduled pickup this
      // is an explicit user re-generation, so it is not gated on the stage being
      // pending — a user may regenerate materials for a job whose tailor stage
      // already succeeded.
      const primaryStage = body.stages[0] as Stage | undefined;
      if (!primaryStage) {
        void reply.code(400);
        return { ok: false, error: "no_material_stage_requested" };
      }
      const command: ActionCommandPayload = {
        action: "run_stage",
        jobKey: jobUrl,
        stage: primaryStage,
        stages: body.stages,
        dryRun: body.dryRun,
        limit: body.limit,
      };
      const workerReady = requireWorkerReady(reply, options.dbPath, requireHealthyWorkerForActions);
      if (!workerReady) {
        return undefined;
      }
      const dispatch = await actionDispatcher(command, actionContext);
      if (dispatch.workflowId) {
        recordPipelineWorkflowStarted(options.dbPath, primaryStage, dispatch.workflowId, dispatch.runId);
      }
      void reply.code(dispatch.status === "queued" ? 202 : 200);
      return buildActionResponse(command, dispatch);
    });
  });

  app.post<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey/actions/generate-interview-prep", async (request, reply) => {
    const body = parseBody(reply, GenerateInterviewPrepRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    return withWritableDb(reply, options.dbPath, async (db) => {
      const jobUrl = resolveExistingJob(reply, db, decodeRouteParam(request.params.jobKey));
      if (!jobUrl) {
        return { ok: false, error: "job_not_found" };
      }
      refreshProjections(db);
      const command: ActionCommandPayload = {
        action: "generate_interview_prep",
        jobKey: jobUrl,
      };
      if (body.llmModel) {
        command.llmModel = body.llmModel;
      }
      insertJobEvent(db, {
        jobUrl,
        stage: "tailor",
        eventType: "InterviewPrepRequested",
        level: "info",
        message: "Interview preparation requested by user",
        payload: {
          tenantId: "local",
          jobId: jobUrl,
        },
      });
      const workerReady = requireWorkerReady(reply, options.dbPath, requireHealthyWorkerForActions);
      if (!workerReady) {
        return undefined;
      }
      const dispatch = await actionDispatcher(command, actionContext);
      void reply.code(dispatch.status === "queued" ? 202 : 200);
      return buildActionResponse(command, dispatch);
    });
  });

  app.post<{ Params: { jobKey: string } }>("/v1/jobs/:jobKey/actions/tailor", async (request, reply) => {
    const body = parseBody(reply, TailorJobRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    const outcome = await withWritableDb(reply, options.dbPath, async (db) => {
      const jobUrl = resolveExistingJob(reply, db, decodeRouteParam(request.params.jobKey));
      if (!jobUrl) {
        return { ok: false, error: "job_not_found" };
      }
      const command: ActionCommandPayload = {
        action: "tailor_job",
        jobKey: jobUrl,
        dryRun: body.dryRun,
        tailorModels: body.tailorModels,
      };
      if (body.reason) command.reason = body.reason;
      if (body.tailorJudgeModel) command.tailorJudgeModel = body.tailorJudgeModel;
      if (body.tailorJudgeMinScore !== undefined) {
        command.tailorJudgeMinScore = body.tailorJudgeMinScore;
      }
      insertJobEvent(db, {
        jobUrl,
        stage: "tailor",
        eventType: "TailorRequested",
        level: "info",
        message: "Tailoring requested by user",
        payload: {
          tenantId: "local",
          jobId: jobUrl,
          dryRun: body.dryRun,
          reason: body.reason ?? "manual_tailor",
          allowLowFitOverride: true,
        },
      });
      const workerReady = requireWorkerReady(reply, options.dbPath, requireHealthyWorkerForActions);
      if (!workerReady) {
        return undefined;
      }
      const dispatch = await actionDispatcher(command, actionContext);
      void reply.code(202);
      return buildActionResponse(command, dispatch);
    });
    return outcome;
  });

  app.post<{ Params: { jobKey: string } }>(
    "/v1/jobs/:jobKey/actions/retailor-current-policy",
    async (request, reply) => {
      const body = parseBody(reply, RetailorJobRequestSchema, request.body ?? {});
      if (!body) {
        return undefined;
      }
      const outcome = await withWritableDb(reply, options.dbPath, async (db) => {
        const jobId = resolveExistingJobId(reply, db, decodeRouteParam(request.params.jobKey));
        if (!jobId) {
          return { ok: false, error: "job_not_found" };
        }
        const command: ActionCommandPayload = {
          action: "retailor_job",
          jobKey: jobId,
          jobId,
          dryRun: body.dryRun,
          suppressExistingArtifacts: body.suppressExistingArtifacts,
          tailorModels: body.tailorModels,
        };
        if (body.reason) command.reason = body.reason;
        if (body.tailorJudgeModel) command.tailorJudgeModel = body.tailorJudgeModel;
        if (body.tailorJudgeMinScore !== undefined) {
          command.tailorJudgeMinScore = body.tailorJudgeMinScore;
        }
        insertJobEvent(db, {
          jobUrl: jobId,
          stage: "tailor",
          eventType: "RetailorRequested",
          level: "info",
          message: "Current-policy re-tailoring requested by user",
          payload: {
            tenantId: "local",
            jobId,
            dryRun: body.dryRun,
            reason: body.reason ?? "current_policy_retailor",
            suppressExistingArtifacts: body.suppressExistingArtifacts,
          },
        });
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
      const jobLocator = decodeRouteParam(request.params.jobKey);
      const jobId = resolveJobId(db, "local", jobLocator);
      const jobUrl = resolveExistingJob(reply, db, jobLocator);
      if (!jobId || !jobUrl) {
        return { ok: false, error: "job_not_found" };
      }
      if (!body.dryRun) {
        assertLiveApplicationMayDispatch(db, jobId);
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
      return {
        command,
        stage: canceled.stage,
        cancelRequested: canceled.cancelRequested,
      };
    });
    if ("ok" in writeOutcome) {
      return writeOutcome;
    }
    // Forward the cancel to the worker so the running Temporal workflow
    // (started by PR 3's mode="workflow" cut-over) actually receives a
    // cancellation signal. Without this, the SQLite event-flip succeeds
    // but the workflow keeps polling Chrome and the stage row drifts
    // back to running on the next worker_loop cycle.
    const {
      command: cancelCommand,
      stage: cancelStage,
      cancelRequested,
    } = writeOutcome;
    const runId = cancelCommand.runId;
    if (runId && cancelRequested) {
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
      {
        status: cancelRequested ? "cancel_requested" : "already_terminal",
        ...(runId ? { runId } : {}),
      },
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

  app.get<{ Params: { runId: string } }>("/v1/workflow-runs/:runId", async (request, reply) =>
    withDb(reply, options.dbPath, (db) => {
      const detail = getWorkflowRunDetail(db, decodeRouteParam(request.params.runId));
      if (!detail) {
        void reply.code(404);
        return { ok: false, error: "workflow_run_not_found" };
      }
      return detail;
    }),
  );

  app.post<{ Params: { runId: string } }>("/v1/workflow-runs/:runId/actions/cancel", async (request, reply) => {
    const runId = decodeRouteParam(request.params.runId);
    const workerReady = requireWorkerReady(reply, options.dbPath, requireHealthyWorkerForActions);
    if (!workerReady) {
      return undefined;
    }
    const command: ActionCommandPayload = {
      action: "cancel" as const,
      jobKey: PIPELINE_ACTION_JOB_KEY,
      runId,
    };
    const dispatch = await actionDispatcher(command, actionContext);
    if (dispatch.status !== "failed") {
      recordPipelineWorkflowCancelRequested(options.dbPath, runId);
    }
    return buildActionResponse(command, dispatch);
  });

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
    if (!artifactPathWithinAppDir(appDir, detail.artifact.localPath)) {
      void reply.code(403);
      return {
        ok: false,
        error: "artifact_path_forbidden",
        message: "Artifact path resolves outside the JobCtrl app directory.",
      };
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

  app.get<{ Params: { artifactId: string } }>("/v1/artifacts/:artifactId/preview.html", async (request, reply) => {
    const artifactId = decodeRouteParam(request.params.artifactId);
    const preview = withDb(reply, options.dbPath, (db) => {
      const detail = getArtifactDetail(db, artifactId);
      if (!detail) {
        return null;
      }
      return htmlPreviewForArtifact(detail, artifactPreviewRow(db, artifactId));
    });
    if (!preview) {
      void reply.code(404);
      return { ok: false, error: "artifact_not_found" };
    }
    if ("ok" in preview && preview.ok === false) {
      const statusCode = "statusCode" in preview ? preview.statusCode : 500;
      void reply.code(statusCode);
      return { ok: false, error: preview.error, message: preview.message };
    }

    if (!artifactPathWithinAppDir(appDir, preview.htmlPath)) {
      void reply.code(403);
      return {
        ok: false,
        error: "artifact_path_forbidden",
        message: "Artifact path resolves outside the JobCtrl app directory.",
      };
    }

    return reply
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'")
      .send(fs.createReadStream(preview.htmlPath));
  });

  app.post<{ Params: { artifactId: string } }>("/v1/artifacts/:artifactId/open", async (request, reply) => {
    const resolvedArtifactId = await withWritableDb(reply, options.dbPath, (db) =>
      resolveCurrentResumeArtifactIdForOpen(db, decodeRouteParam(request.params.artifactId), resumePdfRenderer),
    );
    if (typeof resolvedArtifactId !== "string") {
      return resolvedArtifactId;
    }
    const detail = withDb(reply, options.dbPath, (db) => getArtifactDetail(db, resolvedArtifactId));
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
    if (!artifactPathWithinAppDir(appDir, detail.artifact.localPath)) {
      void reply.code(403);
      return {
        ok: false,
        error: "artifact_path_forbidden",
        message: "Artifact path resolves outside the JobCtrl app directory.",
      };
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
    withDb(reply, options.dbPath, (db) => readProfileConfig(db)),
  );

  app.get("/v1/profile/preview.pdf", async (_request, reply) => {
    try {
      const previewInput = withDb(reply, options.dbPath, (db) => {
        const profileConfig = readProfileConfig(db);
        const templateVersion = resolveEffectiveResumeTemplate(db).version;
        const layoutSectionOrder = templateVersion.layout.sectionOrder;
        return {
          profile: profileConfig.profile,
          resumeTheme: layoutSectionOrder?.length
            ? { ...templateVersion.theme, sectionOrder: layoutSectionOrder }
            : templateVersion.theme,
          templateText: profileConfig.templateText,
        };
      });
      if ("ok" in previewInput) {
        return previewInput;
      }
      const preview = await profilePreviewRenderer(previewInput, actionContext);
      return reply
        .header("content-type", "application/pdf")
        .header("cache-control", "no-store")
        .send(preview.pdfBytes);
    } catch (error) {
      void reply.code(500);
      return {
        ok: false,
        error: "profile_preview_failed",
        message: error instanceof Error ? error.message : "Unable to render profile preview.",
      };
    }
  });

  app.get("/v1/profile/preview.html", async (_request, reply) => {
    try {
      const previewInput = withDb(reply, options.dbPath, (db) => {
        const profileConfig = readProfileConfig(db);
        const templateVersion = resolveEffectiveResumeTemplate(db).version;
        const layoutSectionOrder = templateVersion.layout.sectionOrder;
        return {
          profile: profileConfig.profile,
          resumeTheme: layoutSectionOrder?.length
            ? { ...templateVersion.theme, sectionOrder: layoutSectionOrder }
            : templateVersion.theme,
          templateText: profileConfig.templateText,
        };
      });
      if ("ok" in previewInput) {
        return previewInput;
      }
      const preview = await profilePreviewRenderer(previewInput, actionContext);
      return reply
        .type("text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'")
        .send(preview.htmlText);
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
      return { ok: false, error: "db_not_found", message: `No JobCtrl database found at ${options.dbPath}` };
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
      profileResponse = writeProfileConfig(db, body);
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

  app.get("/v1/settings", async () =>
    readSettingsConfig({ configPath: options.configPath }),
  );

  app.patch("/v1/settings", async (request, reply) => {
    const body = parseBody(reply, SettingsUpdateRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    const selectedModels = Object.entries(body.preferredModels ?? {}).filter(
      (entry): entry is ["codex" | "claude" | "google", string] => entry[1] !== null,
    );
    if (selectedModels.length > 0) {
      let catalog: { providers: ProviderModelCatalogItem[] };
      try {
        catalog = await dispatchProviderModelCatalog(providerDispatcher);
      } catch {
        void reply.code(503);
        return providerOperationError(
          "provider_models_failed",
          "Provider models are temporarily unavailable.",
        );
      }
      for (const [provider, model] of selectedModels) {
        const item = catalog.providers.find((candidate) => candidate.provider === provider);
        if (!item?.ready) {
          void reply.code(409);
          return {
            ok: false as const,
            error: "provider_not_ready",
            message: `${provider} must be ready before selecting a preferred model.`,
          };
        }
        if (!item.models.some((candidate) => candidate.id === model)) {
          if (item.source === "live" && item.models.length === 0 && item.message) {
            void reply.code(503);
            return providerOperationError(
              "provider_models_failed",
              "Provider models are temporarily unavailable.",
            );
          }
          void reply.code(400);
          return {
            ok: false as const,
            error: "invalid_preferred_model",
            message: `${model} is not currently offered by ${provider}.`,
          };
        }
      }
    }
    try {
      return writeSettingsConfig(
        { configPath: options.configPath },
        body,
      );
    } catch (error) {
      if (error instanceof InputError || error instanceof ConfigFileInputError) {
        void reply.code(400);
        return { ok: false, error: "invalid_settings", message: error.message };
      }
      throw error;
    }
  });

  app.get("/v1/credentials", async () => credentialStore.list());

  app.get("/v1/browser-capabilities", async (_request, reply) =>
    dispatchBrowserCapabilities(reply, providerDispatcher, "browser_capabilities_list", {}),
  );

  app.post<{ Params: { capabilityId: string } }>(
    "/v1/browser-capabilities/:capabilityId/enable",
    async (request, reply) => {
      const capabilityId = decodeRouteParam(request.params.capabilityId);
      if (capabilityId === "core-browser" || !BrowserCapabilityIds.includes(capabilityId as never)) {
        void reply.code(400);
        return { ok: false, error: "browser_capability_failed", message: "This browser capability cannot be enabled." };
      }
      const body = parseBody(reply, BrowserCapabilityEnableRequestSchema, request.body ?? {});
      if (!body) return undefined;
      return dispatchBrowserCapabilities(reply, providerDispatcher, "browser_capability_enable", {
        capabilityId,
        ...body,
      });
    },
  );

  app.post<{ Params: { capabilityId: string } }>(
    "/v1/browser-capabilities/:capabilityId/disable",
    async (request, reply) => {
      const capabilityId = decodeRouteParam(request.params.capabilityId);
      if (capabilityId === "core-browser" || !BrowserCapabilityIds.includes(capabilityId as never)) {
        void reply.code(400);
        return { ok: false, error: "browser_capability_failed", message: "This browser capability cannot be disabled." };
      }
      return dispatchBrowserCapabilities(reply, providerDispatcher, "browser_capability_disable", { capabilityId });
    },
  );

  app.post(
    "/v1/browser-capabilities/authenticated-linkedin-browser/profile-copy",
    async (request, reply) => {
      const body = parseBody(reply, BrowserProfileCopyRequestSchema, request.body ?? {});
      if (!body) return undefined;
      return dispatchBrowserCapabilities(reply, providerDispatcher, "browser_profile_copy", body);
    },
  );

  app.patch("/v1/credentials", async (request, reply) => {
    const body = parseBody(reply, CredentialUpdateRequestSchema, request.body ?? {});
    if (!body) {
      return undefined;
    }
    try {
      return await credentialStore.set(body.key, body.value);
    } catch (error) {
      if (error instanceof CredentialManagedByEnvironmentError) {
        void reply.code(409);
        return {
          ok: false,
          error: "credential_managed_by_environment",
          key: error.key,
          source: "environment",
          message: error.message,
        };
      }
      if (error instanceof CredentialStoreUnavailableError) {
        void reply.code(error.reason === "unsupported_platform" ? 409 : 503);
        return {
          ok: false,
          error: "credential_store_unavailable",
          reason: error.reason,
          message: error.message,
        };
      }
      throw error;
    }
  });

  app.patch("/v1/credentials/batch", async (request, reply) => {
    const body = parseBody(
      reply,
      CredentialBatchUpdateRequestSchema,
      request.body ?? {},
    );
    if (!body) {
      return undefined;
    }
    try {
      return await credentialStore.applyBatch(body.operations);
    } catch (error) {
      if (error instanceof CredentialManagedByEnvironmentError) {
        void reply.code(409);
        return {
          ok: false,
          error: "credential_managed_by_environment",
          key: error.key,
          source: "environment",
          message: error.message,
        };
      }
      if (error instanceof CredentialStoreUnavailableError) {
        void reply.code(error.reason === "unsupported_platform" ? 409 : 503);
        return {
          ok: false,
          error: "credential_store_unavailable",
          reason: error.reason,
          message: error.message,
        };
      }
      throw error;
    }
  });

  app.delete<{ Params: { key: string } }>("/v1/credentials/:key", async (request, reply) => {
    const key = decodeRouteParam(request.params.key);
    if (!CredentialKeys.includes(key as (typeof CredentialKeys)[number])) {
      void reply.code(400);
      return { ok: false, error: "invalid_credential_key" };
    }
    try {
      return await credentialStore.delete(key as (typeof CredentialKeys)[number]);
    } catch (error) {
      if (error instanceof CredentialManagedByEnvironmentError) {
        void reply.code(409);
        return {
          ok: false,
          error: "credential_managed_by_environment",
          key: error.key,
          source: "environment",
          message: error.message,
        };
      }
      if (error instanceof CredentialStoreUnavailableError) {
        void reply.code(error.reason === "unsupported_platform" ? 409 : 503);
        return {
          ok: false,
          error: "credential_store_unavailable",
          reason: error.reason,
          message: error.message,
        };
      }
      throw error;
    }
  });

  app.get("/v1/providers/status", async (_request, reply) => {
    try {
      const response = await providerDispatcher.call("provider_status", {});
      if (response.error) {
        void reply.code(502);
        return providerOperationError(
          "provider_status_failed",
          "Provider status is temporarily unavailable.",
        );
      }
      const parsed = ProviderStatusResultSchema.safeParse(response.result);
      if (!parsed.success) {
        void reply.code(502);
        return providerOperationError(
          "provider_status_failed",
          "Provider status returned an invalid response.",
        );
      }
      return { ok: true as const, providers: parsed.data.providers };
    } catch {
      void reply.code(503);
      return providerOperationError(
        "provider_status_failed",
        "Provider status is temporarily unavailable.",
      );
    }
  });

  app.get("/v1/providers/models", async (_request, reply) => {
    try {
      const catalog = await dispatchProviderModelCatalog(providerDispatcher);
      return { ok: true as const, providers: catalog.providers };
    } catch {
      void reply.code(503);
      return providerOperationError(
        "provider_models_failed",
        "Provider models are temporarily unavailable.",
      );
    }
  });

  app.post("/v1/providers/codex/verify", async (_request, reply) => {
    try {
      const response = await providerDispatcher.call("provider_verify", {
        provider: "codex",
      });
      if (response.error) {
        void reply.code(502);
        return providerOperationError(
          "provider_verification_failed",
          "Codex verification could not be completed.",
        );
      }
      const parsed = CodexVerifyResultSchema.safeParse(response.result);
      if (!parsed.success) {
        void reply.code(502);
        return providerOperationError(
          "provider_verification_failed",
          "Codex verification returned an invalid response.",
        );
      }
      return { ok: true as const, verification: parsed.data };
    } catch {
      void reply.code(503);
      return providerOperationError(
        "provider_verification_failed",
        "Codex verification is temporarily unavailable.",
      );
    }
  });

  // Contact & Outreach (R6 Phase 1). Reads project provenance for every fact
  // (INV-2); writes never expose a send transport (INV-1).
  app.get("/v1/contacts", async (request, reply) =>
    withDb(reply, options.dbPath, (db) => ({
      ok: true,
      items: listContacts(db, ContactListQuerySchema.parse(request.query)),
    })),
  );

  app.get<{ Params: { contactId: string } }>("/v1/contacts/:contactId", async (request, reply) =>
    withDb(reply, options.dbPath, (db) => {
      const contact = getContactDetail(db, decodeRouteParam(request.params.contactId));
      if (!contact) {
        void reply.code(404);
        return { ok: false, error: "contact_not_found" };
      }
      return { ok: true, contact };
    }),
  );

  app.post("/v1/contacts", async (request, reply) => {
    const body = parseBody(reply, ContactCreateRequestSchema, request.body ?? {});
    if (!body) {
      return { ok: false, error: "invalid_contact" };
    }
    return withWritableDb(reply, options.dbPath, (db) => {
      try {
        return { ok: true, contact: createContact(db, body) };
      } catch (error) {
        if (error instanceof ContactInputError) {
          void reply.code(400);
          return { ok: false, error: "invalid_contact", message: error.message };
        }
        throw error;
      }
    });
  });

  app.post("/v1/contacts/import", async (request, reply) => {
    const body = parseBody(reply, ContactImportRequestSchema, request.body ?? {});
    if (!body) {
      return { ok: false, error: "invalid_contact_import" };
    }
    return withWritableDb(reply, options.dbPath, (db) => {
      try {
        return importContacts(db, body);
      } catch (error) {
        if (error instanceof ContactInputError) {
          void reply.code(400);
          return { ok: false, error: "invalid_contact_import", message: error.message };
        }
        throw error;
      }
    });
  });

  app.patch<{ Params: { contactId: string } }>("/v1/contacts/:contactId", async (request, reply) => {
    const body = parseBody(reply, ContactUpdateRequestSchema, request.body ?? {});
    if (!body) {
      return { ok: false, error: "invalid_contact" };
    }
    return withWritableDb(reply, options.dbPath, (db) => {
      try {
        return { ok: true, contact: updateContact(db, decodeRouteParam(request.params.contactId), body) };
      } catch (error) {
        if (error instanceof ContactNotFoundError) {
          void reply.code(404);
          return { ok: false, error: "contact_not_found", message: error.message };
        }
        if (error instanceof ContactInputError) {
          void reply.code(400);
          return { ok: false, error: "invalid_contact", message: error.message };
        }
        throw error;
      }
    });
  });

  app.delete<{ Params: { contactId: string } }>(
    "/v1/contacts/:contactId",
    async (request, reply) => {
      const body = parseBody(reply, ContactDeleteRequestSchema, request.body ?? {});
      if (!body) {
        return { ok: false, error: "invalid_contact" };
      }
      return withWritableDb(reply, options.dbPath, (db) => {
        try {
          return deleteContact(db, decodeRouteParam(request.params.contactId), body.reason ?? "");
        } catch (error) {
          if (error instanceof ContactNotFoundError) {
            void reply.code(404);
            return { ok: false, error: "contact_not_found", message: error.message };
          }
          throw error;
        }
      });
    },
  );

  // Supervised contact research (R6 Phase 2). Research + LLM run on the Python
  // worker via Temporal; fetching routes only through the politeness gateway
  // against the conservative opt-in allowlist (INV-3). Candidates land
  // needs_review and require an explicit confirm command (INV-4). No send
  // transport exists on any of these routes (INV-1).
  app.get("/v1/contacts/research", async (request, reply) =>
    withDb(reply, options.dbPath, (db) => ({
      ok: true,
      items: listResearchTasks(db, ContactResearchListQuerySchema.parse(request.query)),
    })),
  );

  app.get<{ Params: { taskId: string } }>(
    "/v1/contacts/research/:taskId",
    async (request, reply) =>
      withDb(reply, options.dbPath, (db) => {
        const task = getResearchTaskDetail(db, decodeRouteParam(request.params.taskId));
        if (!task) {
          void reply.code(404);
          return { ok: false, error: "research_task_not_found" };
        }
        return { ok: true, task };
      }),
  );

  app.post("/v1/contacts/research", async (request, reply) => {
    const body = parseBody(reply, RunContactResearchRequestSchema, request.body ?? {});
    if (!body) {
      return { ok: false, error: "invalid_contact_research" };
    }
    const workerReady = requireWorkerReady(reply, options.dbPath, requireHealthyWorkerForActions);
    if (!workerReady) {
      return undefined;
    }
    const taskId = randomUUID();
    const employer = body.employer ?? null;
    const jobId = body.jobId ?? null;
    const sources = body.sources.map((source) => ({
      category: source.category,
      url: source.url,
      label: source.label,
    }));
    return withWritableDb(reply, options.dbPath, async (db) => {
      createQueuedResearchTask(db, { taskId, employer, jobId });
      const started = await contactResearchStarter(
        {
          taskId,
          employer,
          jobUrl: jobId,
          sources,
          ...(body.llmModel ? { llmModel: body.llmModel } : {}),
        },
        actionContext,
      );
      void reply.code(202);
      return {
        ok: true,
        taskId,
        runId: started.runId,
        workflowId: started.workflowId,
        status: started.status,
      };
    });
  });

  app.post<{ Params: { taskId: string; candidateId: string } }>(
    "/v1/contacts/research/:taskId/candidates/:candidateId/confirm",
    async (request, reply) => {
      const body = parseBody(reply, ConfirmContactCandidateRequestSchema, request.body ?? {});
      if (!body) {
        return { ok: false, error: "invalid_confirm" };
      }
      return withWritableDb(reply, options.dbPath, (db) => {
        try {
          return confirmContactCandidate(
            db,
            decodeRouteParam(request.params.taskId),
            decodeRouteParam(request.params.candidateId),
            body.role,
          );
        } catch (error) {
          if (error instanceof ContactResearchNotFoundError) {
            void reply.code(404);
            return { ok: false, error: "research_candidate_not_found", message: error.message };
          }
          if (error instanceof ContactResearchInputError) {
            void reply.code(400);
            return { ok: false, error: "invalid_confirm", message: error.message };
          }
          throw error;
        }
      });
    },
  );

  // Outreach drafts (R6 Phase 3). Generation/revision run the LLM + the reused
  // materials truthfulness gate stack synchronously on the Python worker;
  // approval/rejection are TS-API transitions. Approval is HARD-gated on the
  // persisted gate outcome (INV-5). No route exposes a send transport (INV-1) —
  // an approved draft is copied out by the browser, never sent.
  app.get<{ Params: { contactId: string } }>(
    "/v1/contacts/:contactId/outreach",
    async (request, reply) =>
      withDb(reply, options.dbPath, (db) => {
        const query = OutreachThreadQuerySchema.parse(request.query);
        return {
          ok: true,
          thread: getOutreachThreadForContact(
            db,
            decodeRouteParam(request.params.contactId),
            query.jobId ?? null,
          ),
        };
      }),
  );

  app.post<{ Params: { contactId: string } }>(
    "/v1/contacts/:contactId/outreach/drafts",
    async (request, reply) => {
      const body = parseBody(reply, GenerateOutreachDraftRequestSchema, request.body ?? {});
      if (!body) {
        return { ok: false, error: "invalid_outreach_draft" };
      }
      const workerReady = requireWorkerReady(reply, options.dbPath, requireHealthyWorkerForActions);
      if (!workerReady) {
        return undefined;
      }
      const contactId = decodeRouteParam(request.params.contactId);
      const jobId = body.jobId ?? null;
      return withWritableDb(reply, options.dbPath, async (db) => {
        const threadId = findOutreachThreadIdForContact(db, contactId, jobId) ?? randomUUID();
        await outreachDraftGenerator(
          {
            threadId,
            contactId,
            jobId,
            ...(body.kind ? { kind: body.kind } : {}),
            ...(body.applicationRole ? { applicationRole: body.applicationRole } : {}),
            ...(body.llmModel ? { llmModel: body.llmModel } : {}),
          },
          actionContext,
        );
        return { ok: true, thread: getOutreachThreadDetail(db, threadId) };
      });
    },
  );

  app.post<{ Params: { threadId: string } }>(
    "/v1/outreach/threads/:threadId/drafts",
    async (request, reply) => {
      const body = parseBody(reply, ReviseOutreachDraftRequestSchema, request.body ?? {});
      if (!body) {
        return { ok: false, error: "invalid_outreach_draft" };
      }
      const workerReady = requireWorkerReady(reply, options.dbPath, requireHealthyWorkerForActions);
      if (!workerReady) {
        return undefined;
      }
      const threadId = decodeRouteParam(request.params.threadId);
      return withWritableDb(reply, options.dbPath, async (db) => {
        await outreachDraftGenerator(
          {
            threadId,
            editedBodyText: body.editedBodyText,
            ...(body.kind ? { kind: body.kind } : {}),
            ...(body.applicationRole ? { applicationRole: body.applicationRole } : {}),
            ...(body.llmModel ? { llmModel: body.llmModel } : {}),
          },
          actionContext,
        );
        return { ok: true, thread: getOutreachThreadDetail(db, threadId) };
      });
    },
  );

  app.post<{ Params: { threadId: string; draftId: string } }>(
    "/v1/outreach/threads/:threadId/drafts/:draftId/approve",
    async (request, reply) =>
      withWritableDb(reply, options.dbPath, (db) => {
        try {
          return {
            ok: true,
            thread: approveOutreachDraft(
              db,
              decodeRouteParam(request.params.threadId),
              decodeRouteParam(request.params.draftId),
            ),
          };
        } catch (error) {
          if (error instanceof OutreachDraftGatesNotPassedError) {
            void reply.code(409);
            return { ok: false, error: "draft_gates_not_passed", message: error.message };
          }
          if (error instanceof OutreachNotFoundError) {
            void reply.code(404);
            return { ok: false, error: "outreach_draft_not_found", message: error.message };
          }
          if (error instanceof OutreachInputError) {
            void reply.code(400);
            return { ok: false, error: "invalid_outreach_transition", message: error.message };
          }
          throw error;
        }
      }),
  );

  app.post<{ Params: { threadId: string; draftId: string } }>(
    "/v1/outreach/threads/:threadId/drafts/:draftId/reject",
    async (request, reply) => {
      const body = parseBody(reply, RejectOutreachDraftRequestSchema, request.body ?? {});
      if (!body) {
        return { ok: false, error: "invalid_outreach_reject" };
      }
      return withWritableDb(reply, options.dbPath, (db) => {
        try {
          return {
            ok: true,
            thread: rejectOutreachDraft(
              db,
              decodeRouteParam(request.params.threadId),
              decodeRouteParam(request.params.draftId),
              body.reason ?? "",
            ),
          };
        } catch (error) {
          if (error instanceof OutreachNotFoundError) {
            void reply.code(404);
            return { ok: false, error: "outreach_draft_not_found", message: error.message };
          }
          if (error instanceof OutreachInputError) {
            void reply.code(400);
            return { ok: false, error: "invalid_outreach_transition", message: error.message };
          }
          throw error;
        }
      });
    },
  );

  // Outreach send log + follow-ups (R6 Phase 4). INV-1: NO route sends anything.
  // `send-logs` RECORDS a user-attested send of an APPROVED draft; the follow-up
  // routes schedule/complete/dismiss a surfaced-only reminder; the due list is a
  // derived read over schedule + clock. No transport of any kind is exposed here.
  app.post<{ Params: { threadId: string } }>(
    "/v1/outreach/threads/:threadId/send-logs",
    async (request, reply) => {
      const body = parseBody(reply, LogOutreachSendRequestSchema, request.body ?? {});
      if (!body) {
        return { ok: false, error: "invalid_outreach_send_log" };
      }
      return withWritableDb(reply, options.dbPath, (db) => {
        try {
          return {
            ok: true,
            thread: logOutreachSend(
              db,
              decodeRouteParam(request.params.threadId),
              body.draftId,
              body.channel,
              body.sentAt,
            ),
          };
        } catch (error) {
          return outreachTransitionError(reply, error);
        }
      });
    },
  );

  app.post<{ Params: { threadId: string } }>(
    "/v1/outreach/threads/:threadId/follow-up/schedule",
    async (request, reply) => {
      const body = parseBody(reply, ScheduleFollowUpRequestSchema, request.body ?? {});
      if (!body) {
        return { ok: false, error: "invalid_follow_up_schedule" };
      }
      return withWritableDb(reply, options.dbPath, (db) => {
        try {
          return {
            ok: true,
            thread: scheduleOutreachFollowUp(db, decodeRouteParam(request.params.threadId), {
              ...(body.dueAt ? { dueAt: body.dueAt } : {}),
              ...(body.basis ? { basis: body.basis } : {}),
              ...(body.hasLoggedReply !== undefined
                ? { hasLoggedReply: body.hasLoggedReply }
                : {}),
            }),
          };
        } catch (error) {
          return outreachTransitionError(reply, error);
        }
      });
    },
  );

  app.post<{ Params: { threadId: string } }>(
    "/v1/outreach/threads/:threadId/follow-up/complete",
    async (request, reply) =>
      withWritableDb(reply, options.dbPath, (db) => {
        try {
          return {
            ok: true,
            thread: completeOutreachFollowUp(db, decodeRouteParam(request.params.threadId)),
          };
        } catch (error) {
          return outreachTransitionError(reply, error);
        }
      }),
  );

  app.post<{ Params: { threadId: string } }>(
    "/v1/outreach/threads/:threadId/follow-up/dismiss",
    async (request, reply) =>
      withWritableDb(reply, options.dbPath, (db) => {
        try {
          return {
            ok: true,
            thread: dismissOutreachFollowUp(db, decodeRouteParam(request.params.threadId)),
          };
        } catch (error) {
          return outreachTransitionError(reply, error);
        }
      }),
  );

  app.get("/v1/outreach/follow-ups/due", async (_request, reply) =>
    withDb(reply, options.dbPath, (db) => ({ ok: true, followUps: getDueFollowUps(db) })),
  );

  if (options.webAssetsDir) {
    installWebAssetsNotFoundHandler(app, options.webAssetsDir);
  }

  return app;
}

const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function installWebAssetsNotFoundHandler(app: FastifyInstance, configuredRoot: string): void {
  if (!path.isAbsolute(configuredRoot)) {
    throw new Error("Web assets directory must be an absolute path.");
  }
  if (!fs.existsSync(configuredRoot) || !fs.statSync(configuredRoot).isDirectory()) {
    throw new Error(`Web assets directory does not exist: ${configuredRoot}`);
  }
  const root = fs.realpathSync(configuredRoot);
  const indexPath = resolveStaticFile(root, "index.html");
  if (!indexPath) {
    throw new Error(`Web assets directory is missing index.html: ${configuredRoot}`);
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.code(404).send({ ok: false, error: "not_found" });
    }

    const decodedPath = decodeStaticRequestPath(request.raw.url ?? request.url);
    if (decodedPath === null) {
      return reply.code(400).send({ ok: false, error: "invalid_static_path" });
    }
    if (decodedPath === "/v1" || decodedPath.startsWith("/v1/")) {
      return reply.code(404).send({ ok: false, error: "not_found" });
    }

    const relativePath = decodedPath.replace(/^\/+/, "");
    const requestedFile = relativePath ? resolveStaticFile(root, relativePath) : indexPath;
    if (requestedFile) {
      return sendStaticFile(reply, requestedFile, requestedFile === indexPath, relativePath);
    }

    // Never answer a missing asset or fetch with HTML. Only browser document
    // navigations that explicitly accept HTML receive the SPA shell.
    if (decodedPath.startsWith("/assets/") || path.posix.extname(decodedPath)) {
      return reply.code(404).send({ ok: false, error: "static_asset_not_found" });
    }
    if (!acceptsHtmlNavigation(request)) {
      return reply.code(404).send({ ok: false, error: "not_found" });
    }
    return sendStaticFile(reply, indexPath, true, "index.html");
  });
}

function acceptsHtmlNavigation(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  if (!accept || !accept.split(",").some(isAcceptedHtmlMediaRange)) return false;

  const fetchMode = singleHeaderValue(request.headers["sec-fetch-mode"]);
  if (fetchMode && fetchMode !== "navigate") return false;
  const fetchDestination = singleHeaderValue(request.headers["sec-fetch-dest"]);
  return !fetchDestination || fetchDestination === "document";
}

function isAcceptedHtmlMediaRange(range: string): boolean {
  const [rawType, ...rawParameters] = range.split(";");
  const type = rawType?.trim().toLowerCase();
  if (type !== "text/html" && type !== "application/xhtml+xml") return false;
  const quality = rawParameters
    .map((parameter) => parameter.trim().toLowerCase())
    .find((parameter) => parameter.startsWith("q="));
  return quality ? Number.parseFloat(quality.slice(2)) > 0 : true;
}

function singleHeaderValue(value: string | string[] | undefined): string | undefined {
  const firstValue = Array.isArray(value) ? value[0] : value;
  return firstValue?.trim().toLowerCase();
}

function decodeStaticRequestPath(rawUrl: string): string | null {
  const rawPath = rawUrl.split("?", 1)[0] ?? "/";
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (
    !decodedPath.startsWith("/") ||
    decodedPath.includes("\0") ||
    decodedPath.includes("\\") ||
    decodedPath.split("/").some((segment) => segment === "..")
  ) {
    return null;
  }
  return decodedPath;
}

function resolveStaticFile(root: string, relativePath: string): string | null {
  const candidate = path.resolve(root, relativePath);
  if (!pathWithinRoot(root, candidate)) return null;
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  const realCandidate = fs.realpathSync(candidate);
  return pathWithinRoot(root, realCandidate) ? realCandidate : null;
}

function pathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sendStaticFile(
  reply: FastifyReply,
  filePath: string,
  isIndex: boolean,
  requestPath: string,
): FastifyReply {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = STATIC_CONTENT_TYPES[extension] ?? "application/octet-stream";
  const immutable = !isIndex && isViteHashedAsset(requestPath);
  return reply
    .type(contentType)
    .header("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache")
    .header("x-content-type-options", "nosniff")
    .send(fs.createReadStream(filePath));
}

function isViteHashedAsset(requestPath: string): boolean {
  return /^assets\/(?:[^/]+\/)*[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+(?:\.map)?$/.test(requestPath);
}

function normalizeExistingDatabase(dbPath: string): void {
  if (!databaseExists(dbPath)) return;
  try {
    const db = openDatabase(dbPath);
    db.close();
  } catch (error) {
    if (error instanceof Error && /file is not a database|database disk image is malformed/i.test(error.message)) {
      return;
    }
    throw error;
  }
}

function outreachTransitionError(reply: FastifyReply, error: unknown): { ok: false; error: string; message: string } {
  if (error instanceof OutreachNotFoundError) {
    void reply.code(404);
    return { ok: false, error: "outreach_thread_not_found", message: error.message };
  }
  if (error instanceof OutreachInputError) {
    void reply.code(400);
    return { ok: false, error: "invalid_outreach_transition", message: error.message };
  }
  throw error;
}

function providerOperationError(
  error: "provider_status_failed" | "provider_verification_failed" | "provider_models_failed",
  message: string,
) {
  return { ok: false as const, error, message };
}

async function dispatchProviderModelCatalog(
  dispatcher: JsonRpcDispatcher,
): Promise<{ providers: ProviderModelCatalogItem[] }> {
  const response = await dispatcher.call("provider_models", {});
  if (response.error) {
    throw new Error("provider model catalog RPC failed");
  }
  const parsed = ProviderModelCatalogResultSchema.safeParse(response.result);
  if (!parsed.success) {
    throw new Error("provider model catalog RPC returned an invalid response");
  }
  return parsed.data;
}

async function dispatchBrowserCapabilities(
  reply: FastifyReply,
  dispatcher: JsonRpcDispatcher,
  method: Parameters<JsonRpcDispatcher["call"]>[0],
  params: Record<string, unknown>,
) {
  const response = await dispatcher.call(method, params);
  if (response.error) {
    void reply.code(response.error.code === JsonRpcErrorCodes.InvalidParams ? 400 : 502);
    return {
      ok: false as const,
      error: "browser_capability_failed" as const,
      message:
        response.error.code === JsonRpcErrorCodes.InvalidParams
          ? response.error.message
          : "The browser capability request could not be completed.",
    };
  }
  const parsed = BrowserCapabilitiesResultSchema.safeParse(response.result);
  if (!parsed.success) {
    void reply.code(502);
    return {
      ok: false as const,
      error: "browser_capability_failed" as const,
      message: "Browser capability status is temporarily unavailable.",
    };
  }
  return { ok: true as const, ...parsed.data };
}

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extensionAuthStatus(): ExtensionAuthStatusResponse {
  return {
    ok: true,
    authenticated: true,
    capabilities: ["capture", "autofill_read"],
  };
}

function extensionCaptureToManualCapture(
  input: ExtensionCaptureIngestRequest,
): ManualCaptureImportRequest {
  return {
    captureMode: input.captureMode,
    ...(input.capturedUrl ? { capturedUrl: input.capturedUrl } : {}),
    ...(input.contentText ? { contentText: input.contentText } : {}),
    ...(input.contentHtmlBase64 ? { contentHtmlBase64: input.contentHtmlBase64 } : {}),
    ...(input.note ? { note: input.note } : {}),
    futureManualActionRequired: input.futureManualActionRequired,
  };
}

function installVitestInjectMutationDefaults(app: FastifyInstance): void {
  if (process.env["VITEST"] !== "true") {
    return;
  }
  const originalInject = app.inject.bind(app) as (...args: unknown[]) => unknown;
  app.inject = ((...args: unknown[]) => {
    const [firstArg] = args;
    if (isInjectOptions(firstArg) && shouldDefaultFirstPartyMutationHeaders(firstArg)) {
      args[0] = {
        ...firstArg,
        headers: { origin: "http://127.0.0.1:5173" },
      };
    }
    return originalInject(...args);
  }) as FastifyInstance["inject"];
}

function isInjectOptions(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shouldDefaultFirstPartyMutationHeaders(options: Record<string, unknown>): boolean {
  const method = typeof options["method"] === "string" ? options["method"].toUpperCase() : "GET";
  return UNSAFE_METHODS.has(method) && !Object.hasOwn(options, "headers");
}

function isExtensionCorsPath(url: string): boolean {
  return isExtensionAuthenticatedApiPath(url);
}

function isExtensionAuthenticatedApiPath(url: string): boolean {
  const pathname = requestPathname(url);
  return (
    pathname.startsWith(EXTENSION_API_PREFIX) &&
    pathname !== EXTENSION_PAIRING_TOKEN_PATH &&
    pathname !== EXTENSION_PAIRING_TOKEN_ROTATE_PATH
  );
}

function hasTrustedExtensionToken(request: FastifyRequest, appDir: string): boolean {
  return (
    isExtensionAuthenticatedApiPath(request.url) &&
    Boolean(resolveExtensionCorsOrigin(request.headers.origin)) &&
    isAuthorizedLocalCapabilityToken(request.headers.authorization, appDir)
  );
}

function hasTrustedLocalCapabilityToken(request: FastifyRequest, appDir: string): boolean {
  return !hasBrowserRequestMetadata(request) && isAuthorizedLocalCapabilityToken(request.headers.authorization, appDir);
}

function isAuthorizedExtensionApiRequest(request: FastifyRequest, appDir: string): boolean {
  if (request.method === "OPTIONS" || !isExtensionAuthenticatedApiPath(request.url)) {
    return true;
  }
  return isAuthorizedLocalCapabilityToken(request.headers.authorization, appDir);
}

function isTrustedExtensionPairingRequest(request: FastifyRequest): boolean {
  if (resolveExtensionCorsOrigin(request.headers.origin)) {
    return false;
  }
  const hasBrowserOriginMetadata =
    hasRequestHeader(request.headers.origin) || hasRequestHeader(request.headers.referer);
  if (!hasBrowserOriginMetadata) {
    return true;
  }
  return (
    isTrustedMutationSource(request.headers.origin, request.headers.referer) &&
    isFirstPartyPairingFetch(request.headers["sec-fetch-site"])
  );
}

function isFirstPartyPairingFetch(secFetchSiteHeader: string | string[] | undefined): boolean {
  const values = requestHeaderValues(secFetchSiteHeader);
  return (
    values.length > 0 &&
    values.every((value) => FIRST_PARTY_PAIRING_SEC_FETCH_SITE_VALUES.has(value.trim()))
  );
}

function rejectInvalidExtensionToken(request: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
  if (!isExtensionAuthenticatedApiPath(request.url)) {
    return undefined;
  }
  return reply.code(401).send({
    ok: false,
    error: "invalid_extension_capability_token",
    message: "Extension API requests require a valid local capability token.",
  });
}

function requestPathname(url: string): string {
  try {
    return new URL(url, "http://127.0.0.1").pathname;
  } catch {
    return url.split("?", 1)[0] || "/";
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

function artifactPathWithinAppDir(appDir: string, targetPath: string): boolean {
  try {
    const root = fs.realpathSync(appDir);
    const resolved = fs.realpathSync(targetPath);
    const relative = path.relative(root, resolved);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

type HtmlPreviewArtifactRow = { render_format?: string | null; metadata_json?: string | null } | undefined;

type HtmlPreviewResult =
  | { ok: true; htmlPath: string }
  | { ok: false; error: string; message: string; statusCode: number };

function htmlPreviewForArtifact(
  detail: { artifact: { localPath: string; type: string } },
  row: HtmlPreviewArtifactRow,
): HtmlPreviewResult {
  if (!isPdfArtifact(detail.artifact.type, detail.artifact.localPath)) {
    return {
      ok: false,
      statusCode: 415,
      error: "artifact_preview_unsupported",
      message: "Only HTML-rendered resume PDF artifacts expose an editable HTML preview.",
    };
  }
  const pdfPath = detail.artifact.localPath;
  const siblingHtmlPath = path.resolve(path.join(path.dirname(pdfPath), `${path.parse(pdfPath).name}.html`));
  const metadata = safeJsonObject(row?.metadata_json);
  const hasMetadataHtmlPath = typeof metadata?.html_path === "string" && metadata.html_path.trim().length > 0;
  const hasLegacySiblingHtml = fs.existsSync(siblingHtmlPath);
  if (row?.render_format && row.render_format !== "html_pdf") {
    return {
      ok: false,
      statusCode: 415,
      error: "artifact_preview_unsupported",
      message: "This artifact was not rendered through the HTML/CSS resume renderer.",
    };
  }
  if (!row?.render_format && !hasMetadataHtmlPath && !hasLegacySiblingHtml) {
    return {
      ok: false,
      statusCode: 415,
      error: "artifact_preview_unsupported",
      message: "This artifact does not expose an HTML/CSS resume preview.",
    };
  }
  const metadataHtmlPath =
    typeof metadata?.html_path === "string" && metadata.html_path.trim()
      ? path.resolve(metadata.html_path)
      : siblingHtmlPath;
  if (metadataHtmlPath !== siblingHtmlPath) {
    return {
      ok: false,
      statusCode: 415,
      error: "artifact_preview_unsupported",
      message: "The artifact HTML preview metadata does not point to the expected sibling HTML file.",
    };
  }
  if (!fs.existsSync(siblingHtmlPath) || !fs.statSync(siblingHtmlPath).isFile()) {
    return {
      ok: false,
      statusCode: 404,
      error: "artifact_html_missing",
      message: "The generated HTML preview file is missing.",
    };
  }
  return { ok: true, htmlPath: siblingHtmlPath };
}

function artifactPreviewRow(db: ApiDb, artifactId: string): HtmlPreviewArtifactRow {
  if (!tableExists(db, "job_materials_artifacts")) return undefined;
  const columns = columnNames(db, "job_materials_artifacts");
  const renderFormatSelect = columns.has("render_format") ? "render_format" : "NULL AS render_format";
  const metadataSelect = columns.has("metadata_json") ? "metadata_json" : "NULL AS metadata_json";
  return db
    .prepare(
      `SELECT ${renderFormatSelect}, ${metadataSelect}
         FROM job_materials_artifacts
        WHERE artifact_id = ?`,
    )
    .get(artifactId) as HtmlPreviewArtifactRow;
}

function safeJsonObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function retryContinuationStages(stage: Stage): Stage[] {
  switch (stage) {
    case "enrich":
      return ["enrich", "score", "tailor", "cover"];
    case "score":
      return ["score", "tailor", "cover"];
    case "tailor":
      return ["tailor", "cover"];
    case "cover":
      return ["cover"];
    case "apply":
      return ["apply"];
    default:
      return [];
  }
}

const PREPARATION_PICKUP_STAGES: ReadonlySet<Stage> = new Set(["enrich", "score", "tailor", "cover"]);
const PREPARATION_STAGE_ORDER = ["enrich", "score", "tailor", "cover"] as const satisfies readonly Stage[];
const PREPARATION_PICKUP_MAX_ATTEMPTS: Partial<Record<Stage, number>> = {
  tailor: 5,
  cover: 5,
};

interface BulkRetryTargetGroup {
  readonly stage: Stage;
  readonly jobUrls: string[];
}

function groupRunnableBulkRetryTargets(targets: readonly RetryFailedJobTarget[]): BulkRetryTargetGroup[] {
  const groups = new Map<Stage, string[]>();
  for (const target of targets) {
    if (!PREPARATION_PICKUP_STAGES.has(target.stage)) {
      continue;
    }
    const group = groups.get(target.stage) ?? [];
    group.push(target.jobUrl);
    groups.set(target.stage, group);
  }
  return [...groups.entries()].map(([stage, jobUrls]) => ({ stage, jobUrls }));
}

function pendingPreparationTargets(
  db: ApiDb,
  request: BulkRunPendingPreparationRequest,
): RetryFailedJobTarget[] {
  const targets: RetryFailedJobTarget[] = [];
  for (const jobUrl of candidateJobUrls(db, request)) {
    const stage = firstEligiblePendingPreparationStage(db, jobUrl, request.minScore);
    if (stage) {
      targets.push({ jobUrl, stage });
    }
  }
  return targets;
}

function candidateJobUrls(
  db: ApiDb,
  request: Pick<BulkRunPendingPreparationRequest, "allMatching" | "filter" | "jobKeys">,
): string[] {
  const jobKeys = request.allMatching
    ? matchingJobKeys(db, request.filter ?? {})
    : request.jobKeys;
  const unique = new Set<string>();
  for (const jobKey of jobKeys) {
    const jobUrl = resolveJobUrl(db, jobKey);
    if (jobUrl) {
      unique.add(jobUrl);
    }
  }
  return [...unique];
}

function requireJobId(db: ApiDb, jobLocator: string): string {
  const jobId = resolveJobId(db, "local", jobLocator);
  if (!jobId) {
    throw new InputError(`Unknown job selection: ${jobLocator}`);
  }
  return jobId;
}

function firstEligiblePendingPreparationStage(
  db: ApiDb,
  jobUrl: string,
  minScore: number,
): Stage | null {
  for (const stage of PREPARATION_STAGE_ORDER) {
    const eligibility = preparationPickupEligibility(db, jobUrl, stage, minScore);
    if (eligibility.eligible) {
      return stage;
    }
  }
  return null;
}

function stageCountsForTargets(targets: readonly RetryFailedJobTarget[]): Partial<Record<Stage, number>> {
  const counts: Partial<Record<Stage, number>> = {};
  for (const target of targets) {
    counts[target.stage] = (counts[target.stage] ?? 0) + 1;
  }
  return counts;
}

function bulkRetryRunStageCommand(
  stage: Stage,
  jobUrls: readonly string[],
  request: BulkRetryFailedRequest,
): ActionCommandPayload {
  const stages = retryContinuationStages(stage);
  const command: ActionCommandPayload = {
    action: "run_stage",
    jobKey: PIPELINE_ACTION_JOB_KEY,
    jobKeys: [...jobUrls],
    stage,
    stages,
    dryRun: request.dryRun,
    limit: jobUrls.length,
    workers: request.workers,
    minScore: request.minScore,
    validationMode: request.validationMode,
    llmModel: request.llmModel,
  };
  if (request.reason) {
    command.reason = request.reason;
  }
  return command;
}

function pendingPreparationRunStageCommand(
  stage: Stage,
  jobUrls: readonly string[],
  request: BulkRunPendingPreparationRequest,
): ActionCommandPayload {
  const command = bulkRetryRunStageCommand(stage, jobUrls, {
    allMatching: false,
    jobKeys: [...jobUrls],
    runAfter: true,
    workers: request.workers,
    minScore: request.minScore,
    validationMode: request.validationMode,
    dryRun: request.dryRun,
    llmModel: request.llmModel,
    ...(request.reason ? { reason: request.reason } : {}),
  });
  if (request.reason) {
    command.reason = request.reason;
  }
  return command;
}

function bulkRetryWorkflowPayload(
  command: ActionCommandPayload,
  dispatch: ActionDispatchResult,
  jobUrls: readonly string[],
): Record<string, unknown> {
  return {
    source: "bulk_retry_failed",
    action: command.action,
    stage: command.stage,
    stages: command.stages ?? [],
    jobUrls: [...jobUrls],
    jobCount: jobUrls.length,
    requestedWorkers: command.workers,
    requestedLimit: command.limit,
    requestedMinScore: command.minScore,
    validationMode: command.validationMode,
    dryRun: Boolean(command.dryRun),
    status: dispatch.status,
  };
}

function pendingPreparationWorkflowPayload(
  command: ActionCommandPayload,
  dispatch: ActionDispatchResult,
  jobUrls: readonly string[],
): Record<string, unknown> {
  return {
    ...bulkRetryWorkflowPayload(command, dispatch, jobUrls),
    source: "bulk_run_pending_preparation",
  };
}

interface PreparationPickupEligibility {
  eligible: boolean;
  reason: string;
  message: string;
}

interface PreparationPickupRow {
  full_description: string | null;
  fit_score: number | null;
  score_breakdown_json: string | null;
  score_version: number | null;
  has_resume: number | null;
  has_cover_letter: number | null;
  has_pdf: number | null;
  stage_state: string | null;
  attempt_count: number | null;
  max_attempts: number | null;
  score_stage_state: string | null;
  unresolved_stale_scores: number | null;
}

function preparationPickupEligibility(
  db: ApiDb,
  jobUrl: string,
  stage: Stage,
  minScore: number,
): PreparationPickupEligibility {
  if (!tableExists(db, "job_list_projections")) {
    return ineligiblePickup("projection_unavailable", "Preparation pickup is waiting for job projections.");
  }
  const staleScoreSelect = tableExists(db, "job_score_staleness")
    ? `(SELECT COUNT(*)
        FROM job_score_staleness stale
        WHERE stale.tenant_id = 'local'
          AND stale.job_url = jobs.url
          AND stale.resolved = 0)`
    : "0";
  const row = db
    .prepare(
      `SELECT
         projections.full_description,
         projections.fit_score,
         projections.score_breakdown_json,
         projections.score_version,
         projections.has_resume,
         projections.has_cover_letter,
         projections.has_pdf,
         stage_state.state AS stage_state,
         stage_state.attempt_count,
         stage_state.max_attempts,
         score_state.state AS score_stage_state,
         ${staleScoreSelect} AS unresolved_stale_scores
       FROM jobs
       LEFT JOIN job_list_projections projections
         ON projections.tenant_id = 'local' AND projections.job_id = jobs.url
       LEFT JOIN job_stage_states stage_state
         ON stage_state.job_url = jobs.url AND stage_state.stage = ?
       LEFT JOIN job_stage_states score_state
         ON score_state.job_url = jobs.url AND score_state.stage = 'score'
       WHERE jobs.url = ?
       LIMIT 1`,
    )
    .get(stage, jobUrl) as PreparationPickupRow | undefined;
  if (!row) {
    return ineligiblePickup("job_not_found", "Job is no longer available for preparation pickup.");
  }
  if ((row.stage_state ?? "pending") !== "pending") {
    return ineligiblePickup("stage_not_pending", `The ${stage} stage is not pending.`);
  }
  if (stageAttemptsExhausted(stage, row)) {
    return ineligiblePickup("stage_attempts_exhausted", `The ${stage} stage has exhausted automatic attempts.`);
  }

  const hasFullDescription = Boolean(row.full_description?.trim());
  const fitScore = row.fit_score === null || row.fit_score === undefined ? null : Number(row.fit_score);
  const scoreIsStale = Number(row.unresolved_stale_scores ?? 0) > 0;
  const scoreIsCurrentForDownstream =
    !scoreIsStale &&
    ((row.score_stage_state ?? null) === null ||
      row.score_stage_state === "succeeded" ||
      (row.score_version === null && row.score_stage_state !== "stale"));
  const scoreBlocked = scoreBreakdownBlocksDownstream(row.score_breakdown_json);
  const hasResume = Boolean(row.has_resume);
  const hasCoverLetter = Boolean(row.has_cover_letter);
  const hasPdf = Boolean(row.has_pdf);

  if (stage === "enrich") {
    return hasFullDescription
      ? ineligiblePickup("already_enriched", "Job already has enriched posting detail.")
      : eligiblePickup();
  }
  if (stage === "score") {
    if (!hasFullDescription) {
      return ineligiblePickup("missing_description", "Job needs enrichment before scoring.");
    }
    return fitScore === null || scoreIsStale
      ? eligiblePickup()
      : ineligiblePickup("already_scored", "Job already has a current score.");
  }

  const downstreamBlock = downstreamPreparationBlock({
    fitScore,
    minScore,
    hasFullDescription,
    scoreIsCurrentForDownstream,
    scoreBlocked,
  });
  if (downstreamBlock) {
    return downstreamBlock;
  }
  if (stage === "tailor") {
    return hasResume
      ? ineligiblePickup("already_tailored", "Job already has a tailored resume.")
      : eligiblePickup();
  }
  if (stage === "cover") {
    if (!hasResume) {
      return ineligiblePickup("missing_resume", "Job needs a tailored resume before cover generation.");
    }
    if (!hasPdf) {
      return ineligiblePickup("missing_resume_pdf", "Job needs a rendered tailored resume before cover generation.");
    }
    return hasCoverLetter
      ? ineligiblePickup("already_covered", "Job already has a cover letter.")
      : eligiblePickup();
  }
  return ineligiblePickup("unsupported_stage", `Stage ${stage} is not eligible for automatic pickup.`);
}

function downstreamPreparationBlock(input: {
  fitScore: number | null;
  minScore: number;
  hasFullDescription: boolean;
  scoreIsCurrentForDownstream: boolean;
  scoreBlocked: boolean;
}): PreparationPickupEligibility | null {
  if (input.fitScore === null) {
    return ineligiblePickup("missing_score", "Job needs a score before materials generation.");
  }
  if (input.fitScore < input.minScore) {
    return ineligiblePickup("score_below_threshold", "Job score is below the materials threshold.");
  }
  if (!input.hasFullDescription) {
    return ineligiblePickup("missing_description", "Job needs enrichment before materials generation.");
  }
  if (input.scoreBlocked) {
    return ineligiblePickup("score_blocks_downstream", "Score eligibility blocks materials generation.");
  }
  if (!input.scoreIsCurrentForDownstream) {
    return ineligiblePickup("score_not_current", "Job needs a current score before materials generation.");
  }
  return null;
}

function stageAttemptsExhausted(stage: Stage, row: PreparationPickupRow): boolean {
  if (row.stage_state === "exhausted") {
    return true;
  }
  const maxAttempts = row.max_attempts ?? PREPARATION_PICKUP_MAX_ATTEMPTS[stage] ?? null;
  if (maxAttempts === null) {
    return false;
  }
  return Number(row.attempt_count ?? 0) >= Number(maxAttempts);
}

function scoreBreakdownBlocksDownstream(scoreBreakdownJson: string | null): boolean {
  if (!scoreBreakdownJson) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(scoreBreakdownJson);
    if (!parsed || typeof parsed !== "object") {
      return false;
    }
    const eligibility = (parsed as { eligibility?: unknown }).eligibility;
    if (!eligibility || typeof eligibility !== "object") {
      return false;
    }
    const status = String((eligibility as { status?: unknown }).status ?? "").toLowerCase();
    if (status === "blocked") {
      return true;
    }
    return ["hard_blockers", "hardBlockers", "blockers"].some((key) => {
      const value = (eligibility as Record<string, unknown>)[key];
      return Array.isArray(value) && value.length > 0;
    });
  } catch {
    return false;
  }
}

function eligiblePickup(): PreparationPickupEligibility {
  return { eligible: true, reason: "eligible", message: "Preparation pickup is eligible." };
}

function ineligiblePickup(reason: string, message: string): PreparationPickupEligibility {
  return { eligible: false, reason, message };
}

function withDb<T>(
  reply: { code: (statusCode: number) => unknown },
  dbPath: string,
  read: (db: ReturnType<typeof openDatabase>) => T,
): T | { ok: false; error: string; message: string } {
  if (!databaseExists(dbPath)) {
    void reply.code(503);
    return { ok: false, error: "db_not_found", message: `No JobCtrl database found at ${dbPath}` };
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
    if (error instanceof ResumeTemplateInputError) {
      void reply.code(400);
      return {
        ok: false,
        error: "invalid_resume_template",
        message: error.message,
      };
    }
    const opened = db !== null;
    void reply.code(opened ? 500 : 503);
    return {
      ok: false,
      error: opened ? "db_read_failed" : "db_open_failed",
      message: error instanceof Error ? error.message : "Unable to read the JobCtrl database.",
    };
  } finally {
    db?.close();
  }
}

async function withWritableDb<T>(
  reply: { code: (statusCode: number) => unknown },
  dbPath: string,
  write: (db: ReturnType<typeof openDatabase>) => T | Promise<T>,
): Promise<T | {
  ok: false;
  error: string;
  message: string;
  field?: string;
  source?: string;
}> {
  if (!databaseExists(dbPath)) {
    void reply.code(503);
    return { ok: false, error: "db_not_found", message: `No JobCtrl database found at ${dbPath}` };
  }

  let db: ReturnType<typeof openDatabase> | null = null;
  try {
    db = openDatabase(dbPath);
    return await write(db);
  } catch (error) {
    if (error instanceof ResumeTemplateInputError) {
      void reply.code(400);
      return { ok: false, error: "invalid_resume_template", message: error.message };
    }
    if (error instanceof InputError) {
      if (APPLY_REVIEW_PRECONDITION_ERRORS.has(error.message)) {
        void reply.code(409);
        return {
          ok: false,
          error: error.message,
          message: applyReviewPreconditionMessage(error.message),
        };
      }
      void reply.code(404);
      return { ok: false, error: "not_found", message: error.message };
    }
    void reply.code(500);
    return {
      ok: false,
      error: "db_write_failed",
      message: error instanceof Error ? error.message : "Unable to write the JobCtrl database.",
    };
  } finally {
    db?.close();
  }
}

function applyReviewPreconditionMessage(error: string): string {
  if (error === "repeat_application_blocked") {
    return "A confirmed application to this canonical opening blocks another live submission. Inspect the prior application before recording an explicit confirmation.";
  }
  if (error === "repeat_application_confirmation_required") {
    return "A confirmed application to the same employer and an equivalent role requires explicit confirmation before live submission.";
  }
  if (error === "repeat_application_override_consumed") {
    return "The matching repeat-application confirmation was already used. Review the evidence and record a new confirmation for another live attempt.";
  }
  if (error === "repeat_application_evidence_stale") {
    return "The prior-application evidence changed. Refresh apply review and inspect the current relationship before confirming.";
  }
  if (error === "repeat_application_prior_mismatch") {
    return "The selected prior application no longer matches the current evidence. Refresh apply review and choose a current record.";
  }
  if (error === "repeat_application_confirmation_not_required") {
    return "No current repeat-application warning requires confirmation.";
  }
  if (error === "approval_stale_materials") {
    return "The reviewed materials changed before submit approval. Refresh apply review and approve again.";
  }
  if (error === "approval_stale_profile") {
    return "The reviewed profile changed before submit approval. Refresh apply review and approve again.";
  }
  if (error === "approval_stale_url") {
    return "The reviewed application URL changed before submit approval. Refresh apply review and approve again.";
  }
  if (error === "approval_stale_email_candidate") {
    return "The email application recipient or attachment changed before submit approval. Refresh apply review and approve again.";
  }
  if (error === "partial_override_evidence_invalid") {
    return "The selected partial dry-run evidence no longer matches this job's current materials, profile, and URL.";
  }
  return "Submit approval requires matching full dry-run evidence or an explicit matching partial dry-run override.";
}

type ApiDb = ReturnType<typeof openDatabase>;

function recordPipelineWorkflowStarted(
  dbPath: string,
  stage: Stage,
  workflowId: string,
  runId: string | undefined,
  extraPayload: Record<string, unknown> = {},
): void {
  recordPipelineWorkflowEvent(dbPath, {
    stage,
    eventType: "StageStarted",
    level: "info",
    message: `${labelForStage(stage)} workflow started`,
    workflowId,
    runId,
    progressStatus: "running",
    extraPayload,
  });
}

function recordPipelineWorkflowCancelRequested(dbPath: string, workflowId: string): void {
  if (!databaseExists(dbPath)) return;
  let db: ApiDb | null = null;
  try {
    db = openDatabase(dbPath);
    const latest = latestPipelineWorkflowEvent(db, workflowId);
    if (!latest) return;
    const payload = parseJsonRecord(latest.payload_json);
    const progress = isRecord(payload.progress) ? payload.progress : {};
    const stage = isStage(latest.stage) ? latest.stage : isStage(payload.stage) ? payload.stage : null;
    if (!stage) return;
    const sourceRunId = textValue(payload.runId ?? payload.run_id);
    const message = `${labelForStage(stage)} canceled`;
    const now = new Date().toISOString();
    const progressPayload = {
      completed: numberValue(progress.completed ?? progress.progressCompleted) ?? 0,
      total: numberValue(progress.total ?? progress.progressTotal) ?? 1,
      percent: numberValue(progress.percent ?? progress.progressPercent) ?? 0,
      currentStep: textValue(progress.currentStep ?? progress.current_step) || null,
      status: "failed",
      message,
      ...(isRecord(progress.sourceProgress)
        ? { sourceProgress: progress.sourceProgress }
        : isRecord(progress.source_progress)
          ? { sourceProgress: progress.source_progress }
          : {}),
    };
    insertJobEvent(db, {
      jobUrl: null,
      stage,
      eventType: "StageFailed",
      level: "warn",
      message,
      payload: {
        tenantId: "local",
        jobId: PIPELINE_ACTION_JOB_KEY,
        stage,
        workflowId,
        workflow_id: workflowId,
        ...(sourceRunId ? { runId: sourceRunId, run_id: sourceRunId } : {}),
        errorCode: "pipeline_stage_canceled",
        errorMessage: message,
        retryable: true,
        progress: progressPayload,
      },
    });
    if (stage === "discover" && sourceRunId) {
      insertJobEvent(db, {
        jobUrl: null,
        stage,
        eventType: "DiscoveryRunFailed",
        level: "warn",
        message: `Discovery run ${sourceRunId} canceled`,
        payload: {
          tenantId: "local",
          runId: sourceRunId,
          run_id: sourceRunId,
          errorClass: "canceled",
          error_class: "canceled",
          failedAt: now,
          failed_at: now,
          retryable: true,
        },
      });
      markDiscoveryRunCanceled(db, {
        runId: sourceRunId,
        workflowId,
        failedAt: now,
        progress: progressPayload,
      });
    }
  } catch {
    // Cancellation should still reach Temporal even if local projection repair fails.
  } finally {
    db?.close();
  }
}

function markDiscoveryRunCanceled(
  db: ApiDb,
  cancellation: {
    runId: string;
    workflowId: string;
    failedAt: string;
    progress: Record<string, unknown>;
  },
): void {
  if (!tableExists(db, "discovery_runs")) return;
  const columns = columnNames(db, "discovery_runs");
  const assignments: string[] = ["status = ?", "error_classes_json = ?", "failed_at = ?"];
  const values: unknown[] = ["failed", JSON.stringify(["canceled"]), cancellation.failedAt];

  if (columns.has("updated_at")) {
    assignments.push("updated_at = ?");
    values.push(cancellation.failedAt);
  }
  if (columns.has("progress_json")) {
    assignments.push("progress_json = ?");
    values.push(JSON.stringify(cancellation.progress));
  }
  if (columns.has("workflow_id")) {
    assignments.push("workflow_id = COALESCE(workflow_id, ?)");
    values.push(cancellation.workflowId);
  }

  values.push(cancellation.runId);
  db.prepare(`UPDATE discovery_runs SET ${assignments.join(", ")} WHERE run_id = ? AND status = 'running'`).run(
    ...values,
  );
}

function recordPipelineWorkflowEvent(
  dbPath: string,
  event: {
    stage: Stage;
    eventType: string;
    level: string;
    message: string;
    workflowId: string;
    runId: string | undefined;
    progressStatus: "running" | "failed";
    extraPayload?: Record<string, unknown>;
  },
): void {
  if (!databaseExists(dbPath)) return;
  let db: ApiDb | null = null;
  try {
    db = openDatabase(dbPath);
    insertJobEvent(db, {
      jobUrl: null,
      stage: event.stage,
      eventType: event.eventType,
      level: event.level,
      message: event.message,
      payload: {
        tenantId: "local",
        jobId: PIPELINE_ACTION_JOB_KEY,
        stage: event.stage,
        workflowId: event.workflowId,
        workflow_id: event.workflowId,
        ...(event.runId ? { runId: event.runId, run_id: event.runId } : {}),
        ...(event.extraPayload ?? {}),
        progress: {
          completed: 0,
          total: 1,
          percent: 0,
          currentStep: null,
          status: event.progressStatus,
          message: event.message,
        },
      },
    });
  } catch {
    // Best-effort projection hint; the worker still emits canonical progress events.
  } finally {
    db?.close();
  }
}

function latestPipelineWorkflowEvent(
  db: ApiDb,
  workflowId: string,
): { stage: string | null; payload_json: string | null } | null {
  const row = db.prepare(
    `SELECT stage, payload_json
       FROM job_events
      WHERE tenant_id = 'local'
        AND job_id IS NULL
        AND payload_json IS NOT NULL
        AND json_valid(payload_json)
        AND (
          JSON_EXTRACT(payload_json, '$.workflowId') = ?
          OR JSON_EXTRACT(payload_json, '$.workflow_id') = ?
        )
      ORDER BY event_id DESC
      LIMIT 1`,
  ).get(workflowId, workflowId) as
    | { stage: string | null; payload_json: string | null }
    | undefined;
  return row ?? null;
}

function insertJobEvent(
  db: ApiDb,
  event: {
    jobUrl: string | null;
    stage: Stage;
    eventType: string;
    level: string;
    message: string;
    payload: Record<string, unknown>;
  },
): void {
  const jobId = event.jobUrl === null ? null : resolveJobId(db, "local", event.jobUrl);
  if (event.jobUrl !== null && !jobId) {
    throw new InputError("Job not found.");
  }
  const payload = {
    ...event.payload,
    tenantId: "local",
    ...(jobId ? { jobId } : {}),
  };
  db.prepare(
    `INSERT INTO job_events (
       tenant_id, job_id, identity_version, stage, event_type, level,
       message, occurred_at, payload_json
     ) VALUES ('local', ?, 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    event.stage,
    event.eventType,
    event.level,
    event.message,
    new Date().toISOString(),
    JSON.stringify(payload),
  );
}

function tableExists(db: ApiDb, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return Boolean(row);
}

function columnNames(db: ApiDb, tableName: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
}

function parseJsonRecord(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStage(value: unknown): value is Stage {
  return typeof value === "string" && STAGES.includes(value as Stage);
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(textValue(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function labelForStage(stage: Stage): string {
  return `${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;
}

function parseBody<T>(reply: { code: (statusCode: number) => unknown }, schema: ZodType<T>, body: unknown): T | null {
  const parsed = schema.safeParse(body);
  if (parsed.success) {
    return parsed.data;
  }
  void reply.code(400);
  return null;
}

function isTrustedSecFetchSite(
  secFetchSiteHeader: string | string[] | undefined,
  options: { allowLoopbackSameSite?: boolean } = {},
): boolean {
  const values = requestHeaderValues(secFetchSiteHeader);
  const trustedValues = options.allowLoopbackSameSite
    ? LOOPBACK_ORIGIN_SEC_FETCH_SITE_VALUES
    : TRUSTED_SEC_FETCH_SITE_VALUES;
  return values.length === 0 || values.every((value) => trustedValues.has(value.trim()));
}

function requestHeaderValues(header: string | string[] | undefined): string[] {
  return Array.isArray(header) ? header : header ? [header] : [];
}

function hasRequestHeader(header: string | string[] | undefined): boolean {
  return Array.isArray(header) ? header.length > 0 : header !== undefined;
}

function hasBrowserRequestMetadata(request: FastifyRequest): boolean {
  if (hasRequestHeader(request.headers.origin) || hasRequestHeader(request.headers.referer)) {
    return true;
  }
  return SEC_FETCH_HEADER_NAMES.some((header) => hasRequestHeader(request.headers[header]));
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

function resolveExistingJobId(
  reply: { code: (statusCode: number) => unknown },
  db: ReturnType<typeof openDatabase>,
  jobKey: string,
): string | null {
  const jobId = resolveJobId(db, "local", jobKey);
  if (!jobId) {
    void reply.code(404);
    return null;
  }
  return jobId;
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
