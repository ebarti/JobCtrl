/**
 * Local action dispatchers — JSON-RPC backed (Phase 9 / S-34).
 *
 * Per the no-strangler directive the previous "spawn one ``uv run
 * jobhunter action ...`` subprocess per call" path is **deleted**.
 * Every action is now routed through ``SubprocessJsonRpcAdapter``
 * (long-lived ``jobhunter rpc`` worker) per ddd-target.md §6.5.
 *
 * Two seams stay outside JSON-RPC:
 *
 *   * ``defaultArtifactOpener`` — uses ``open`` / ``xdg-open`` /
 *     ``cmd /c start`` to fire the OS file handler.  Not part of the
 *     JSON-RPC protocol surface.
 *   * ``defaultProfilePreviewRenderer`` — invokes an inline Python
 *     script via ``uv run python -c`` for the LaTeX render path.  This
 *     is a one-off helper that doesn't fit the JSON-RPC method set.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PIPELINE_LLM_MODEL,
  PIPELINE_ACTION_JOB_KEY,
  type ActionCommandPayload,
  type ActionRunResponse,
  type RpcMethod,
} from "./contracts.js";
import { ProfileSchema } from "./contracts.js";
import {
  getDefaultJsonRpcDispatcher,
  type JsonRpcDispatcher,
} from "./json-rpc-adapter.js";

const API_SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const AUTOMATION_PROJECT_DIR = path.resolve(API_SRC_DIR, "../../../workers/automation");

export interface ActionDispatchContext {
  appDir: string;
  dbPath: string;
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

export type ArtifactOpener = (artifactPath: string) => Promise<void>;

export interface ProfileImportInput {
  filename: string;
  pdfBytes: Buffer;
  importProfile: boolean;
  importStyle: boolean;
}

export interface ProfileImportResult {
  /** Draft profile JSON. Validated server-side against ``ProfileSchema`` in
   * ``extractProfileImportDraft`` before being placed on this field; tests
   * may inject partial drafts through the ``ProfileImporter`` injection
   * point, so the static type stays ``unknown`` to keep that seam open. */
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
  templateText: string;
}

export type ProfilePreviewRenderer = (
  input: ProfilePreviewInput,
  context: ActionDispatchContext,
) => Promise<Buffer>;

