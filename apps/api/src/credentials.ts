import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import type {
  CredentialBatchOperation,
  CredentialKey,
  CredentialsResponse,
  ProviderConfigurationKey,
  SecretCredentialKey,
} from "./contracts.js";
import {
  CREDENTIAL_VALUE_MAX_LENGTH,
  CredentialKeys,
  CredentialUpdateRequestSchema,
  ProviderConfigurationKeys,
  SecretCredentialKeys,
} from "./contracts.js";
import { isRecord, readConfigObject, updateConfigObject } from "./config-file.js";

export const KEYCHAIN_SERVICE = "JobCtrl";
export const KEYCHAIN_SECURITY_BINARY = "/usr/bin/security";
export const KEYCHAIN_ACCOUNT_MAPPING = "key" as const;
export const KEYCHAIN_REQUIRES_WORKER_RESTART = true as const;
/** Hard ceiling for every macOS `security` invocation, mirrored by the Python runtime. */
export const KEYCHAIN_COMMAND_TIMEOUT_MS = 2_000;

const MAX_CAPTURED_OUTPUT_CHARS = CREDENTIAL_VALUE_MAX_LENGTH + 2;
const CONFIRMED_NOT_FOUND_MESSAGES = new Set([
  "The specified item could not be found.",
  "The specified item could not be found in the keychain.",
]);

const LABELS: Record<CredentialKey, string> = {
  OPENAI_API_KEY: "OpenAI API key",
  ANTHROPIC_API_KEY: "Anthropic API key",
  CLAUDE_CODE_USE_VERTEX: "Claude Google Cloud Agent Platform mode",
  ANTHROPIC_VERTEX_PROJECT_ID: "Claude Google Cloud project",
  CLOUD_ML_REGION: "Claude Google Cloud region",
  CLAUDE_CODE_USE_BEDROCK: "Claude Amazon Bedrock mode",
  CLAUDE_CODE_USE_ANTHROPIC_AWS: "Claude Platform on AWS mode",
  ANTHROPIC_AWS_WORKSPACE_ID: "Claude Platform on AWS workspace",
  CLAUDE_CODE_USE_FOUNDRY: "Claude Microsoft Foundry mode",
  ANTHROPIC_FOUNDRY_RESOURCE: "Claude Microsoft Foundry resource",
  AWS_REGION: "AWS region",
  AWS_PROFILE: "AWS profile",
  GEMINI_API_KEY: "Gemini API key",
  GOOGLE_GENAI_USE_VERTEXAI: "Google Vertex AI mode",
  GOOGLE_CLOUD_PROJECT: "Google Cloud project",
  GOOGLE_CLOUD_LOCATION: "Google Cloud location",
  GOOGLE_APPLICATION_CREDENTIALS: "Google service-account JSON path",
  CAPSOLVER_API_KEY: "CapSolver API key",
};

export interface CredentialStore {
  list(): Promise<CredentialsResponse>;
  set(key: CredentialKey, value: string): Promise<CredentialsResponse>;
  delete(key: CredentialKey): Promise<CredentialsResponse>;
  applyBatch(operations: readonly CredentialBatchOperation[]): Promise<CredentialsResponse>;
}

export interface SecurityCommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

export interface SecurityCommandOptions {
  sensitiveInput?: string;
  timeoutMs: number;
}

export type SecurityCommandRunner = (
  args: string[],
  options: SecurityCommandOptions,
) => Promise<SecurityCommandResult>;

interface SecurityInputStream {
  destroy(): unknown;
  end(): unknown;
  end(chunk: string, encoding: BufferEncoding): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

interface SecurityOutputStream {
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
}

export interface SecurityChildProcess {
  readonly stdin: SecurityInputStream;
  readonly stdout: SecurityOutputStream;
  readonly stderr: SecurityOutputStream;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

export type SecurityProcessSpawner = (
  binary: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "pipe"] },
) => SecurityChildProcess;

export type CredentialStoreFailureReason =
  | "operational_failure"
  | "partial_failure"
  | "unsupported_platform";

