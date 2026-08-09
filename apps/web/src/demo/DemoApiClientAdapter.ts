import { JobCtrlApiError } from "@jobctrl/api-client";
import {
  ActivityListQuerySchema,
  ArtifactListQuerySchema,
  ContactListQuerySchema,
  ContactResearchListQuerySchema,
  ENDPOINTS,
  JobListQuerySchema,
  WorkflowRunsListQuerySchema,
  compareJobs,
  compareValues,
  filterJob as sharedFilterJob,
  paginate,
  timestampAtOrAfter,
  timestampBefore,
  type ActivityEventSummary,
  type ArtifactSummary,
  type EndpointClientMethods,
  type JobCompensationSummary,
  type JobSummary,
  type PaginatedResponse,
  type WorkflowRunSummary,
} from "@jobctrl/contracts";

import type { ApiClientPort } from "../shared/ports/ApiClientPort.js";
import type { TelemetryPort } from "../shared/ports/TelemetryPort.js";
import { isDemoArtifactUrl } from "./artifacts.js";
import type { ApiClientResponse, DemoReadModel } from "./contracts.js";
import {
  DemoLocalCommandExecutor,
  type DemoBrowserLocalCommand,
  type DemoLocalCommandExecutorOptions,
} from "./DemoLocalCommandExecutor.js";
import {
  DemoExternalRehearsalExecutor,
  type DemoExternalRehearsalExecutorOptions,
  type DemoInitialExternalRehearsalOperation,
} from "./DemoExternalRehearsalExecutor.js";
import { DemoCapabilityError } from "./ports.js";
import {
  DemoScenarioEngine,
  type DemoScenarioEngineOptions,
} from "./DemoScenarioEngine.js";
import type { DemoWorkspaceRepository } from "./workspace/DemoWorkspaceRepository.js";

type CacheKey = number | string | undefined;

const CLOSED_ACTIVE_STATES = new Set([
  "closed",
  "expired",
  "removed",
  "location_incompatible",
]);

const IN_MEMORY_JOB_SORT_FIELDS = new Set([
  "source",
  "compensation_min_eur",
  "compensation_max_eur",
  "compensation_posted",
  "compensation_market",
  "compensation_confidence",
  "compensation_warnings",
  "apply_status",
]);

export class DemoResourceNotFoundError extends JobCtrlApiError {
  readonly code: string;
  readonly resourceId: string;

  constructor(code: string, resourceId: string) {
    super(404, code);
    this.name = "DemoResourceNotFoundError";
    this.code = code;
    this.resourceId = resourceId;
  }
}

export interface DemoApiClientAdapterOptions extends DemoLocalCommandExecutorOptions {
  readonly scenario?: DemoScenarioEngineOptions;
  readonly external?: DemoExternalRehearsalExecutorOptions;
  readonly telemetry?: TelemetryPort;
}

/** Browser-local adapter for reads, local commands, and deterministic scenarios. */
export class DemoApiClientAdapter implements ApiClientPort {
  private readonly localCommands: DemoLocalCommandExecutor;
  private readonly scenarios: DemoScenarioEngine;
  private readonly externalRehearsals: DemoExternalRehearsalExecutor;
  private readonly telemetry: TelemetryPort | undefined;

  constructor(
    private readonly workspace: DemoWorkspaceRepository,
    options: DemoApiClientAdapterOptions = {},
  ) {
    this.localCommands = new DemoLocalCommandExecutor(workspace, options);
    this.telemetry = options.telemetry;
    this.scenarios = new DemoScenarioEngine(
      workspace,
      options.scenario ?? {
        ...(options.clock ? { clock: options.clock } : {}),
        ...(options.createId ? { createId: options.createId } : {}),
      },
    );
    this.externalRehearsals = new DemoExternalRehearsalExecutor(
      workspace,
      options.external ?? {
        opener: () => null,
        ...(options.clock ? { clock: options.clock } : {}),
        ...(options.createId ? { createId: options.createId } : {}),
      },
    );
    Object.assign(
      this,
      Object.fromEntries(
        Object.values(ENDPOINTS)
          .filter((endpoint) => endpoint.demo.class === "unavailable")
          .map((endpoint) => [endpoint.name, this.unsupported(endpoint.name)]),
      ),
    );
  }

  initialize(): Promise<void> {
    return this.scenarios.initialize();
  }

