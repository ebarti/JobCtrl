/**
 * Local action dispatchers — JSON-RPC backed (Phase 9 / S-34).
 *
 * Per the no-strangler directive the previous "spawn one CLI action
 * subprocess per call" path is **deleted**.
 * Every action is now routed through ``SubprocessJsonRpcAdapter``
 * (long-lived ``jobctrl rpc`` worker) per ddd-target.md §6.5.
 *
 * Two seams stay outside JSON-RPC:
 *
 *   * ``defaultArtifactOpener`` — uses ``open`` / ``xdg-open`` /
 *     ``cmd /c start`` to fire the OS file handler.  Not part of the
 *     JSON-RPC protocol surface.
 *   * ``defaultProfilePreviewRenderer`` — invokes an inline Python
 *     script through the central runtime resolver for the profile baseline resume
 *     preview render path.  This is a one-off helper that doesn't fit
 *     the JSON-RPC method set.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_PIPELINE_LLM_MODEL,
  PIPELINE_ACTION_JOB_KEY,
  type ActionCommandPayload,
  type ActionRunResponse,
  type ResumeTemplateTheme,
  type RpcMethod,
} from "./contracts.js";
import {
  getDefaultJsonRpcDispatcher,
  type JsonRpcDispatcher,
} from "./json-rpc-adapter.js";
import {
  defaultSourcePythonRuntime,
  type PythonRuntimeCommandResolver,
  type ResolvedPythonCommand,
} from "./python-runtime.js";

export interface ActionDispatchContext {
  appDir: string;
  dbPath: string;
  configPath?: string;
}

export interface ActionDispatchResult {
  status: string;
  actionId?: string;
  runId?: string;
  workflowId?: string;
  firstExecutionRunId?: string;
  result?: unknown;
  message?: string;
}

export type ActionDispatcher = (
  command: ActionCommandPayload,
  context: ActionDispatchContext,
) => Promise<ActionDispatchResult>;
export type JsonRpcDispatcherFactory = (context: ActionDispatchContext) => JsonRpcDispatcher;

export function createRuntimeJsonRpcDispatcherFactory(
  pythonRuntime: PythonRuntimeCommandResolver,
): JsonRpcDispatcherFactory {
  return (context) =>
    getDefaultJsonRpcDispatcher({
      appDir: context.appDir,
      ...(context.configPath ? { configPath: context.configPath } : {}),
      pythonRuntime,
    });
}

export type ArtifactOpener = (artifactPath: string) => Promise<void>;

export interface ProfileImportInput {
  filename: string;
  pdfBytes: Buffer;
  importProfile: boolean;
  importStyle: boolean;
}

export interface ProfileImportResult {
  /** Draft profile data. Tests may inject partial drafts through the
   * ``ProfileImporter`` injection point, so the static type stays ``unknown``
   * to keep that seam open. */
  profile?: unknown;
  style?: unknown;
  templateText?: string;
  source?: unknown;
  action?: ActionRunResponse;
}

export type ProfileImporter = (
  input: ProfileImportInput,
  context: ActionDispatchContext,
) => Promise<ProfileImportResult>;

export interface ProfilePreviewInput {
  profile: unknown;
  resumeTheme: ResumeTemplateTheme;
  templateText: string;
}

export interface ProfilePreviewRenderResult {
  pdfBytes: Buffer;
  htmlText: string;
}

export type ProfilePreviewRenderer = (
  input: ProfilePreviewInput,
  context: ActionDispatchContext,
) => Promise<ProfilePreviewRenderResult>;