const CREDENTIAL_STORE_MESSAGES: Record<CredentialStoreFailureReason, string> =
  {
    unsupported_platform:
      "macOS Keychain credential editing is unavailable on this platform.",
    operational_failure:
      "macOS Keychain is temporarily unavailable. Unlock Keychain Access and retry.",
    partial_failure:
      "Credential update failed and Keychain recovery was incomplete. Provider credentials may be partially updated; inspect Keychain before retrying.",
  };

export class CredentialStoreUnavailableError extends Error {
  readonly reason: CredentialStoreFailureReason;

  constructor(reason: CredentialStoreFailureReason = "unsupported_platform") {
    super(CREDENTIAL_STORE_MESSAGES[reason]);
    this.name = "CredentialStoreUnavailableError";
    this.reason = reason;
  }
}

export class CredentialManagedByEnvironmentError extends Error {
  readonly key: CredentialKey;

  constructor(key: CredentialKey) {
    super("This credential is managed by the launch environment and cannot be changed here.");
    this.name = "CredentialManagedByEnvironmentError";
    this.key = key;
  }
}

class SecurityCommandRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityCommandRunnerError";
  }
}

export interface KeychainCredentialStoreOptions {
  platform?: NodeJS.Platform;
  runSecurity?: SecurityCommandRunner;
  commandTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

type KeychainSnapshot =
  | { configured: false }
  | { configured: true; value: string };

export class KeychainCredentialStore implements CredentialStore {
  private readonly platform: NodeJS.Platform;
  private readonly runSecurity: SecurityCommandRunner;
  private readonly commandTimeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly configPath: string;

  constructor(options: KeychainCredentialStoreOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.runSecurity = options.runSecurity ?? defaultSecurityCommandRunner;
    this.commandTimeoutMs = normalizeTimeout(
      options.commandTimeoutMs ?? KEYCHAIN_COMMAND_TIMEOUT_MS,
    );
    this.env = options.env ?? process.env;
    this.configPath = options.configPath ?? defaultConfigPath(this.env);
  }

  async list(): Promise<CredentialsResponse> {
    const configured = new Map<CredentialKey, boolean | null>();
    const providerConfiguration = readProviderConfiguration(
      readConfigObject(this.configPath),
    );
    for (const key of ProviderConfigurationKeys) {
      configured.set(key, Boolean(providerConfiguration[key]?.trim()));
    }
    const keychainConfigured = this.supported
      ? await Promise.all(SecretCredentialKeys.map((key) => this.inspect(key)))
      : SecretCredentialKeys.map(() => null);
    SecretCredentialKeys.forEach((key, index) => {
      configured.set(key, keychainConfigured[index] ?? null);
    });
    const unavailableReason = this.supported
      ? keychainConfigured.some((value) => value === null)
        ? "inspection_failed" as const
        : null
      : "unsupported_platform" as const;
    return this.response(
      configured,
      unavailableReason,
    );
  }

  async set(key: CredentialKey, value: string): Promise<CredentialsResponse> {
    if (isProviderConfigurationKey(key)) {
      this.updateProviderConfiguration([{ operation: "set", key, value }]);
      return this.list();
    }
    this.ensureNotEnvironmentManaged(key);
    this.ensureSupported();
    await this.setWithoutInspection(key, value as SecretCredentialKey);
    return this.list();
  }

  async delete(key: CredentialKey): Promise<CredentialsResponse> {
    if (isProviderConfigurationKey(key)) {
      this.updateProviderConfiguration([{ operation: "delete", key }]);
      return this.list();
    }
    this.ensureNotEnvironmentManaged(key);
    this.ensureSupported();
    await this.deleteWithoutInspection(key as SecretCredentialKey);
    return this.list();
  }

  async applyBatch(
    operations: readonly CredentialBatchOperation[],
  ): Promise<CredentialsResponse> {
    const secretOperations = operations.filter(
      (operation): operation is CredentialBatchOperation & { key: SecretCredentialKey } =>
        isSecretCredentialKey(operation.key),
    );
    const configurationOperations = operations.filter(
      (operation): operation is CredentialBatchOperation & { key: ProviderConfigurationKey } =>
        isProviderConfigurationKey(operation.key),
    );
    for (const operation of secretOperations) {
      this.ensureNotEnvironmentManaged(operation.key);
    }
    if (secretOperations.length > 0) {
      this.ensureSupported();
    }
    const snapshots = new Map<SecretCredentialKey, KeychainSnapshot>();
    for (const operation of secretOperations) {
      if (!snapshots.has(operation.key)) {
        snapshots.set(operation.key, await this.snapshot(operation.key));
      }
    }

    try {
      for (const operation of secretOperations) {
        await this.applyOperation(operation);
      }
      if (configurationOperations.length > 0) {
        this.updateProviderConfiguration(configurationOperations);
      }
    } catch {
      const restored = await this.restoreSnapshots(snapshots);
      throw new CredentialStoreUnavailableError(
        restored ? "operational_failure" : "partial_failure",
      );
    }
    return this.list();
  }