  dispose(): void {
    this.scenarios.dispose();
  }

  health() {
    return this.read((model) => model.dashboard.health);
  }

  dashboardSummary() {
    return this.read((model) => model.dashboard.summary);
  }

  pipelineOperations = this.unsupported("pipelineOperations");

  outcomeAnalytics() {
    return this.read((model) => model.analytics.summary);
  }

  learningRecommendationEvidence = this.unsupported("learningRecommendationEvidence");
  tailoringPolicyRevisions = this.unsupported("tailoringPolicyRevisions");

  digest() {
    return this.read((model) => model.dashboard.digest);
  }

  async activity(
    query: Parameters<ApiClientPort["activity"]>[0] = {},
  ): Promise<ApiClientResponse<"activity">> {
    const normalized = ActivityListQuerySchema.parse(query);
    const source = await this.read((model) => model.dashboard.activity.items);
    const q = normalized.q.toLowerCase();
    const items = source.filter((event) => {
      if (
        normalized.level &&
        event.level.toLowerCase() !== normalized.level.toLowerCase()
      )
        return false;
      if (
        normalized.stage &&
        event.stage.toLowerCase() !== normalized.stage.toLowerCase()
      )
        return false;
      if (
        normalized.eventType &&
        event.eventType.toLowerCase() !== normalized.eventType.toLowerCase()
      )
        return false;
      if (!q) return true;
      return [
        event.level,
        event.stage,
        event.eventType,
        event.message,
        event.title ?? "",
        event.company ?? "",
        event.workflowId ?? "",
        event.jobKey ?? "",
        event.eventId,
        event.at,
      ].some((value) =>
        String(value ?? "")
          .toLowerCase()
          .includes(q),
      );
    });
    items.sort((left, right) =>
      compareActivity(left, right, normalized.sort, normalized.dir),
    );
    return paginate(
      items,
      normalized.page,
      normalized.pageSize,
      normalized.sort,
      normalized.dir,
      {
        q: normalized.q,
        level: normalized.level,
        stage: normalized.stage,
        eventType: normalized.eventType,
      },
    );
  }

  activityEvent(eventId: string) {
    return this.detail(
      (model) => model.dashboard.activityEvents,
      eventId,
      "activity_event_not_found",
    );
  }

  discoverySettings() {
    return this.read((model) => model.discovery.settings);
  }

  discoverySources() {
    return this.read((model) => model.discovery.sources);
  }

  discoverySourcePreview(sourceId: string) {
    return this.detail(
      (model) => model.discovery.sourcePreviews,
      sourceId,
      "discovery_source_not_found",
    );
  }

  compensationSources() {
    return this.read((model) => model.discovery.compensationSources);
  }

  discoveryLocatorCandidates() {
    return this.read((model) => model.discovery.locatorCandidates);
  }

  discoveryQuarantine() {
    return this.read((model) => model.discovery.quarantine);
  }

  manualCaptureQueue() {
    return this.read((model) => model.discovery.manualCapture);
  }

  roleMatchFeedbackSuggestions() {
    return this.read((model) => model.discovery.roleMatchFeedback);
  }

  applyReviewQueue() {
    return this.read((model) => model.apply.queue);
  }

  resumeReviewDraft(jobKey: string) {
    return this.detail(
      (model) => model.materials.resumeReviewDrafts,
      jobKey,
      "resume_review_draft_not_found",
    );
  }

  resumeReviewFeedback(jobKey: string) {
    return this.detail(
      (model) => model.materials.resumeReviewFeedback,
      jobKey,
      "job_not_found",
    );
  }

  resumeTemplates() {
    return this.read((model) => model.materials.resumeTemplates);
  }

  resumeTemplate(templateId: string) {
    return this.detail(
      (model) => model.materials.templateDetails,
      templateId,
      "resume_template_not_found",
    );
  }

  applicationOutcomes() {
    return this.read((model) => model.analytics.outcomes);
  }

  jobApplicationOutcomes(jobKey: string) {
    return this.detail(
      (model) => model.analytics.jobOutcomes,
      jobKey,
      "job_not_found",
    );
  }