/** Build the production action dispatcher backed by ``SubprocessJsonRpcAdapter``. */
export function createActionDispatcher(
  dispatcher?: JsonRpcDispatcher,
  dispatcherFactory: JsonRpcDispatcherFactory = (context) =>
    getDefaultJsonRpcDispatcher({ appDir: context.appDir }),
): ActionDispatcher {
  return async (command, context) => {
    const rpc = dispatcher ?? dispatcherFactory(context);
    if (command.action === "retry_stage" && !command.runAfter) {
      // Pure-reset path — handled by write-model.ts.  The dispatcher is
      // only invoked when ``runAfter`` is set (i.e. user explicitly
      // wants the stage to run after the reset).
      return { status: "reset", message: "Stage reset for retry." };
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
    if (rpcCall.method === "apply") {
      // workflow start — server returns { runId } (the Temporal workflow id).
      const workflowStart = extractWorkflowStart(response.result);
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
    if (rpcCall.method === "run_stage") {
      const workflowStart = extractWorkflowStart(response.result);
      if (workflowStart.runId) {
        const result: ActionDispatchResult = {
          status: "queued",
          runId: workflowStart.runId,
          result: response.result,
        };
        if (workflowStart.workflowId) result.workflowId = workflowStart.workflowId;
        if (workflowStart.firstExecutionRunId) {
          result.firstExecutionRunId = workflowStart.firstExecutionRunId;
        }
        return result;
      }
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

export const defaultArtifactOpener: ArtifactOpener = async (artifactPath) => {
  const opener = openerCommand(artifactPath);
  const child = spawn(opener.command, opener.args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
};

export const defaultProfileImporter: ProfileImporter = async (input, context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-profile-import-"));
  const pdfPath = path.join(tempDir, sanitizeFilename(input.filename));
  try {
    fs.writeFileSync(pdfPath, input.pdfBytes);
    const command: ActionCommandPayload = {
      action: "profile_import",
      jobKey: "profile",
    };
    const actionId = `act-${randomUUID()}`;
    const dispatcher = getDefaultJsonRpcDispatcher({ appDir: context.appDir });
    const response = await dispatcher.call("profile_import", {
      tenantId: "local",
      pdfPath,
      importProfile: input.importProfile,
      importStyle: input.importStyle,
    });
    if (response.error) {
      throw new Error(response.error.message);
    }
    const draft = extractProfileImportDraft(response.result);
    if (!input.importProfile) {
      delete draft.profile;
    }
    if (!input.importStyle) {
      delete draft.style;
    }
    return {
      ...draft,
      action: {
        ok: true,
        runId: actionId,
        actionId,
        action: command.action,
        status: "succeeded",
        jobKey: command.jobKey,
        command,
        result: response.result,
      },
    };
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
};

export const defaultProfilePreviewRenderer: ProfilePreviewRenderer = async (input, context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-profile-preview-"));
  const profilePath = path.join(tempDir, "profile.json");
  const templatePath = path.join(tempDir, "resume_template.tex");
  const outputPath = path.join(tempDir, "resume-preview.pdf");
  try {
    fs.writeFileSync(profilePath, JSON.stringify(input.profile), "utf8");
    if (input.templateText.trim()) {
      fs.writeFileSync(templatePath, input.templateText, "utf8");
    }
    await runCommand(
      "uv",
      [
        "--project",
        AUTOMATION_PROJECT_DIR,
        "run",
        "python",
        "-c",
        PROFILE_PREVIEW_SCRIPT,
        profilePath,
        templatePath,
        outputPath,
      ],
      context.appDir,
    );
    return fs.readFileSync(outputPath);
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
};

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
    return null;
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
  if (command.tailorModels && command.tailorModels.length > 0) {
    params.tailorModels = command.tailorModels;
  }
  if (command.tailorJudgeModel) {
    params.tailorJudgeModel = command.tailorJudgeModel;
  }
  if (command.tailorJudgeMinScore !== undefined) {
    params.tailorJudgeMinScore = command.tailorJudgeMinScore;
  }
  if (command.jobKey !== PIPELINE_ACTION_JOB_KEY) {
    params.jobUrl = command.jobKey;
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
  if (command.jobKey !== PIPELINE_ACTION_JOB_KEY) {
    params.jobUrl = command.jobKey;
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

function runCommand(command: string, args: string[], appDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        JOBHUNTER_DIR: appDir,
      },
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

const PROFILE_PREVIEW_SCRIPT = `
import json
import sys
from pathlib import Path

from jobhunter.infrastructure.materials.latex_pdf import build_latex, render_pdf_latex

profile_path = Path(sys.argv[1])
template_path = Path(sys.argv[2])
output_path = Path(sys.argv[3])

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

template_text = template_path.read_text(encoding="utf-8") if template_path.exists() else None
latex = build_latex(data, profile, template_text=template_text)
render_pdf_latex(latex, str(output_path))
`;

function extractProfileImportDraft(result: unknown): Omit<ProfileImportResult, "action"> {
  // The JSON-RPC ``profile_import`` handler returns the
  // ``LocalActionResult`` dict; the draft lives at ``result.draft``.
  const record = isRecord(result) ? result : {};
  const draftRoot = isRecord(record.result) ? record.result : record;
  const draft =
    isRecord(draftRoot) && isRecord(draftRoot.draft) ? draftRoot.draft : draftRoot;
  const response: Omit<ProfileImportResult, "action"> = {};
  if (isRecord(draft) && "profile" in draft) {
    // Drafts often miss optional sections (the importer is best-effort) —
    // surface a typed profile when validation succeeds, drop it otherwise so
    // callers don't get back a half-shaped object that fails downstream.
    const parsed = ProfileSchema.safeParse(draft.profile);
    if (parsed.success) {
      response.profile = parsed.data;
    }
  }
  if (isRecord(draft) && "style" in draft) {
    response.style = draft.style;
  }
  if (
    isRecord(draft) &&
    "latex_template" in draft &&
    isRecord(draft.latex_template) &&
    typeof draft.latex_template.text === "string"
  ) {
    response.templateText = draft.latex_template.text;
  }
  if (isRecord(draft) && "source" in draft) {
    response.source = draft.source;
  }
  return response;
}

function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).replace(/[^A-Za-z0-9._-]/g, "_");
  return base || "resume.pdf";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