  private async applyOperation(
    operation: CredentialBatchOperation & { key: SecretCredentialKey },
  ): Promise<void> {
    if (operation.operation === "set") {
      await this.setWithoutInspection(operation.key, operation.value);
    } else {
      await this.deleteWithoutInspection(operation.key);
    }
  }

  private async snapshot(key: SecretCredentialKey): Promise<KeychainSnapshot> {
    const result = await this.execute([
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      keychainAccount(key),
      "-w",
    ]);
    if (result.code === 0) {
      const value = stripTerminalLineEnding(result.stdout);
      if (!CredentialUpdateRequestSchema.safeParse({ key, value }).success) {
        throw new CredentialStoreUnavailableError("operational_failure");
      }
      return { configured: true, value };
    }
    if (isConfirmedNotFound(result)) {
      return { configured: false };
    }
    throw new CredentialStoreUnavailableError("operational_failure");
  }

  private async restoreSnapshots(
    snapshots: ReadonlyMap<SecretCredentialKey, KeychainSnapshot>,
  ): Promise<boolean> {
    let restored = true;
    for (const [key, snapshot] of snapshots) {
      try {
        if (snapshot.configured) {
          await this.setWithoutInspection(key, snapshot.value);
        } else {
          await this.deleteWithoutInspection(key);
        }
      } catch {
        restored = false;
      }
    }
    return restored;
  }

  private async setWithoutInspection(key: SecretCredentialKey, value: string): Promise<void> {
    const result = await this.execute(
      [
        "add-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        keychainAccount(key),
        "-U",
        "-w",
      ],
      value,
    );
    if (result.code !== 0) {
      throw new CredentialStoreUnavailableError("operational_failure");
    }
  }

  private async deleteWithoutInspection(key: SecretCredentialKey): Promise<void> {
    const result = await this.execute([
      "delete-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      keychainAccount(key),
    ]);
    if (result.code !== 0 && !isConfirmedNotFound(result)) {
      throw new CredentialStoreUnavailableError("operational_failure");
    }
  }

  private async inspect(key: SecretCredentialKey): Promise<boolean | null> {
    try {
      const result = await this.execute([
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        keychainAccount(key),
      ]);
      if (result.code === 0) {
        return true;
      }
      return isConfirmedNotFound(result) ? false : null;
    } catch {
      return null;
    }
  }

  private async execute(
    args: string[],
    sensitiveInput?: string,
  ): Promise<SecurityCommandResult> {
    let pending: Promise<SecurityCommandResult>;
    try {
      pending = this.runSecurity(args, {
        ...(sensitiveInput === undefined ? {} : { sensitiveInput }),
        timeoutMs: this.commandTimeoutMs,
      });
    } catch {
      throw new CredentialStoreUnavailableError("operational_failure");
    }

    try {
      const result = await withTimeout(pending, this.commandTimeoutMs);
      if (!isSecurityCommandResult(result)) {
        throw new SecurityCommandRunnerError(
          "Keychain command returned an invalid result.",
        );
      }
      return result;
    } catch {
      throw new CredentialStoreUnavailableError("operational_failure");
    }
  }

  private get supported(): boolean {
    return this.platform === "darwin";
  }