  async jobs(
    query: Parameters<ApiClientPort["jobs"]>[0] = {},
  ): Promise<ApiClientResponse<"jobs">> {
    const normalized = JobListQuerySchema.parse(query);
    const source = await this.read((model) => model.jobs.list.items);
    const q = normalized.q.toLowerCase();
    const items = source.filter((job) => filterJob(job, normalized, q));
    items.sort((left, right) =>
      compareJobs(left, right, normalized.sort, normalized.dir, {
        normalizeSqlText:
          !normalized.q && !IN_MEMORY_JOB_SORT_FIELDS.has(normalized.sort),
      }),
    );
    return paginate(
      items,
      normalized.page,
      normalized.pageSize,
      normalized.sort,
      normalized.dir,
      {
        q: normalized.q,
        stage: normalized.stage ?? "",
        state: normalized.state ?? "",
        source: normalized.source,
        company: normalized.company,
        applyStatus: normalized.applyStatus,
        minFitScore: normalized.minFitScore ?? null,
        maxFitScore: normalized.maxFitScore ?? null,
        discoveredSince: normalized.discoveredSince ?? null,
        scoredSince: normalized.scoredSince ?? null,
        deleted: normalized.deleted,
      },
    );
  }

  job(jobKey: string) {
    return this.detail((model) => model.jobs.details, jobKey, "job_not_found");
  }

  evidenceMap() {
    return this.read((model) => model.evidence);
  }

  async workflowRuns(
    query: Parameters<ApiClientPort["workflowRuns"]>[0] = {},
  ): Promise<ApiClientResponse<"workflowRuns">> {
    const normalized = WorkflowRunsListQuerySchema.parse(query);
    const source = await this.read((model) => model.runs.list.items);
    const items = source.filter((run) => filterWorkflowRun(run, normalized));
    items.sort((left, right) =>
      compareWorkflowRuns(left, right, normalized.sort, normalized.dir),
    );
    return paginate(
      items,
      normalized.page,
      normalized.pageSize,
      normalized.sort,
      normalized.dir,
      {
        status: normalized.status,
        workflowType: normalized.workflowType ?? null,
        startedSince: normalized.startedSince ?? null,
        startedBefore: normalized.startedBefore ?? null,
      },
    );
  }

  workflowRun(runId: string) {
    return this.detail(
      (model) => model.runs.details,
      runId,
      "workflow_run_not_found",
    );
  }

  async artifacts(
    query: Parameters<ApiClientPort["artifacts"]>[0] = {},
  ): Promise<ApiClientResponse<"artifacts">> {
    const normalized = ArtifactListQuerySchema.parse(query);
    const source = await this.read((model) => model.materials.list.items);
    const q = normalized.q.toLowerCase();
    const items = source.filter((artifact) => {
      if (!normalized.status && artifact.status.toLowerCase() === "suppressed")
        return false;
      if (normalized.status && artifact.status !== normalized.status)
        return false;
      if (normalized.type && artifact.type !== normalized.type) return false;
      if (!q) return true;
      return [
        artifact.title,
        artifact.company,
        artifact.type,
        artifact.status,
        artifact.localPath,
      ].some((value) => value.toLowerCase().includes(q));
    });
    items.sort((left, right) =>
      compareArtifacts(left, right, normalized.sort, normalized.dir),
    );
    return paginate(
      items,
      normalized.page,
      normalized.pageSize,
      normalized.sort,
      normalized.dir,
      {
        q: normalized.q,
        status: normalized.status,
        type: normalized.type,
      },
    );
  }

  artifact(artifactId: string) {
    return this.detail(
      (model) => model.materials.details,
      artifactId,
      "artifact_not_found",
    );
  }

  artifactPreviewPdfUrl(artifactId: string, cacheKey?: CacheKey): string {
    return artifactPreviewUrl(this.workspace, artifactId, "pdf", cacheKey);
  }

  artifactPreviewHtmlUrl(artifactId: string, cacheKey?: CacheKey): string {
    return artifactPreviewUrl(this.workspace, artifactId, "html", cacheKey);
  }

  profile() {
    return this.read((model) => model.profile.config);
  }

  profilePreviewPdfUrl(cacheKey?: CacheKey): string {
    return profilePreviewUrl(this.workspace, "pdf", cacheKey);
  }

  profilePreviewHtmlUrl(cacheKey?: CacheKey): string {
    return profilePreviewUrl(this.workspace, "html", cacheKey);
  }

  settings() {
    return this.read((model) => model.settings);
  }

  credentials() {
    return this.read((model) => model.profile.credentials);
  }

