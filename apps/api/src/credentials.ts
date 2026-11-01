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
import {
  CredentialMutationLockError,
  CredentialMutationPendingError,
  withCredentialMutationLock,
  type CredentialMutationGuard,
} from "./credential-mutation-lock.js";
import type { ProcessIdentityReader } from "./credential-process-identity.js";
import {
  createLinuxSecretServiceRunner,
  createWindowsCredentialManagerRunner,
  nativeCredentialMaxBytes,
  nativeCredentialValueSupported,
  nativeStoreKind,
  NATIVE_CREDENTIAL_COMMAND_TIMEOUT_MS,
  WINDOWS_CREDENTIAL_COMMAND_TIMEOUT_MS,
  type NativeCredentialCommandRunner,
} from "./native-credential-store.js";

export const KEYCHAIN_SERVICE = "JobCtrl";
export const KEYCHAIN_SECURITY_BINARY = "/usr/bin/security";
export const KEYCHAIN_ACCOUNT_MAPPING = "key" as const;
export const KEYCHAIN_REQUIRES_WORKER_RESTART = true as const;
/** Hard ceiling for every macOS `security` invocation, mirrored by the Python runtime. */
export const KEYCHAIN_COMMAND_TIMEOUT_MS = 2_000;

const MAX_CAPTURED_OUTPUT_CHARS = CREDENTIAL_VALUE_MAX_LENGTH * 8 + 4_096;
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
  onSpawn?: (pid: number, isRunning?: () => boolean) => Promise<void>;
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
  readonly pid?: number;
  readonly stdin: SecurityInputStream;
  readonly stdout: SecurityOutputStream;
  readonly stderr: SecurityOutputStream;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

export type SecurityProcessSpawner = (
  binary: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "pipe"] },
) => SecurityChildProcess;

export type CredentialStoreFailureReason =
  | "busy"
  | "ownership_unverified"
  | "operational_failure"
  | "partial_failure"
  | "unsupported_platform";

const CREDENTIAL_STORE_MESSAGES: Record<CredentialStoreFailureReason, string> =
  {
    busy: "Another credential update is in progress. Retry after it finishes.",
    ownership_unverified:
      "Credential update ownership could not be verified. Restore process inspection or verify the previous helper has exited before clearing its coordination record.",
    unsupported_platform:
      "Native credential storage is unavailable on this platform.",
    operational_failure:
      "The native credential store is temporarily unavailable. Unlock it and retry.",
    partial_failure:
      "Credential update failed and native-store recovery was incomplete. Provider credentials may be partially updated; inspect the native credential store before retrying.",
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

export class CredentialValueUnsupportedError extends Error {
  readonly key: SecretCredentialKey;
  readonly maxBytes: number;

  constructor(key: SecretCredentialKey, maxBytes: number) {
    super(`This credential exceeds the native store's secure ${maxBytes}-byte input limit.`);
    this.name = "CredentialValueUnsupportedError";
    this.key = key;
    this.maxBytes = maxBytes;
  }
}

class SecurityCommandRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityCommandRunnerError";
  }
}

class SecurityCommandTimeoutError extends SecurityCommandRunnerError {}
class CredentialMutationUncertainError extends Error {}

export interface KeychainCredentialStoreOptions {
  platform?: NodeJS.Platform;
  runSecurity?: SecurityCommandRunner;
  runNative?: NativeCredentialCommandRunner;
  commandTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  service?: string;
  /** Isolated coordinator path and timeout for synthetic tests. */
  mutationLockPath?: string;
  mutationLockTimeoutMs?: number;
  processIdentityReader?: ProcessIdentityReader;
}

type KeychainSnapshot =
  | { configured: false }
  | { configured: true; value: string };

export class KeychainCredentialStore implements CredentialStore {
  private readonly platform: NodeJS.Platform;
  private readonly runSecurity: SecurityCommandRunner;
  private readonly runNative: NativeCredentialCommandRunner | null;
  private readonly commandTimeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly configPath: string;
  private readonly service: string;
  private readonly mutationLockPath: string | undefined;
  private readonly mutationLockTimeoutMs: number | undefined;
  private readonly processIdentityReader: ProcessIdentityReader | undefined;
  private activeMutationGuard: CredentialMutationGuard | undefined;