  private response(
    configured: ReadonlyMap<CredentialKey, boolean | null>,
    unavailableReason: CredentialsResponse["store"]["unavailableReason"],
  ): CredentialsResponse {
    return {
      ok: true,
      store: {
        kind: "config_and_macos_keychain",
        available: unavailableReason === null,
        unavailableReason,
        requiresWorkerRestart: KEYCHAIN_REQUIRES_WORKER_RESTART,
      },
      credentials: CredentialKeys.map((key) => ({
        key,
        label: LABELS[key],
        configured: configured.get(key) ?? null,
        storage: isProviderConfigurationKey(key) ? "config" as const : "keychain" as const,
        effectiveSource: this.effectiveSource(key, configured.get(key) ?? null),
        editable: isProviderConfigurationKey(key)
          ? true
          : !this.environmentOwned(key) && configured.get(key) !== null && this.supported,
      })),
    };
  }

  private effectiveSource(
    key: CredentialKey,
    configured: boolean | null,
  ): CredentialsResponse["credentials"][number]["effectiveSource"] {
    if (isProviderConfigurationKey(key)) {
      return configured ? "config" : "absent";
    }
    if (this.environmentOwned(key)) return "environment";
    if (configured === true) return "keychain";
    if (configured === false) return "absent";
    return "inspection_unknown";
  }

  private environmentOwned(key: CredentialKey): boolean {
    return isSecretCredentialKey(key) && Boolean(this.env[key]?.trim());
  }

  private ensureNotEnvironmentManaged(key: CredentialKey): void {
    if (this.environmentOwned(key)) {
      throw new CredentialManagedByEnvironmentError(key);
    }
  }

  private ensureSupported(): void {
    if (!this.supported) {
      throw new CredentialStoreUnavailableError("unsupported_platform");
    }
  }