  async browserCapabilities(): Promise<
    ApiClientResponse<"browserCapabilities">
  > {
    return {
      ok: true,
      detectedBrowsers: [],
      capabilities: [
        {
          id: "core-browser",
          status: "ready",
          detail: "Synthetic demo status; no host browser is inspected.",
          mutable: false,
          enabled: true,
          profileCopyReady: false,
        },
        {
          id: "auto-apply-browser",
          status: "disabled",
          detail: "Browser adoption is unavailable in the public demo.",
          mutable: true,
          enabled: false,
          profileCopyReady: false,
        },
        {
          id: "authenticated-linkedin-browser",
          status: "disabled",
          detail: "Profile copy is unavailable in the public demo.",
          mutable: true,
          enabled: false,
          profileCopyReady: false,
        },
      ],
    };
  }

  async providerModels(): Promise<ApiClientResponse<"providerModels">> {
    return {
      ok: true,
      providers: [
        {
          provider: "codex",
          configured: true,
          ready: true,
          source: "live",
          models: [
            { id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true },
            { id: "gpt-5.4", displayName: "GPT-5.4" },
          ],
          message: "Synthetic preview catalog; no Codex account is connected.",
        },
        {
          provider: "claude",
          configured: true,
          ready: true,
          source: "live",
          models: [
            { id: "claude-fable-5", displayName: "Fable 5" },
            { id: "claude-opus-4-8", displayName: "Opus 4.8", isDefault: true },
            { id: "claude-sonnet-5", displayName: "Sonnet 5" },
          ],
          message: "Synthetic preview catalog; no Claude account is connected.",
        },
        {
          provider: "google",
          configured: true,
          ready: true,
          source: "live",
          models: [
            {
              id: "gemini-2.5-pro",
              displayName: "Gemini 2.5 Pro",
              isDefault: true,
            },
            { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
          ],
          message: "Synthetic preview catalog; no Google account is connected.",
        },
      ],
    };
  }

  async providerStatus(): Promise<ApiClientResponse<"providerStatus">> {
    return {
      ok: true,
      providers: [
        { provider: "codex", configured: false, ready: false, mode: null },
        { provider: "claude", configured: false, ready: false, mode: null },
        { provider: "google", configured: false, ready: false, mode: null },
      ],
    };
  }

  async listContacts(
    query: Parameters<ApiClientPort["listContacts"]>[0] = {},
  ): Promise<ApiClientResponse<"listContacts">> {
    const normalized = ContactListQuerySchema.parse(query);
    const response = await this.read((model) => model.contacts.list);
    response.items = response.items.filter(
      (contact) =>
        (!normalized.jobId || contact.jobId === normalized.jobId) &&
        (!normalized.employer || contact.employer === normalized.employer),
    );
    response.items.sort((left, right) =>
      compareUpdatedAtThenId(
        left.updatedAt,
        right.updatedAt,
        left.contactId,
        right.contactId,
      ),
    );
    return response;
  }

  contact(contactId: string) {
    return this.detail(
      (model) => model.contacts.details,
      contactId,
      "contact_not_found",
    );
  }

  async researchTasks(
    query: Parameters<ApiClientPort["researchTasks"]>[0] = {},
  ): Promise<ApiClientResponse<"researchTasks">> {
    const normalized = ContactResearchListQuerySchema.parse(query);
    const response = await this.read((model) => model.contacts.researchTasks);
    response.items = response.items.filter(
      (task) =>
        (!normalized.jobId || task.jobId === normalized.jobId) &&
        (!normalized.employer || task.employer === normalized.employer),
    );
    response.items.sort((left, right) =>
      compareUpdatedAtThenId(
        left.updatedAt,
        right.updatedAt,
        left.taskId,
        right.taskId,
      ),
    );
    return response;
  }

  researchTask(taskId: string) {
    return this.detail(
      (model) => model.contacts.researchTaskDetails,
      taskId,
      "research_task_not_found",
    );
  }

  async outreachThread(
    contactId: string,
    query: { jobId?: string } = {},
  ): Promise<ApiClientResponse<"outreachThread">> {
    const response = await this.read((model) => model.outreach.thread);
    if (
      response.thread === null ||
      response.thread.contactId !== contactId ||
      (query.jobId !== undefined && response.thread.jobId !== query.jobId)
    ) {
      throw new DemoResourceNotFoundError(
        "outreach_thread_not_found",
        contactId,
      );
    }
    return response;
  }

  dueOutreachFollowUps() {
    return this.read((model) => model.outreach.dueFollowUps);
  }

  acknowledgeDigest = this.local("acknowledgeDigest");
  updateDiscoverySettings = this.local("updateDiscoverySettings");
  upsertDiscoverySource = this.local("upsertDiscoverySource");
  patchDiscoverySourceState = this.local("patchDiscoverySourceState");
  updateCompensationSourcePolicy = this.local("updateCompensationSourcePolicy");
  promoteSourceLocatorCandidate = this.local("promoteSourceLocatorCandidate");
  rejectSourceLocatorCandidate = this.local("rejectSourceLocatorCandidate");
  decideDiscoveryQuarantine = this.local("decideDiscoveryQuarantine");
  importManualCapture = this.local("importManualCapture");
  dismissManualCapture = this.local("dismissManualCapture");
  recordDiscoveryFeedback = this.local("recordDiscoveryFeedback");
  decideRoleMatchFeedbackSuggestion = this.local(
    "decideRoleMatchFeedbackSuggestion",
  );
  decideApplyReview = this.local("decideApplyReview");
  confirmRepeatApplication = this.unsupported("confirmRepeatApplication");
  createResumeReviewDraft = this.local("createResumeReviewDraft");
  saveResumeReviewDraftRevision = this.local("saveResumeReviewDraftRevision");
  seedResumeReviewCommentThreads = this.local("seedResumeReviewCommentThreads");
  renderResumeReviewDraft = this.unsupported("renderResumeReviewDraft");
  replyToResumeReviewComment = this.local("replyToResumeReviewComment");
  saveResumeTemplate = this.local("saveResumeTemplate");
  setDefaultResumeTemplate = this.local("setDefaultResumeTemplate");
  setJobResumeTemplate = this.local("setJobResumeTemplate");
  ensureCurrentResumeMaterials = this.unsupported(
    "ensureCurrentResumeMaterials",
  );
  recordManualApplicationOutcome = this.local("recordManualApplicationOutcome");
  decideOutcomeSuggestion = this.local("decideOutcomeSuggestion");
  deleteJob = this.local("deleteJob");
  deleteJobs = this.local("deleteJobs");
  permanentlyDeleteJob = this.local("permanentlyDeleteJob");
  permanentlyDeleteJobs = this.local("permanentlyDeleteJobs");
  restoreJob = this.local("restoreJob");
  restoreJobs = this.local("restoreJobs");
  hideJob = this.local("hideJob");
  hideJobs = this.local("hideJobs");
  unhideJob = this.local("unhideJob");
  unhideJobs = this.local("unhideJobs");
  retryFailedJobs = this.unsupported("retryFailedJobs");
  runPendingPreparation = this.unsupported("runPendingPreparation");
  correctScore = this.local("correctScore");
  resetStaleScoresForRescore = this.local("resetStaleScoresForRescore");
  rescoreJob = this.simulated("rescoreJob");
  refreshCompensation = this.unsupported("refreshCompensation");
  refreshAllCompensation = this.unsupported("refreshAllCompensation");
  rescoreJobsNotOnCurrentScoringPolicy = this.unsupported(
    "rescoreJobsNotOnCurrentScoringPolicy",
  );
  retailorJob = this.simulated("retailorJob");
  tailorJob = this.unsupported("tailorJob");
  retailorCurrentPolicy = this.unsupported("retailorCurrentPolicy");
  cancelWorkflowRun = this.local("cancelWorkflowRun");
  openArtifact = this.rehearsed("openArtifact");
  updateProfile = this.local("updateProfile");
  importResume = this.local("importResume");
  updateSettings = this.local("updateSettings");
  extensionCapabilityToken = this.unsupported("extensionCapabilityToken");
  rotateExtensionCapabilityToken = this.unsupported(
    "rotateExtensionCapabilityToken",
  );
  runPipelineStages = this.unsupported("runPipelineStages");
  updateCredential = this.unsupported("updateCredential");
  deleteCredential = this.unsupported("deleteCredential");
  updateCredentialsBatch = this.unsupported("updateCredentialsBatch");
  enableBrowserCapability = this.unsupported("enableBrowserCapability");
  disableBrowserCapability = this.unsupported("disableBrowserCapability");
  copyLinkedInBrowserProfile = this.unsupported("copyLinkedInBrowserProfile");
  verifyCodexProvider = this.unsupported("verifyCodexProvider");
  createContact = this.local("createContact");
  updateContact = this.local("updateContact");
  deleteContact = this.local("deleteContact");
  importContacts = this.unsupported("importContacts");
  runContactResearch = this.unsupported("runContactResearch");
  confirmContactCandidate = this.local("confirmContactCandidate");
  generateOutreachDraft = this.unsupported("generateOutreachDraft");
  reviseOutreachDraft = this.unsupported("reviseOutreachDraft");
  approveOutreachDraft = this.local("approveOutreachDraft");
  rejectOutreachDraft = this.local("rejectOutreachDraft");
  logOutreachSend = this.unsupported("logOutreachSend");
  scheduleOutreachFollowUp = this.local("scheduleOutreachFollowUp");
  completeOutreachFollowUp = this.local("completeOutreachFollowUp");
  dismissOutreachFollowUp = this.local("dismissOutreachFollowUp");
  retryStage = this.simulated("retryStage");
  runJobStage = this.simulated("runJobStage");
  generateMaterials = this.unsupported("generateMaterials");
  generateInterviewPrep = this.unsupported("generateInterviewPrep");
  applyJob = this.rehearsed("applyJob");
  cancelJobAction = this.local("cancelJobAction");
  markApplied = this.rehearsed("markApplied");
  markSkipped = this.local("markSkipped");

  private async read<TValue>(
    select: (model: DemoReadModel) => TValue,
  ): Promise<TValue> {
    const snapshot = await this.workspace.snapshot();
    return structuredClone(select(snapshot.state.readModel));
  }

  private async detail<TValue>(
    select: (model: DemoReadModel) => Readonly<Record<string, TValue>>,
    id: string,
    code: string,
  ): Promise<TValue> {
    const values = await this.read(select);
    const value = values[id];
    if (value === undefined) {
      throw new DemoResourceNotFoundError(code, id);
    }
    return value;
  }

  private unsupported<TMethod extends keyof ApiClientPort>(
    method: TMethod,
  ): ApiClientPort[TMethod] {
    return ((..._args: unknown[]) =>
      Promise.reject(
        new DemoCapabilityError(method),
      )) as unknown as ApiClientPort[TMethod];
  }

  private local<TMethod extends DemoBrowserLocalCommand>(
    method: TMethod,
  ): ApiClientPort[TMethod] {
    return ((...args: Parameters<ApiClientPort[TMethod]>) =>
      this.localCommands.execute(method, args)) as ApiClientPort[TMethod];
  }

  private simulated<
    TMethod extends import("./contracts.js").DemoSimulatedAsyncOperation,
  >(method: TMethod): ApiClientPort[TMethod] {
    return ((...args: Parameters<ApiClientPort[TMethod]>) =>
      this.trackDemoAction(method, () =>
        this.scenarios.execute(method, args),
      )) as ApiClientPort[TMethod];
  }

  private rehearsed<TMethod extends DemoInitialExternalRehearsalOperation>(
    method: TMethod,
  ): ApiClientPort[TMethod] {
    return ((...args: Parameters<ApiClientPort[TMethod]>) =>
      this.trackDemoAction(method, () =>
        this.externalRehearsals.execute(method, args),
      )) as ApiClientPort[TMethod];
  }

  private async trackDemoAction<TResult>(
    method: string,
    execute: () => Promise<TResult>,
  ): Promise<TResult> {
    const metadata = DEMO_ACTION_TELEMETRY[method];
    if (!metadata || !this.telemetry) return execute();
    const startedAt = monotonicNow();
    this.emitTelemetry("demo_action_started", metadata);
    try {
      const result = await execute();
      const status = actionStatus(result);
      const durationBucket = telemetryDurationBucket(
        monotonicNow() - startedAt,
      );
      if (
        status === "queued" ||
        status === "starting" ||
        status === "in_progress"
      ) {
        return result;
      }
      if (status === "failed" || status === "blocked") {
        this.emitTelemetry("demo_action_failed", {
          ...metadata,
          result: "failed",
          errorCode:
            status === "blocked" ? "validation_rejected" : "scenario_failed",
          durationBucket,
        });
      } else if (status === "canceled" || status === "cancelled") {
        this.emitTelemetry("demo_action_cancelled", {
          ...metadata,
          result: "cancelled",
          durationBucket,
        });
      } else {
        this.emitTelemetry("demo_action_completed", {
          ...metadata,
          result: "succeeded",
          durationBucket,
        });
      }
      return result;
    } catch (error) {
      this.emitTelemetry("demo_action_failed", {
        ...metadata,
        result: "failed",
        errorCode: "client_unexpected",
        durationBucket: telemetryDurationBucket(monotonicNow() - startedAt),
      });
      throw error;
    }
  }

  private emitTelemetry(
    name: string,
    attributes: Record<string, string>,
  ): void {
    try {
      this.telemetry?.event(name, attributes);
    } catch {
      // Optional analytics never changes browser-local product behavior.
    }
  }
}

export interface DemoApiClientAdapter extends EndpointClientMethods {}

const DEMO_ACTION_TELEMETRY: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  rescoreJob: { feature: "scoring", action: "rescore", scenario: "success" },
  retailorJob: { feature: "materials", action: "retailor", scenario: "retry" },
  retryStage: { feature: "pipeline", action: "retry_stage", scenario: "retry" },
  runJobStage: {
    feature: "pipeline",
    action: "run_stage",
    scenario: "success",
  },
  openArtifact: {
    feature: "artifacts",
    action: "open_artifact",
    scenario: "success",
  },
  applyJob: { feature: "apply", action: "apply_dry_run", scenario: "success" },
  markApplied: {
    feature: "apply",
    action: "mark_applied",
    scenario: "success",
  },
};