/** Build the production action dispatcher backed by ``SubprocessJsonRpcAdapter``. */
export function createActionDispatcher(
  dispatcher?: JsonRpcDispatcher,
  dispatcherFactory: JsonRpcDispatcherFactory = (context) =>
    getDefaultJsonRpcDispatcher({
      appDir: context.appDir,
      ...(context.configPath ? { configPath: context.configPath } : {}),
      pythonRuntime: defaultSourcePythonRuntime,
    }),
): ActionDispatcher {
  return async (command, context) => {
    const rpc = dispatcher ?? dispatcherFactory(context);
    if (command.action === "retry_stage" && !command.runAfter) {
      // Pure-reset path — handled by write-model.ts.  The dispatcher is
      // only invoked when ``runAfter`` is set (i.e. user explicitly
      // wants the stage to run after the reset).
      return { status: "reset", message: "Stage reset for retry." };
    }

    if (requiresCanonicalJobId(command) && !command.jobId) {
      return {
        status: "failed",
        message: "Job-scoped actions require a canonical jobId.",
      };
    }

    const rpcCall = mapCommandToRpc(command, context);
    if (!rpcCall) {
      return {
        status: "unsupported",
        message: "No job-scoped local command is available for this action.",
      };
    }

    const response = await rpc.call(rpcCall.method, rpcCall.params);
    if (response.error) {
      return {
        status: "failed",
        message: response.error.message,
        result: response.error.data,
      };
    }
    if (rpcCall.method === "cancel_run") {
      const rpcRunId = isRecord(response.result) && typeof response.result.runId === "string"
        ? response.result.runId
        : command.runId;
      return {
        status: extractStatus(response.result) ?? "canceling",
        ...(rpcRunId ? { runId: rpcRunId } : {}),
        result: response.result,
      };
    }
    const workflowStart = extractWorkflowStart(response.result);
    if (hasWorkflowStart(workflowStart)) {
      const result: ActionDispatchResult = {
        status: "queued",
        result: response.result,
      };
      if (workflowStart.runId) result.runId = workflowStart.runId;
      if (workflowStart.workflowId) result.workflowId = workflowStart.workflowId;
      if (workflowStart.firstExecutionRunId) {
        result.firstExecutionRunId = workflowStart.firstExecutionRunId;
      }
      return result;
    }
    if (rpcCall.method === "apply") {
      return {
        status: "queued",
        result: response.result,
      };
    }
    if (rpcCall.method === "run_stage" || rpcCall.method === "refresh_compensation") {
      const status = extractStatus(response.result) ?? "succeeded";
      const result: ActionDispatchResult = {
        status,
        result: response.result,
      };
      const actionId = extractActionId(response.result);
      if (actionId) result.actionId = actionId;
      const message = status === "failed" ? extractResultMessage(response.result) : null;
      if (message) result.message = message;
      return result;
    }
    return {
      status: "queued",
      result: response.result,
    };
  };
}

/** The default action dispatcher used by ``server.ts`` in production. */
export const defaultActionDispatcher: ActionDispatcher = createActionDispatcher();

export interface ContactResearchStartInput {
  taskId: string;
  employer: string | null;
  jobId: string | null;
  sources: { category: string; url: string; label: string }[];
  llmModel?: string;
}

export interface ContactResearchStartOutcome {
  runId: string | null;
  workflowId: string | null;
  firstExecutionRunId: string | null;
  status: string;
}

export type ContactResearchStarter = (
  input: ContactResearchStartInput,
  context: ActionDispatchContext,
) => Promise<ContactResearchStartOutcome>;

