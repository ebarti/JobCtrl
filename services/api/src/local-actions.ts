import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ActionCommandPayload, ActionRunResponse } from "./contracts.js";

export interface ActionDispatchContext {
  appDir: string;
}

export interface ActionDispatchResult {
  status: string;
  actionId?: string;
  runId?: string;
  result?: unknown;
  message?: string;
}

export type ActionDispatcher = (
  command: ActionCommandPayload,
  context: ActionDispatchContext,
) => Promise<ActionDispatchResult>;

export type ArtifactOpener = (artifactPath: string) => Promise<void>;

export interface ProfileImportInput {
  filename: string;
  pdfBytes: Buffer;
  importProfile: boolean;
  importStyle: boolean;
}

export interface ProfileImportResult {
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

export const defaultActionDispatcher: ActionDispatcher = async (command, context) => {
  if (command.action === "retry_stage" && !command.runAfter) {
    return { status: "reset", message: "Stage reset for retry." };
  }

  const commands = buildCliCommands(command);
  const pids = commands.map((argv) => spawnDetached(argv, context.appDir));
  return {
    status: "queued",
    result: {
      commands: commands.map((argv) => ["uv", ...argv]),
      pids,
    },
  };
};

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
    const result = await runProfileImportCli(pdfPath, input, context);
    const draft = extractProfileImportDraft(result);
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
        result,
      },
    };
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
  if (extra.stage) {
    response.stage = extra.stage;
  }
  return response;
}

function buildCliCommands(command: ActionCommandPayload): string[][] {
  if (command.action === "retry_stage") {
    if (!command.stage || !command.runAfter) {
      return [];
    }
    if (command.stage === "apply") {
      return [applyActionArgs(command)];
    }
    return [stageActionArgs(command.stage, command.limit ?? 1, Boolean(command.dryRun))];
  }

  if (command.action === "generate_materials") {
    return (command.stages ?? ["tailor", "cover", "pdf"]).map((stage) =>
      stageActionArgs(stage, command.limit ?? 1, Boolean(command.dryRun)),
    );
  }

  if (command.action === "apply") {
    return [applyActionArgs(command)];
  }

  return [];
}

function stageActionArgs(stage: string, limit: number, dryRun: boolean): string[] {
  const args = ["run", "jobhunter", "action", stage, "--limit", String(limit)];
  if (dryRun) {
    args.push("--dry-run");
  }
  return args;
}

function applyActionArgs(command: ActionCommandPayload): string[] {
  const args = [
    "run",
    "jobhunter",
    "action",
    "apply",
    "--url",
    command.jobKey,
    "--limit",
    String(command.limit ?? 1),
    "--model",
    command.model ?? "haiku",
  ];
  if (command.dryRun !== false) {
    args.push("--dry-run");
  }
  if (command.headless) {
    args.push("--headless");
  }
  return args;
}

function spawnDetached(argv: string[], appDir: string): number | undefined {
  const child = spawn("uv", argv, {
    detached: true,
    env: {
      ...process.env,
      JOBHUNTER_DIR: appDir,
    },
    stdio: "ignore",
  });
  child.unref();
  return child.pid;
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

async function runProfileImportCli(
  pdfPath: string,
  _input: ProfileImportInput,
  context: ActionDispatchContext,
): Promise<unknown> {
  const args = ["run", "jobhunter", "action", "profile_import", "--pdf", pdfPath];
  return runJsonCommand("uv", args, context.appDir);
}

function runJsonCommand(command: string, args: string[], appDir: string): Promise<unknown> {
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
      const parsed = parseFirstJsonObject(stdout);
      if (code === 0 && parsed !== undefined) {
        resolve(parsed);
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `Command failed with exit code ${code ?? "unknown"}.`));
    });
  });
}

function parseFirstJsonObject(output: string): unknown {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function extractProfileImportDraft(result: unknown): Omit<ProfileImportResult, "action"> {
  const record = isRecord(result) ? result : {};
  const draft = isRecord(record.result) && isRecord(record.result.draft) ? record.result.draft : {};
  const response: Omit<ProfileImportResult, "action"> = {};
  if ("profile" in draft) {
    response.profile = draft.profile;
  }
  if ("style" in draft) {
    response.style = draft.style;
  }
  if ("latex_template" in draft && isRecord(draft.latex_template) && typeof draft.latex_template.text === "string") {
    response.templateText = draft.latex_template.text;
  }
  if ("source" in draft) {
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