function actionStatus(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || !("status" in result))
    return undefined;
  return typeof result.status === "string" ? result.status : undefined;
}

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function telemetryDurationBucket(milliseconds: number): string {
  if (milliseconds < 100) return "under_100ms";
  if (milliseconds < 500) return "100ms_to_499ms";
  if (milliseconds < 1_000) return "500ms_to_999ms";
  if (milliseconds < 2_000) return "1s_to_2s";
  if (milliseconds < 5_000) return "2s_to_5s";
  if (milliseconds < 10_000) return "5s_to_10s";
  return "over_10s";
}

function artifactPreviewUrl(
  workspace: DemoWorkspaceRepository,
  artifactId: string,
  kind: "html" | "pdf",
  cacheKey?: CacheKey,
): string {
  const snapshot = workspace.snapshotNow();
  const selected =
    snapshot.state.readModel.materials.details[artifactId]?.artifact;
  if (!selected) {
    throw new DemoResourceNotFoundError("artifact_not_found", artifactId);
  }
  const contentType = kind === "pdf" ? "application/pdf" : "text/html";
  const assetUrls = new Set(
    Object.values(snapshot.state.artifacts)
      .filter(
        (asset) =>
          asset.contentType === contentType && isDemoArtifactUrl(asset.url),
      )
      .map((asset) => asset.url),
  );
  const selectedPath = selected.localPath.toLowerCase();
  const selectedKind = selectedPath.endsWith(".pdf")
    ? "pdf"
    : selectedPath.endsWith(".html")
      ? "html"
      : null;
  const selectedStem = selectedPath.replace(/\.(?:html|pdf)$/, "");
  const preview = Object.values(snapshot.state.readModel.materials.details)
    .map((detail) => detail.artifact)
    .find(
      (artifact) =>
        artifact.jobKey === selected.jobKey &&
        isDemoArtifactUrl(artifact.localPath) &&
        (selectedKind === kind
          ? artifact.artifactId === selected.artifactId
          : artifact.localPath.toLowerCase().replace(/\.(?:html|pdf)$/, "") ===
            selectedStem) &&
        assetUrls.has(artifact.localPath),
    );
  if (!preview || !isDemoArtifactUrl(preview.localPath)) {
    throw new DemoResourceNotFoundError(
      "artifact_preview_not_found",
      artifactId,
    );
  }
  return withCacheKey(preview.localPath, cacheKey);
}