/** Start a supervised research run on the Python worker via JSON-RPC / Temporal. */
export function createContactResearchStarter(
  pythonRuntime: PythonRuntimeCommandResolver = defaultSourcePythonRuntime,
  dispatcherFactory: JsonRpcDispatcherFactory = createRuntimeJsonRpcDispatcherFactory(pythonRuntime),
): ContactResearchStarter {
  return async (input, context) => {
    const rpc = dispatcherFactory(context);
    const response = await rpc.call("run_contact_research", {
      tenantId: "local",
      expectedAppDir: context.appDir,
      expectedDbPath: context.dbPath,
      taskId: input.taskId,
      ...(input.employer ? { employer: input.employer } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
      sources: input.sources,
      llmModel: input.llmModel ?? DEFAULT_PIPELINE_LLM_MODEL,
    });
    if (response.error) {
      throw new Error(response.error.message);
    }
    const start = extractWorkflowStart(response.result);
    return {
      runId: start.runId,
      workflowId: start.workflowId,
      firstExecutionRunId: start.firstExecutionRunId,
      status: "queued",
    };
  };
}

export const defaultContactResearchStarter: ContactResearchStarter = createContactResearchStarter();

export interface OutreachDraftGeneratorInput {
  threadId: string;
  contactId?: string | null;
  jobId?: string | null;
  kind?: string;
  editedBodyText?: string;
  applicationRole?: string;
  llmModel?: string;
}

export interface OutreachDraftGeneratorOutcome {
  threadId: string;
  contactId: string;
  jobId: string | null;
  draftId: string;
  generation: number;
  kind: string;
  status: string;
  gatePassed: boolean;
}

export type OutreachDraftGenerator = (
  input: OutreachDraftGeneratorInput,
  context: ActionDispatchContext,
) => Promise<OutreachDraftGeneratorOutcome>;

/**
 * Generate or revise an outreach draft synchronously on the Python worker via
 * JSON-RPC (LLM + the reused materials truthfulness gate stack, like analyze_job).
 * ``contactId`` selects the generate path; ``editedBodyText`` selects revise. This
 * has no send capability (INV-1) — it only persists a gated draft.
 */
export function createOutreachDraftGenerator(
  pythonRuntime: PythonRuntimeCommandResolver = defaultSourcePythonRuntime,
): OutreachDraftGenerator {
  return async (input, context) => {
    const rpc = getDefaultJsonRpcDispatcher({ appDir: context.appDir, pythonRuntime });
    const response = await rpc.call("generate_outreach_draft", {
      tenantId: "local",
      expectedAppDir: context.appDir,
      expectedDbPath: context.dbPath,
      threadId: input.threadId,
      ...(input.contactId ? { contactId: input.contactId } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.editedBodyText ? { editedBodyText: input.editedBodyText } : {}),
      ...(input.applicationRole ? { applicationRole: input.applicationRole } : {}),
      llmModel: input.llmModel ?? DEFAULT_PIPELINE_LLM_MODEL,
    });
    if (response.error) {
      throw new Error(response.error.message);
    }
    return parseOutreachDraftResult(response.result);
  };
}

export const defaultOutreachDraftGenerator: OutreachDraftGenerator = createOutreachDraftGenerator();

function parseOutreachDraftResult(result: unknown): OutreachDraftGeneratorOutcome {
  if (!isRecord(result)) {
    throw new Error("Outreach draft generation returned no result.");
  }
  return {
    threadId: typeof result.threadId === "string" ? result.threadId : "",
    contactId: typeof result.contactId === "string" ? result.contactId : "",
    jobId: typeof result.jobId === "string" ? result.jobId : null,
    draftId: typeof result.draftId === "string" ? result.draftId : "",
    generation: typeof result.generation === "number" ? result.generation : 0,
    kind: typeof result.kind === "string" ? result.kind : "intro_request",
    status: typeof result.status === "string" ? result.status : "candidate",
    gatePassed: result.gatePassed === true,
  };
}

export const defaultArtifactOpener: ArtifactOpener = async (artifactPath) => {
  const opener = openerCommand(artifactPath);
  const child = spawn(opener.command, opener.args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
};

export function createProfileImporter(
  pythonRuntime: PythonRuntimeCommandResolver = defaultSourcePythonRuntime,
): ProfileImporter {
  return async (input, context) => {
    const importDir = path.join(context.appDir, "profile-imports");
    fs.mkdirSync(importDir, { recursive: true });
    const pdfPath = path.join(importDir, `${randomUUID()}-${sanitizeFilename(input.filename)}`);
    fs.writeFileSync(pdfPath, input.pdfBytes);
    const command: ActionCommandPayload = {
      action: "profile_import",
      jobKey: "profile",
    };
    const actionId = `act-${randomUUID()}`;
    const dispatcher = getDefaultJsonRpcDispatcher({ appDir: context.appDir, pythonRuntime });
    const response = await dispatcher.call("profile_import", {
      tenantId: "local",
      expectedAppDir: context.appDir,
      expectedDbPath: context.dbPath,
      pdfPath,
      importProfile: input.importProfile,
      importStyle: input.importStyle,
      awaitResult: true,
    });
    if (response.error) {
      throw new Error(response.error.message);
    }
    const workflowStart = extractWorkflowStart(response.result);
    const workflowResult = extractWorkflowResult(response.result);
    if (workflowResult?.status === "failed") {
      throw new Error(extractProfileImportError(workflowResult) ?? "Profile import workflow failed.");
    }
    const draft = extractProfileImportDraft(workflowResult);
    const runId = workflowStart.runId ?? workflowStart.workflowId ?? actionId;
    const workflowId = workflowStart.workflowId ?? runId;
    const action: ActionRunResponse = {
      ok: true,
      runId,
      workflowId,
      actionId,
      action: command.action,
      status: "queued",
      jobKey: command.jobKey,
      command,
      result: response.result,
    };
    if (workflowStart.firstExecutionRunId) {
      action.firstExecutionRunId = workflowStart.firstExecutionRunId;
    }
    const result: ProfileImportResult = {
      profile: draft.profile,
      style: draft.style,
      source: draft.source,
      action,
    };
    if (draft.templateText !== undefined) {
      result.templateText = draft.templateText;
    }
    return result;
  };
}

export const defaultProfileImporter: ProfileImporter = createProfileImporter();

export function createProfilePreviewRenderer(
  pythonRuntime: PythonRuntimeCommandResolver = defaultSourcePythonRuntime,
): ProfilePreviewRenderer {
  return async (input, context) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-profile-preview-"));
    const profilePath = path.join(tempDir, "profile-preview-input.json");
    const outputPath = path.join(tempDir, "resume-preview.pdf");
    const htmlPath = outputPath.replace(/\.pdf$/i, ".html");
    try {
      fs.writeFileSync(profilePath, JSON.stringify(input.profile), "utf8");
      const command = pythonRuntime.resolve(
        {
          kind: "script",
          script: PROFILE_PREVIEW_SCRIPT,
          args: [profilePath, outputPath, JSON.stringify(input.resumeTheme)],
        },
        { appDir: context.appDir },
      );
      await runCommand(command);
      return {
        pdfBytes: fs.readFileSync(outputPath),
        htmlText: fs.readFileSync(htmlPath, "utf8"),
      };
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  };
}

export const defaultProfilePreviewRenderer: ProfilePreviewRenderer = createProfilePreviewRenderer();

export function buildActionResponse(
  command: ActionCommandPayload,
  dispatch: ActionDispatchResult,
  extra: Partial<Pick<ActionRunResponse, "stage">> = {},
): ActionRunResponse {
  const actionId = dispatch.actionId ?? dispatch.runId ?? `act-${randomUUID()}`;
  const response: ActionRunResponse = {
    ok: true,
    runId: dispatch.runId ?? actionId,
    actionId,
    action: command.action,
    status: dispatch.status,
    jobKey: command.jobKey,
    command,
  };
  if (dispatch.result !== undefined) {
    response.result = dispatch.result;
  }
  if (dispatch.message) {
    response.message = dispatch.message;
  }
  if (dispatch.workflowId) {
    response.workflowId = dispatch.workflowId;
  }
  if (dispatch.firstExecutionRunId) {
    response.firstExecutionRunId = dispatch.firstExecutionRunId;
  }
  if (extra.stage) {
    response.stage = extra.stage;
  }
  return response;
}

interface RpcCall {
  method: RpcMethod;
  params: Record<string, unknown>;
}

function mapCommandToRpc(command: ActionCommandPayload, context: ActionDispatchContext): RpcCall | null {
  if (command.action === "run_stage") {
    if (!command.stage) return null;
    return { method: "run_stage", params: runStageRpcParams(command, context) };
  }
  if (command.action === "retry_stage") {
    if (!command.stage || !command.runAfter) return null;
    if (command.stage === "apply") {
      return { method: "apply", params: applyRpcParams(command, context) };
    }
    const stages = command.stages && command.stages.length > 0
      ? command.stages
      : retryContinuationStages(command.stage);
    if (stages.length === 0) return null;
    return {
      method: "run_stage",
      params: runStageRpcParams({ ...command, stages, limit: command.limit ?? 1 }, context),
    };
  }
  if (command.action === "rescore_job") {
    return {
      method: "rescore_job",
      params: {
        tenantId: "local",
        expectedAppDir: context.appDir,
        expectedDbPath: context.dbPath,
        jobId: command.jobId,
        dryRun: Boolean(command.dryRun),
        ...(command.reason ? { reason: command.reason } : {}),
      },
    };
  }
  if (command.action === "rescore_jobs_not_on_current_scoring_policy") {
    return {
      method: "rescore_jobs_not_on_current_scoring_policy",
      params: {
        tenantId: "local",
        expectedAppDir: context.appDir,
        expectedDbPath: context.dbPath,
        limit: command.limit ?? 100,
        jobIds: command.jobIds ?? [],
        dryRun: Boolean(command.dryRun),
        ...(command.reason ? { reason: command.reason } : {}),
      },
    };
  }
  if (command.action === "tailor_job") {
    return {
      method: "tailor_job",
      params: tailorRpcParams(command, context, command.jobId!),
    };
  }
  if (command.action === "retailor_job") {
    return {
      method: "retailor_job",
      params: retailorRpcParams(command, context, { jobId: command.jobId! }),
    };
  }
  if (command.action === "retailor_current_policy") {
    return {
      method: "retailor_current_policy",
      params: retailorRpcParams(command, context),
    };
  }
  if (command.action === "analyze_job") {
    return {
      method: "analyze_job",
      params: {
        tenantId: "local",
        expectedAppDir: context.appDir,
        expectedDbPath: context.dbPath,
        jobId: command.jobId,
        force: Boolean(command.retailor),
      },
    };
  }
  if (command.action === "refresh_compensation") {
    const params: Record<string, unknown> = {
      tenantId: "local",
      expectedAppDir: context.appDir,
      expectedDbPath: context.dbPath,
      ...(command.observationsJsonPath ? { observationsJsonPath: command.observationsJsonPath } : {}),
      ...(command.includeEuroTopTech !== undefined ? { includeEuroTopTech: command.includeEuroTopTech } : {}),
      ...(command.euroTopTechMaxPages !== undefined ? { euroTopTechMaxPages: command.euroTopTechMaxPages } : {}),
    };
    if (command.jobKey !== PIPELINE_ACTION_JOB_KEY) {
      params.jobId = command.jobKey;
    } else {
      params.allJobs = true;
    }
    return {
      method: "refresh_compensation",
      params,
    };
  }
  if (command.action === "generate_interview_prep") {
    return {
      method: "generate_interview_prep",
      params: {
        tenantId: "local",
        expectedAppDir: context.appDir,
        expectedDbPath: context.dbPath,
        jobId: command.jobId,
        llmModel: command.llmModel ?? DEFAULT_PIPELINE_LLM_MODEL,
      },
    };
  }
  if (command.action === "generate_materials") return null;
  if (command.action === "apply") {
    return { method: "apply", params: applyRpcParams(command, context) };
  }
  if (command.action === "cancel") {
    // PR 3 added the cancel_run JSON-RPC method on the worker side; without
    // this branch the cancel route only writes a StageCanceled event to
    // SQLite and the running Temporal workflow keeps polling. Map the
    // command's runId (the workflow id) into the worker call so the
    // workflow actually receives a cancellation signal.
    if (!command.runId) return null;
    return {
      method: "cancel_run",
      params: { tenantId: "local", runId: command.runId },
    };
  }
  return null;
}

function retryContinuationStages(stage: NonNullable<ActionCommandPayload["stage"]>): NonNullable<ActionCommandPayload["stages"]> {
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

function requiresCanonicalJobId(command: ActionCommandPayload): boolean {
  if (command.action === "retry_stage") {
    return Boolean(command.runAfter) && command.jobKey !== PIPELINE_ACTION_JOB_KEY;
  }
  if (command.action === "run_stage") {
    return command.jobKey !== PIPELINE_ACTION_JOB_KEY;
  }
  return (
    command.action === "rescore_job" ||
    command.action === "tailor_job" ||
    command.action === "retailor_job" ||
    command.action === "analyze_job" ||
    command.action === "generate_interview_prep" ||
    (command.action === "apply" && command.jobKey !== PIPELINE_ACTION_JOB_KEY)
  );
}

function runStageRpcParams(command: ActionCommandPayload, context: ActionDispatchContext): Record<string, unknown> {
  const stages =
    command.stages && command.stages.length > 0
      ? command.stages
      : command.stage
        ? [command.stage]
        : [];
  const params: Record<string, unknown> = {
    tenantId: "local",
    expectedAppDir: context.appDir,
    expectedDbPath: context.dbPath,
    stage: command.stage,
    stages,
    limit: command.limit ?? 25,
    workers: command.workers ?? 1,
    minScore: command.minScore ?? 7,
    validationMode: command.validationMode ?? "normal",
    dryRun: command.dryRun ?? false,
    rescore: Boolean(command.rescore),
    retailor: Boolean(command.retailor),
    headless: Boolean(command.headless),
    model: command.model ?? "default",
    llmModel: command.llmModel ?? DEFAULT_PIPELINE_LLM_MODEL,
    continuous: Boolean(command.continuous),
  };
  if (command.sourceIds && command.sourceIds.length > 0) {
    params.sourceIds = command.sourceIds;
  }
  if (command.tailorModels && command.tailorModels.length > 0) {
    params.tailorModels = command.tailorModels;
  }
  if (command.tailorJudgeModel) {
    params.tailorJudgeModel = command.tailorJudgeModel;
  }
  if (command.tailorJudgeMinScore !== undefined) {
    params.tailorJudgeMinScore = command.tailorJudgeMinScore;
  }
  if (command.jobId) {
    params.jobId = command.jobId;
  }
  if (command.jobIds && command.jobIds.length > 0) {
    params.jobIds = command.jobIds;
  }
  return params;
}

function tailorRpcParams(
  command: ActionCommandPayload,
  context: ActionDispatchContext,
  jobId: string,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    tenantId: "local",
    expectedAppDir: context.appDir,
    expectedDbPath: context.dbPath,
    jobId,
    dryRun: Boolean(command.dryRun),
    allowLowFitOverride: true,
  };
  if (command.reason) {
    params.reason = command.reason;
  }
  if (command.tailorModels && command.tailorModels.length > 0) {
    params.tailorModels = command.tailorModels;
  }
  if (command.tailorJudgeModel) {
    params.tailorJudgeModel = command.tailorJudgeModel;
  }
  if (command.tailorJudgeMinScore !== undefined) {
    params.tailorJudgeMinScore = command.tailorJudgeMinScore;
  }
  return params;
}

type PreparationJobLocator = { jobId: string };

function retailorRpcParams(
  command: ActionCommandPayload,
  context: ActionDispatchContext,
  locator?: PreparationJobLocator,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    tenantId: "local",
    expectedAppDir: context.appDir,
    expectedDbPath: context.dbPath,
    dryRun: Boolean(command.dryRun),
    suppressExistingArtifacts: Boolean(command.suppressExistingArtifacts),
  };
  if (locator) {
    Object.assign(params, locator);
  } else {
    params.limit = command.limit ?? 100;
    params.jobIds = command.jobIds ?? [];
  }
  if (command.reason) {
    params.reason = command.reason;
  }
  if (command.tailorModels && command.tailorModels.length > 0) {
    params.tailorModels = command.tailorModels;
  }
  if (command.tailorJudgeModel) {
    params.tailorJudgeModel = command.tailorJudgeModel;
  }
  if (command.tailorJudgeMinScore !== undefined) {
    params.tailorJudgeMinScore = command.tailorJudgeMinScore;
  }
  return params;
}

function applyRpcParams(command: ActionCommandPayload, context: ActionDispatchContext): Record<string, unknown> {
  const params: Record<string, unknown> = {
    tenantId: "local",
    expectedAppDir: context.appDir,
    expectedDbPath: context.dbPath,
    limit: command.limit ?? 1,
    workers: command.workers ?? 1,
    minScore: command.minScore ?? 7,
    model: command.model ?? "default",
    dryRun: command.dryRun !== false,
    headless: Boolean(command.headless),
    continuous: Boolean(command.continuous),
  };
  if (command.jobId) {
    params.jobId = command.jobId;
  }
  return params;
}

function extractWorkflowStart(result: unknown): {
  runId: string | null;
  workflowId: string | null;
  firstExecutionRunId: string | null;
} {
  if (!isRecord(result)) {
    return { runId: null, workflowId: null, firstExecutionRunId: null };
  }
  const runId = typeof result.runId === "string" ? result.runId : null;
  const workflowId = typeof result.workflowId === "string" ? result.workflowId : null;
  const firstExecutionRunId =
    typeof result.firstExecutionRunId === "string" ? result.firstExecutionRunId : null;
  return { runId, workflowId, firstExecutionRunId };
}

function extractWorkflowResult(result: unknown): Record<string, unknown> | null {
  if (!isRecord(result) || !isRecord(result.result)) return null;
  return result.result;
}

function extractProfileImportDraft(
  workflowResult: Record<string, unknown> | null,
): Omit<ProfileImportResult, "action"> {
  if (!workflowResult) {
    throw new Error("Profile import workflow did not return a result.");
  }
  if (!isRecord(workflowResult.draft)) {
    throw new Error("Profile import workflow did not return a draft.");
  }
  const draft = workflowResult.draft;
  const extracted: Omit<ProfileImportResult, "action"> = {
    profile: draft.profile,
    style: draft.style,
    source: draft.source,
  };
  if (typeof draft.templateText === "string") {
    extracted.templateText = draft.templateText;
  }
  return extracted;
}

function extractProfileImportError(workflowResult: Record<string, unknown>): string | null {
  const error = workflowResult.error ?? workflowResult.errorMessage;
  return typeof error === "string" && error.trim() ? error : null;
}

function hasWorkflowStart(workflowStart: ReturnType<typeof extractWorkflowStart>): boolean {
  return Boolean(workflowStart.runId || workflowStart.workflowId || workflowStart.firstExecutionRunId);
}

function extractActionId(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const actionId = result.action_id ?? result.actionId;
  return typeof actionId === "string" ? actionId : null;
}

function extractStatus(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const status = result.status;
  return typeof status === "string" && status.trim() ? status : null;
}

function extractResultMessage(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const message = result.error ?? result.message;
  if (typeof message === "string" && message.trim()) return message;
  const nestedResult = result.result;
  if (!isRecord(nestedResult)) return null;
  return extractErrorText(nestedResult.errors);
}

function extractErrorText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (Array.isArray(value)) {
    const messages = value.map(extractErrorText).filter((message): message is string => Boolean(message));
    return messages.length ? messages.join("; ") : null;
  }
  if (isRecord(value)) {
    const directMessage = extractErrorText(value.error) ?? extractErrorText(value.message);
    if (directMessage) return directMessage;
    const messages = Object.values(value)
      .map(extractErrorText)
      .filter((message): message is string => Boolean(message));
    return messages.length ? messages.join("; ") : null;
  }
  return null;
}