  private updateProviderConfiguration(
    operations: readonly (CredentialBatchOperation & { key: ProviderConfigurationKey })[],
  ): void {
    updateConfigObject(this.configPath, (config) => {
      const values = readProviderConfiguration(config);
      for (const operation of operations) {
        if (operation.operation === "set") {
          values[operation.key] = operation.value.trim();
        } else {
          delete values[operation.key];
        }
      }
      writeProviderConfiguration(config, values);
    });
  }
}

type ProviderConfigurationValues = Partial<Record<ProviderConfigurationKey, string>>;

function isProviderConfigurationKey(key: CredentialKey): key is ProviderConfigurationKey {
  return (ProviderConfigurationKeys as readonly string[]).includes(key);
}

function isSecretCredentialKey(key: CredentialKey): key is SecretCredentialKey {
  return (SecretCredentialKeys as readonly string[]).includes(key);
}

function defaultConfigPath(env: NodeJS.ProcessEnv): string {
  const configured = env.JOBCTRL_CONFIG_PATH?.trim();
  if (configured) {
    if (configured === "~") return os.homedir();
    if (configured.startsWith("~/") || configured.startsWith("~\\")) {
      return path.join(os.homedir(), configured.slice(2));
    }
    return configured;
  }
  const appDir = env.JOBCTRL_DIR?.trim() || path.join(os.homedir(), ".jobctrl");
  return path.join(appDir, "config.json");
}

function readProviderConfiguration(
  config: Readonly<Record<string, unknown>>,
): ProviderConfigurationValues {
  const result: ProviderConfigurationValues = {};
  const connections = isRecord(config["provider_connections"])
    ? config["provider_connections"]
    : {};
  const claude = isRecord(connections["claude"]) ? connections["claude"] : {};
  const google = isRecord(connections["google"]) ? connections["google"] : {};
  const shared = isRecord(connections["shared"]) ? connections["shared"] : {};

  const claudeMode = textValue(claude["mode"]);
  if (claudeMode === "vertex") result.CLAUDE_CODE_USE_VERTEX = "1";
  if (claudeMode === "bedrock") result.CLAUDE_CODE_USE_BEDROCK = "1";
  if (claudeMode === "anthropic_aws") result.CLAUDE_CODE_USE_ANTHROPIC_AWS = "1";
  if (claudeMode === "foundry") result.CLAUDE_CODE_USE_FOUNDRY = "1";
  copyConfiguredValue(result, "ANTHROPIC_VERTEX_PROJECT_ID", claude["vertex_project_id"]);
  copyConfiguredValue(result, "CLOUD_ML_REGION", claude["vertex_region"]);
  copyConfiguredValue(result, "ANTHROPIC_AWS_WORKSPACE_ID", claude["aws_workspace_id"]);
  copyConfiguredValue(result, "ANTHROPIC_FOUNDRY_RESOURCE", claude["foundry_resource"]);
  copyConfiguredValue(result, "AWS_PROFILE", claude["aws_profile"]);
  copyConfiguredValue(result, "AWS_REGION", claude["aws_region"]);

  if (textValue(google["mode"]) === "vertex") {
    result.GOOGLE_GENAI_USE_VERTEXAI = "true";
  }
  copyConfiguredValue(result, "GOOGLE_CLOUD_PROJECT", google["project_id"]);
  copyConfiguredValue(result, "GOOGLE_CLOUD_LOCATION", google["location"]);
  copyConfiguredValue(
    result,
    "GOOGLE_APPLICATION_CREDENTIALS",
    shared["google_application_credentials_path"],
  );
  return result;
}

function writeProviderConfiguration(
  config: Record<string, unknown>,
  values: ProviderConfigurationValues,
): void {
  const connections: Record<string, unknown> = {};
  const claude: Record<string, unknown> = {};
  const claudeMode = values.CLAUDE_CODE_USE_VERTEX
    ? "vertex"
    : values.CLAUDE_CODE_USE_BEDROCK
      ? "bedrock"
      : values.CLAUDE_CODE_USE_ANTHROPIC_AWS
        ? "anthropic_aws"
        : values.CLAUDE_CODE_USE_FOUNDRY
          ? "foundry"
          : null;
  if (claudeMode) claude["mode"] = claudeMode;
  assignConfiguredValue(claude, "vertex_project_id", values.ANTHROPIC_VERTEX_PROJECT_ID);
  assignConfiguredValue(claude, "vertex_region", values.CLOUD_ML_REGION);
  assignConfiguredValue(claude, "aws_workspace_id", values.ANTHROPIC_AWS_WORKSPACE_ID);
  assignConfiguredValue(claude, "foundry_resource", values.ANTHROPIC_FOUNDRY_RESOURCE);
  assignConfiguredValue(claude, "aws_profile", values.AWS_PROFILE);
  assignConfiguredValue(claude, "aws_region", values.AWS_REGION);
  if (Object.keys(claude).length > 0) connections["claude"] = claude;

  const google: Record<string, unknown> = {};
  if (values.GOOGLE_GENAI_USE_VERTEXAI) google["mode"] = "vertex";
  assignConfiguredValue(google, "project_id", values.GOOGLE_CLOUD_PROJECT);
  assignConfiguredValue(google, "location", values.GOOGLE_CLOUD_LOCATION);
  if (Object.keys(google).length > 0) connections["google"] = google;

  const shared: Record<string, unknown> = {};
  assignConfiguredValue(
    shared,
    "google_application_credentials_path",
    values.GOOGLE_APPLICATION_CREDENTIALS,
  );
  if (Object.keys(shared).length > 0) connections["shared"] = shared;

  if (Object.keys(connections).length > 0) {
    config["provider_connections"] = connections;
  } else {
    delete config["provider_connections"];
  }
}

function copyConfiguredValue(
  target: ProviderConfigurationValues,
  key: ProviderConfigurationKey,
  value: unknown,
): void {
  const normalized = textValue(value);
  if (normalized) target[key] = normalized;
}

function assignConfiguredValue(
  target: Record<string, unknown>,
  key: string,
  value: string | undefined,
): void {
  const normalized = value?.trim();
  if (normalized) target[key] = normalized;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function createSecurityCommandRunner(
  spawnSecurity: SecurityProcessSpawner = defaultSecurityProcessSpawner,
): SecurityCommandRunner {
  return (args, options) =>
    new Promise<SecurityCommandResult>((resolve, reject) => {
      const sensitiveInput = options.sensitiveInput;
      if (!validSensitiveInputContract(args, sensitiveInput)) {
        reject(
          new SecurityCommandRunnerError("Keychain command input is invalid."),
        );
        return;
      }

      let child: SecurityChildProcess;
      try {
        child = spawnSecurity(KEYCHAIN_SECURITY_BINARY, args, {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        reject(
          new SecurityCommandRunnerError("Keychain command could not start."),
        );
        return;
      }

      let settled = false;
      let stdout = "";
      let stderr = "";
      const timeoutMs = normalizeTimeout(options.timeoutMs);
      let timeout: NodeJS.Timeout | undefined;

      const terminateChild = (): void => {
        try {
          child.stdin.destroy();
        } catch {
          // The sanitized command failure remains authoritative.
        }
        try {
          child.kill("SIGKILL");
        } catch {
          // The sanitized command failure remains authoritative.
        }
      };

      const settle = (action: () => void): boolean => {
        if (settled) {
          return false;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        action();
        return true;
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr = appendBounded(stderr, chunk);
      });
      child.on("error", () => {
        settle(() => {
          terminateChild();
          reject(
            new SecurityCommandRunnerError("Keychain command could not start."),
          );
        });
      });
      child.on("close", (code) => {
        settle(() =>
          resolve({
            code: code ?? 1,
            stderr: stderr.trim(),
            stdout,
          }),
        );
      });

      child.stdin.on("error", () => {
        settle(() => {
          terminateChild();
          reject(
            new SecurityCommandRunnerError("Keychain command input failed."),
          );
        });
      });

      timeout = setTimeout(() => {
        settle(() => {
          terminateChild();
          reject(new SecurityCommandRunnerError("Keychain command timed out."));
        });
      }, timeoutMs);

      try {
        if (sensitiveInput === undefined) {
          child.stdin.end();
        } else {
          child.stdin.end(keychainPromptInput(sensitiveInput), "utf8");
        }
      } catch {
        settle(() => {
          terminateChild();
          reject(
            new SecurityCommandRunnerError("Keychain command input failed."),
          );
        });
      }
    });
}

const defaultSecurityProcessSpawner: SecurityProcessSpawner = (
  binary,
  args,
  options,
) => spawn(binary, args, options) as SecurityChildProcess;

const defaultSecurityCommandRunner = createSecurityCommandRunner();

function normalizeTimeout(timeoutMs: number): number {
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : KEYCHAIN_COMMAND_TIMEOUT_MS;
}

function appendBounded(current: string, chunk: string | Buffer): string {
  if (current.length >= MAX_CAPTURED_OUTPUT_CHARS) {
    return current;
  }
  return `${current}${String(chunk)}`.slice(0, MAX_CAPTURED_OUTPUT_CHARS);
}

function validSensitiveInputContract(
  args: readonly string[],
  sensitiveInput: string | undefined,
): boolean {
  if (args[0] !== "add-generic-password") {
    return sensitiveInput === undefined;
  }
  const parsedInput = CredentialUpdateRequestSchema.safeParse({
    key: args[4],
    value: sensitiveInput,
  });
  return (
    args.length === 7 &&
    args[1] === "-s" &&
    args[2] === KEYCHAIN_SERVICE &&
    args[3] === "-a" &&
    args[5] === "-U" &&
    args.at(-1) === "-w" &&
    parsedInput.success
  );
}

function keychainPromptInput(sensitiveInput: string): string {
  // Bare `-w` confirms a new value by prompting twice. One bounded write
  // supplies both answers and closes stdin; the value never enters argv.
  return `${sensitiveInput}\n${sensitiveInput}\n`;
}

function stripTerminalLineEnding(value: string): string {
  return value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
}

function isSecurityCommandResult(
  value: unknown,
): value is SecurityCommandResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SecurityCommandResult>;
  return (
    Number.isInteger(candidate.code) &&
    typeof candidate.stderr === "string" &&
    typeof candidate.stdout === "string"
  );
}

function isConfirmedNotFound(result: SecurityCommandResult): boolean {
  if (result.code === 44) {
    return true;
  }
  const sanitized = result.stderr
    .trim()
    .replace(/^security:\s*[^:\r\n]+:\s*/i, "");
  return CONFIRMED_NOT_FOUND_MESSAGES.has(sanitized);
}

function keychainAccount(key: CredentialKey): string {
  if (KEYCHAIN_ACCOUNT_MAPPING !== "key") {
    throw new CredentialStoreUnavailableError("operational_failure");
  }
  return key;
}

function withTimeout<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new SecurityCommandRunnerError("Keychain command timed out."));
    }, timeoutMs);

    void pending.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      },
      () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(new SecurityCommandRunnerError("Keychain command failed."));
      },
    );
  });
}