function profilePreviewUrl(
  workspace: DemoWorkspaceRepository,
  kind: "html" | "pdf",
  cacheKey?: CacheKey,
): string {
  const artifacts = workspace.snapshotNow().state.artifacts;
  const asset =
    kind === "pdf" ? artifacts.profileResumePdf : artifacts.profileResumeHtml;
  const expectedType = kind === "pdf" ? "application/pdf" : "text/html";
  if (asset.contentType !== expectedType || !isDemoArtifactUrl(asset.url)) {
    throw new DemoResourceNotFoundError("profile_preview_not_found", "profile");
  }
  return withCacheKey(asset.url, cacheKey);
}

function withCacheKey(url: `/demo/${string}`, cacheKey?: CacheKey): string {
  if (cacheKey === undefined || cacheKey === "") return url;
  return `${url}?v=${encodeURIComponent(String(cacheKey))}`;
}

function filterJob(
  job: JobSummary,
  query: ReturnType<typeof JobListQuerySchema.parse>,
  normalizedQuery: string,
): boolean {
  const closed = CLOSED_ACTIVE_STATES.has(job.activeState);
  if (query.deleted === "active" && (job.deletedAt || job.hiddenAt || closed))
    return false;
  if (query.deleted === "closed" && (job.deletedAt || job.hiddenAt || !closed))
    return false;
  if (query.deleted === "deleted" && (!job.deletedAt || job.hiddenAt))
    return false;
  if (query.deleted === "hidden" && !job.hiddenAt) return false;
  return sharedFilterJob(job, query, normalizedQuery);
}