function openerCommand(artifactPath: string): { command: string; args: string[] } {
  if (process.platform === "darwin") {
    return { command: "open", args: [artifactPath] };
  }
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", artifactPath] };
  }
  return { command: "xdg-open", args: [artifactPath] };
}

function runCommand(command: ResolvedPythonCommand): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.argv, {
      cwd: command.cwd,
      env: command.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `Command failed with exit code ${code ?? "unknown"}.`));
    });
  });
}

export const PROFILE_PREVIEW_SCRIPT = `
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from jobctrl.infrastructure.materials.html_resume_pdf import HtmlResumePdfAdapter

profile_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
resume_theme = json.loads(sys.argv[3])

profile = json.loads(profile_path.read_text(encoding="utf-8"))
resume = profile.get("resume", {}) if isinstance(profile, dict) else {}
executive_profile = resume.get("executive_profile", {}) if isinstance(resume.get("executive_profile", {}), dict) else {}

data = {
    "executive_profile": executive_profile.get("baseline_text", ""),
    "experience_updates": [
        {
            "id": entry.get("id"),
            "title": entry.get("title", ""),
            "bullets": entry.get("bullets", []),
        }
        for entry in resume.get("experience_entries", [])
        if isinstance(entry, dict) and entry.get("id")
    ],
    "skill_category_updates": [
        {
            "id": category.get("id"),
            "items": category.get("items", []),
        }
        for category in resume.get("skill_categories", [])
        if isinstance(category, dict) and category.get("id")
    ],
}

HtmlResumePdfAdapter().render_resume_to_pdf(
    tailored_payload=data,
    profile_dict=profile,
    output_path=str(output_path),
    created_at=datetime.now(timezone.utc).isoformat(),
    resume_theme=resume_theme,
)
`;

function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).replace(/[^A-Za-z0-9._-]/g, "_");
  return base || "resume.pdf";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