  constructor(options: KeychainCredentialStoreOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.runSecurity = options.runSecurity ?? defaultSecurityCommandRunner;
    this.runNative = options.runNative ?? (
      this.platform === "linux"
        ? createLinuxSecretServiceRunner()
        : this.platform === "win32"
          ? createWindowsCredentialManagerRunner(options.env ?? process.env)
          : null
    );
    this.commandTimeoutMs = normalizeTimeout(
      options.commandTimeoutMs ?? (
        this.platform === "darwin"
          ? KEYCHAIN_COMMAND_TIMEOUT_MS
          : this.platform === "win32"
            ? WINDOWS_CREDENTIAL_COMMAND_TIMEOUT_MS
          : NATIVE_CREDENTIAL_COMMAND_TIMEOUT_MS
      ),
    );
    this.env = options.env ?? process.env;
    this.configPath = options.configPath ?? defaultConfigPath(this.env);
    this.service = options.service ?? KEYCHAIN_SERVICE;
    this.mutationLockPath = options.mutationLockPath;
    this.mutationLockTimeoutMs = options.mutationLockTimeoutMs;
    this.processIdentityReader = options.processIdentityReader;
  }

  async list(): Promise<CredentialsResponse> {
    const configured = new Map<CredentialKey, boolean | null>();
    const providerConfiguration = readProviderConfiguration(
      readConfigObject(this.configPath),
    );
    for (const key of ProviderConfigurationKeys) {
      configured.set(key, Boolean(providerConfiguration[key]?.trim()));
    }
    const nativeConfigured = this.supported
      ? await Promise.all(SecretCredentialKeys.map((key) => this.inspect(key)))
      : SecretCredentialKeys.map(() => null);
    SecretCredentialKeys.forEach((key, index) => {
      configured.set(key, nativeConfigured[index] ?? null);
    });
    const unavailableReason = this.supported
      ? nativeConfigured.some((value) => value === null)
        ? "inspection_failed" as const
        : null
      : "unsupported_platform" as const;
    return this.response(
      configured,
      unavailableReason,
    );
  }

  async set(key: CredentialKey, value: string): Promise<CredentialsResponse> {
    if (isSecretCredentialKey(key)) {
      this.ensureNotEnvironmentManaged(key);
      this.ensureSupported();
      this.ensureValueSupported(key, value);
    }
    return this.withMutationLock(async () => {
      if (isProviderConfigurationKey(key)) {
        this.updateProviderConfiguration([{ operation: "set", key, value }]);
        return this.list();
      }
      this.ensureNotEnvironmentManaged(key);
      this.ensureSupported();
      await this.setWithoutInspection(key, value as SecretCredentialKey);
      return this.list();
    });
  }

  async delete(key: CredentialKey): Promise<CredentialsResponse> {
    if (isSecretCredentialKey(key)) {
      this.ensureNotEnvironmentManaged(key);
      this.ensureSupported();
    }
    return this.withMutationLock(async () => {
      if (isProviderConfigurationKey(key)) {
        this.updateProviderConfiguration([{ operation: "delete", key }]);
        return this.list();
      }
      this.ensureNotEnvironmentManaged(key);
      this.ensureSupported();
      await this.deleteWithoutInspection(key as SecretCredentialKey);
      return this.list();
    });
  }

  async applyBatch(
    operations: readonly CredentialBatchOperation[],
  ): Promise<CredentialsResponse> {
    const capturedOperations = operations.map((operation) => ({ ...operation }));
    this.validateSecretOperations(capturedOperations.filter(
      (operation): operation is CredentialBatchOperation & { key: SecretCredentialKey } =>
        isSecretCredentialKey(operation.key),
    ));
    return this.withMutationLock(() => this.applyBatchLocked(capturedOperations));
  }

  private async applyBatchLocked(
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
    this.validateSecretOperations(secretOperations);
    const snapshots = new Map<SecretCredentialKey, KeychainSnapshot>();
    for (const operation of secretOperations) {
      if (!snapshots.has(operation.key)) {
        snapshots.set(operation.key, await this.snapshot(operation.key));
      }
    }
    for (const [key, snapshot] of snapshots) {
      if (snapshot.configured) this.ensureValueSupported(key, snapshot.value);
    }

    let successfulOperations = 0;
    try {
      for (const operation of secretOperations) {
        await this.applyOperation(operation);
        successfulOperations += 1;
      }
      if (configurationOperations.length > 0) {
        this.updateProviderConfiguration(configurationOperations);
      }
    } catch (error) {
      if (error instanceof CredentialMutationPendingError || error instanceof CredentialMutationUncertainError) throw error;
      if (error instanceof CredentialMutationLockError && error.reason === "unverified" && successfulOperations === 0) throw error;
      const restored = await this.restoreSnapshots(snapshots);
      throw new CredentialStoreUnavailableError(
        restored ? "operational_failure" : "partial_failure",
      );
    }
    return this.list();
  }