function filterWorkflowRun(
  run: WorkflowRunSummary,
  query: ReturnType<typeof WorkflowRunsListQuerySchema.parse>,
): boolean {
  if (query.status !== "all" && run.status !== query.status) return false;
  if (query.workflowType && run.workflowType !== query.workflowType)
    return false;
  if (
    query.startedSince &&
    !timestampAtOrAfter(run.startedAt, query.startedSince)
  )
    return false;
  if (
    query.startedBefore &&
    !timestampBefore(run.startedAt, query.startedBefore)
  )
    return false;
  return true;
}

function compareArtifacts(
  left: ArtifactSummary,
  right: ArtifactSummary,
  field: string,
  direction: "asc" | "desc",
): number {
  const values: Record<string, [unknown, unknown]> = {
    created_at: [left.createdAt, right.createdAt],
    title: [left.title, right.title],
    company: [left.company, right.company],
    type: [left.type, right.type],
    status: [left.status, right.status],
    size_bytes: [left.sizeBytes ?? -1, right.sizeBytes ?? -1],
  };
  const [leftValue, rightValue] = values[field] ?? values.created_at!;
  return compareValues(leftValue, rightValue) * (direction === "asc" ? 1 : -1);
}

function compareActivity(
  left: ActivityEventSummary,
  right: ActivityEventSummary,
  field: string,
  direction: "asc" | "desc",
): number {
  const values: Record<string, [unknown, unknown]> = {
    occurred_at: [left.at, right.at],
    event_id: [left.eventId, right.eventId],
    stage: [left.stage.toLowerCase(), right.stage.toLowerCase()],
    level: [left.level.toLowerCase(), right.level.toLowerCase()],
    event_type: [left.eventType.toLowerCase(), right.eventType.toLowerCase()],
    message: [left.message.toLowerCase(), right.message.toLowerCase()],
  };
  const [leftValue, rightValue] = values[field] ?? values.occurred_at!;
  const multiplier = direction === "asc" ? 1 : -1;
  const compared = compareValues(leftValue, rightValue);
  return compared
    ? compared * multiplier
    : left.eventId.localeCompare(right.eventId) * multiplier;
}

function compareWorkflowRuns(
  left: WorkflowRunSummary,
  right: WorkflowRunSummary,
  field: string,
  direction: "asc" | "desc",
): number {
  const values: Record<string, [unknown, unknown]> = {
    started_at: [left.startedAt, right.startedAt],
    finished_at: [left.finishedAt, right.finishedAt],
    duration_ms: [left.durationMs ?? -1, right.durationMs ?? -1],
    title: [left.title, right.title],
    company: [left.company, right.company],
    status: [left.status, right.status],
    model: [left.model ?? "", right.model ?? ""],
    dry_run: [left.dryRun ? 1 : 0, right.dryRun ? 1 : 0],
  };
  const [leftValue, rightValue] = values[field] ?? values.started_at!;
  return compareValues(leftValue, rightValue) * (direction === "asc" ? 1 : -1);
}

function compareUpdatedAtThenId(
  leftUpdatedAt: string | null,
  rightUpdatedAt: string | null,
  leftId: string,
  rightId: string,
): number {
  const updated = compareValues(leftUpdatedAt, rightUpdatedAt);
  return updated ? updated * -1 : leftId.localeCompare(rightId);
}