  private validateSecretOperations(
    operations: readonly (CredentialBatchOperation & { key: SecretCredentialKey })[],
  ): void {
    for (const operation of operations) this.ensureNotEnvironmentManaged(operation.key);
    if (operations.length > 0) this.ensureSupported();
    for (const operation of operations) {
      if (operation.operation === "set") this.ensureValueSupported(operation.key, operation.value);
    }
  }

  private async withMutationLock<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await withCredentialMutationLock(async (guard) => {
        this.activeMutationGuard = guard;
        try { return await action(); } finally { this.activeMutationGuard = undefined; }
      }, {
        ...(this.mutationLockPath === undefined ? {} : { path: this.mutationLockPath }),
        ...(this.mutationLockTimeoutMs === undefined ? {} : { timeoutMs: this.mutationLockTimeoutMs }),
        ...(this.processIdentityReader === undefined ? {} : { readIdentity: this.processIdentityReader }),
      });
    } catch (error) {
      if (error instanceof CredentialMutationPendingError || error instanceof CredentialMutationUncertainError) {
        throw new CredentialStoreUnavailableError("partial_failure");
      }
      if (error instanceof CredentialMutationLockError) {
        throw new CredentialStoreUnavailableError(
          error.reason === "busy" ? "busy" : error.reason === "unverified" ? "ownership_unverified" : "operational_failure",
        );
      }
      throw error;
    }
  }

  private async startMutation<T>(run: (onSpawn: (pid: number, isRunning?: () => boolean) => Promise<void>) => Promise<T>): Promise<T> {
    if (!this.activeMutationGuard) throw new CredentialStoreUnavailableError("operational_failure");
    let marker: Awaited<ReturnType<CredentialMutationGuard["begin"]>>;
    try {
      marker = await this.activeMutationGuard.begin();
    } catch (error) {
      if (error instanceof CredentialMutationLockError || error instanceof CredentialMutationUncertainError) throw error;
      throw new CredentialStoreUnavailableError("operational_failure");
    }
    let childRegistered = false;
    let registration: Promise<void> | undefined;
    try {
      const pending = run((pid, isRunning) => {
        childRegistered = true;
        registration = marker.started(pid, isRunning);
        return registration;
      });
      return pending.then(
        (value) => { marker.clear(); return value; },
        (error: unknown) => { marker.clear(); throw error; },
      );
    } catch {
      if (registration) await registration.catch(() => undefined);
      // No child can receive mutation input before registration. If a runner
      // throws after registration, leave the PID marker to fence successors.
      if (!childRegistered) {
        try { marker.clear(); } catch { /* Preserve an unverified marker. */ }
      }
      if (childRegistered) throw new CredentialMutationUncertainError();
      throw new CredentialStoreUnavailableError("operational_failure");
    }
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
    const result = await this.executeNative("read", key);
    if (result.code === 0) {
      const value = this.platform === "darwin"
        ? parseMacosTypedPassword(result.stderr)
        : result.stdout;
      if (value === null) {
        throw new CredentialStoreUnavailableError("operational_failure");
      }
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
      } catch (error) {
        if (error instanceof CredentialMutationPendingError || error instanceof CredentialMutationUncertainError) throw error;
        restored = false;
      }
    }
    return restored;
  }

  private async setWithoutInspection(key: SecretCredentialKey, value: string): Promise<void> {
    this.ensureValueSupported(key, value);
    const result = await this.executeNative("set", key, value);
    if (result.code !== 0) {
      throw new CredentialStoreUnavailableError("operational_failure");
    }
  }

  private ensureValueSupported(key: SecretCredentialKey, value: string): void {
    if (nativeCredentialValueSupported(this.platform, value)) return;
    throw new CredentialValueUnsupportedError(
      key,
      nativeCredentialMaxBytes(this.platform) ?? CREDENTIAL_VALUE_MAX_LENGTH,
    );
  }

  private async deleteWithoutInspection(key: SecretCredentialKey): Promise<void> {
    const result = await this.executeNative("delete", key);
    if (result.code !== 0 && !isConfirmedNotFound(result)) {
      throw new CredentialStoreUnavailableError("operational_failure");
    }
  }

  private async inspect(key: SecretCredentialKey): Promise<boolean | null> {
    try {
      const result = await this.executeNative("inspect", key);
      if (result.code === 0) {
        return true;
      }
      return isConfirmedNotFound(result) ? false : null;
    } catch {
      return null;
    }
  }

  /** Private-value seam for migration and owned native QA only. */
  async readForInternalUse(key: SecretCredentialKey): Promise<string | null> {
    this.ensureSupported();
    const snapshot = await this.snapshot(key);
    return snapshot.configured ? snapshot.value : null;
  }

  private async executeNative(
    operation: "inspect" | "read" | "set" | "delete",
    key: SecretCredentialKey,
    value?: string,
  ): Promise<SecurityCommandResult> {
    if (this.platform === "darwin") {
      const args = operation === "set"
        ? ["add-generic-password", "-s", this.service, "-a", keychainAccount(key), "-U", "-w"]
        : operation === "delete"
          ? ["delete-generic-password", "-s", this.service, "-a", keychainAccount(key)]
          : [
              "find-generic-password",
              "-s",
              this.service,
              "-a",
              keychainAccount(key),
              ...(operation === "read" ? ["-g"] : []),
            ];
      return this.execute(args, value, operation === "set" || operation === "delete");
    }
    if (!this.runNative) {
      throw new CredentialStoreUnavailableError("unsupported_platform");
    }
    let pending: Promise<SecurityCommandResult> | undefined;
    try {
      const command = { key, operation, service: this.service, ...(value === undefined ? {} : { value }) };
      pending = operation === "set" || operation === "delete"
        ? this.startMutation((onSpawn) => this.runNative!(command, this.commandTimeoutMs, { onSpawn }))
        : this.runNative(command, this.commandTimeoutMs);
      const result = await withTimeout(
        pending,
        this.commandTimeoutMs,
      );
      if (!isSecurityCommandResult(result)) {
        throw new SecurityCommandRunnerError("Native credential command returned an invalid result.");
      }
      return result;
    } catch (error) {
      if (error instanceof CredentialMutationUncertainError || error instanceof CredentialMutationLockError) throw error;
      if (pending && error instanceof SecurityCommandTimeoutError && (operation === "set" || operation === "delete")) {
        throw new CredentialMutationPendingError(pending);
      }
      throw new CredentialStoreUnavailableError("operational_failure");
    }
  }

  private async execute(
    args: string[],
    sensitiveInput?: string,
    mutating = false,
  ): Promise<SecurityCommandResult> {
    let pending: Promise<SecurityCommandResult>;
    try {
      const options = {
        ...(sensitiveInput === undefined ? {} : { sensitiveInput }),
        timeoutMs: this.commandTimeoutMs,
      };
      pending = mutating
        ? this.startMutation((onSpawn) => this.runSecurity(args, { ...options, onSpawn }))
        : this.runSecurity(args, options);
    } catch (error) {
      if (error instanceof CredentialMutationUncertainError || error instanceof CredentialMutationLockError) throw error;
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
    } catch (error) {
      if (error instanceof CredentialMutationLockError || error instanceof CredentialMutationUncertainError) throw error;
      if (mutating && error instanceof SecurityCommandTimeoutError) {
        throw new CredentialMutationPendingError(pending);
      }
      throw new CredentialStoreUnavailableError("operational_failure");
    }
  }

  private get supported(): boolean {
    return nativeStoreKind(this.platform) !== null;
  }

  private response(
    configured: ReadonlyMap<CredentialKey, boolean | null>,
    unavailableReason: CredentialsResponse["store"]["unavailableReason"],
  ): CredentialsResponse {
    return {
      ok: true,
      store: {
        kind: "config_and_native_credential_store",
        nativeStore: nativeStoreKind(this.platform),
        maxSecretBytes: nativeCredentialMaxBytes(this.platform),
        available: unavailableReason === null,
        unavailableReason,
        requiresWorkerRestart: KEYCHAIN_REQUIRES_WORKER_RESTART,
      },
      credentials: CredentialKeys.map((key) => ({
        key,
        label: LABELS[key],
        configured: configured.get(key) ?? null,
        storage: isProviderConfigurationKey(key) ? "config" as const : "native_store" as const,
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
    if (configured === true) return "native_store";
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

export { KeychainCredentialStore as NativeCredentialStore };

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

      const mutating = args[0] === "add-generic-password" || args[0] === "delete-generic-password";
      let child: SecurityChildProcess;
      try {
        child = spawnSecurity(mutating ? "/bin/sh" : KEYCHAIN_SECURITY_BINARY, mutating
          ? ["-c", 'guard=$(/bin/dd bs=1 count=1 2>/dev/null); [ "$guard" = 1 ] || exit 1; exec "$@"',
              "jobctrl-credential-helper", KEYCHAIN_SECURITY_BINARY, ...args]
          : args, {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        reject(
          new SecurityCommandRunnerError("Keychain command could not start."),
        );
        return;
      }

      let settled = false;
      let failure: Error | undefined;
      let registrationPending = false;
      let closed = false;
      let exited = false;
      let exitCode: number | null = null;
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
          if (!exited && !closed) child.kill("SIGKILL");
        } catch {
          // The sanitized command failure remains authoritative.
        }
      };

      const failAfterExit = (message: string, cause?: unknown): void => {
        if (settled || failure) return;
        failure = cause instanceof CredentialMutationLockError ? cause : new SecurityCommandRunnerError(message);
        if (timeout) clearTimeout(timeout);
        terminateChild();
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
      const settleAfterClose = (): void => {
        if (!closed || registrationPending) return;
        settle(() => {
          if (failure) reject(failure);
          else resolve({ code: exitCode ?? 1, stderr: stderr.trim(), stdout });
        });
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
        failAfterExit("Keychain command could not start.");
      });
      child.on("exit", () => { exited = true; });
      child.on("close", (code) => {
        closed = true;
        exitCode = code;
        settleAfterClose();
      });

      child.stdin.on("error", () => {
        failAfterExit("Keychain command input failed.");
      });

      timeout = setTimeout(() => {
        failAfterExit("Keychain command timed out.");
      }, timeoutMs);

      const sendInput = (): void => {
        if (settled || failure || closed) return;
        try {
        if (mutating) {
          child.stdin.end(`1${sensitiveInput === undefined ? "" : keychainPromptInput(sensitiveInput)}`, "utf8");
        } else if (sensitiveInput === undefined) {
          child.stdin.end();
        } else {
          child.stdin.end(keychainPromptInput(sensitiveInput), "utf8");
        }
        } catch { failAfterExit("Keychain command input failed."); }
      };
      if (mutating && options.onSpawn) {
        try {
          if (!child.pid) throw new CredentialMutationLockError("unverified");
          registrationPending = true;
          void options.onSpawn(child.pid, () => !closed && !exited).then(
            () => { registrationPending = false; sendInput(); settleAfterClose(); },
            (error: unknown) => { registrationPending = false; failAfterExit("Keychain helper identity is unavailable.", error); settleAfterClose(); },
          );
        } catch (error) {
          registrationPending = false;
          failAfterExit("Keychain helper identity is unavailable.", error);
        }
      } else {
        sendInput();
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
    validCredentialService(args[2]) &&
    args[3] === "-a" &&
    args[5] === "-U" &&
    args.at(-1) === "-w" &&
    parsedInput.success
  );
}

function validCredentialService(value: string | undefined): boolean {
  return value === KEYCHAIN_SERVICE || /^JobCtrl-QA-[0-9a-f-]{36}$/i.test(value ?? "");
}

function keychainPromptInput(sensitiveInput: string): string {
  // Bare `-w` confirms a new value by prompting twice. One bounded write
  // supplies both answers and closes stdin; the value never enters argv.
  return `${sensitiveInput}\n${sensitiveInput}\n`;
}

function parseMacosTypedPassword(stderr: string): string | null {
  const line = stderr.split(/\r?\n/u).find((entry) => entry.startsWith("password: "));
  if (!line) return null;
  const payload = line.slice("password: ".length);
  const hex = /^0x([0-9a-f]+)(?:\s|$)/iu.exec(payload)?.[1];
  if (hex) {
    const bytes = Buffer.from(hex, "hex");
    const decoded = bytes.toString("utf8");
    return Buffer.from(decoded, "utf8").equals(bytes) ? decoded : null;
  }
  if (!payload.startsWith('"') || !payload.endsWith('"')) return null;
  // `security -g` does not escape embedded ASCII quotes. Strip only the
  // unambiguous outer delimiter; binary/backslash-bearing values use 0x form.
  return payload.slice(1, -1);
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
      reject(new SecurityCommandTimeoutError("Keychain command timed out."));
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
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(error instanceof CredentialMutationLockError || error instanceof CredentialMutationUncertainError
          ? error : new SecurityCommandRunnerError("Keychain command failed."));
      },
    );
  });
}
