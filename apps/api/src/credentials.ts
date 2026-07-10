import { spawn } from "node:child_process";

import type { CredentialKey, CredentialsResponse } from "./contracts.js";
import {
  CredentialKeys,
  CredentialUpdateRequestSchema,
} from "./contracts.js";

export const KEYCHAIN_SERVICE = "JobCtrl";
export const KEYCHAIN_SECURITY_BINARY = "/usr/bin/security";
export const KEYCHAIN_ACCOUNT_MAPPING = "key" as const;
export const KEYCHAIN_REQUIRES_WORKER_RESTART = true as const;
/** Hard ceiling for every macOS `security` invocation, mirrored by the Python runtime. */
export const KEYCHAIN_COMMAND_TIMEOUT_MS = 2_000;

const MAX_CAPTURED_OUTPUT_CHARS = 4_096;
const CONFIRMED_NOT_FOUND_MESSAGES = new Set([
  "The specified item could not be found.",
  "The specified item could not be found in the keychain.",
]);

const LABELS: Record<CredentialKey, string> = {
  OPENAI_API_KEY: "OpenAI API key",
  GEMINI_API_KEY: "Gemini API key",
  LLM_URL: "LLM endpoint",
};

export interface CredentialStore {
  list(): Promise<CredentialsResponse>;
  set(key: CredentialKey, value: string): Promise<CredentialsResponse>;
  delete(key: CredentialKey): Promise<CredentialsResponse>;
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
  | "unsupported_platform";

const CREDENTIAL_STORE_MESSAGES: Record<CredentialStoreFailureReason, string> =
  {
    unsupported_platform:
      "macOS Keychain credential editing is unavailable on this platform.",
    operational_failure:
      "macOS Keychain is temporarily unavailable. Unlock Keychain Access and retry.",
  };

export class CredentialStoreUnavailableError extends Error {
  readonly reason: CredentialStoreFailureReason;

  constructor(reason: CredentialStoreFailureReason = "unsupported_platform") {
    super(CREDENTIAL_STORE_MESSAGES[reason]);
    this.name = "CredentialStoreUnavailableError";
    this.reason = reason;
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
}

export class KeychainCredentialStore implements CredentialStore {
  private readonly platform: NodeJS.Platform;
  private readonly runSecurity: SecurityCommandRunner;
  private readonly commandTimeoutMs: number;

  constructor(options: KeychainCredentialStoreOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.runSecurity = options.runSecurity ?? defaultSecurityCommandRunner;
    this.commandTimeoutMs = normalizeTimeout(
      options.commandTimeoutMs ?? KEYCHAIN_COMMAND_TIMEOUT_MS,
    );
  }

  async list(): Promise<CredentialsResponse> {
    if (!this.supported) {
      return this.response(
        CredentialKeys.map(() => null),
        "unsupported_platform",
      );
    }

    const configured = await Promise.all(
      CredentialKeys.map((key) => this.inspect(key)),
    );
    return this.response(
      configured,
      configured.some((value) => value === null) ? "inspection_failed" : null,
    );
  }

  async set(key: CredentialKey, value: string): Promise<CredentialsResponse> {
    this.ensureSupported();
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
    return this.list();
  }

  async delete(key: CredentialKey): Promise<CredentialsResponse> {
    this.ensureSupported();
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
    return this.list();
  }

  private async inspect(key: CredentialKey): Promise<boolean | null> {
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
    configured: ReadonlyArray<boolean | null>,
    unavailableReason: CredentialsResponse["store"]["unavailableReason"],
  ): CredentialsResponse {
    return {
      ok: true,
      store: {
        kind: "macos_keychain",
        available: unavailableReason === null,
        unavailableReason,
        requiresWorkerRestart: KEYCHAIN_REQUIRES_WORKER_RESTART,
      },
      credentials: CredentialKeys.map((key, index) => ({
        key,
        label: LABELS[key],
        configured: configured[index] ?? null,
        storage: "keychain" as const,
      })),
    };
  }

  private ensureSupported(): void {
    if (!this.supported) {
      throw new CredentialStoreUnavailableError("unsupported_platform");
    }
  }
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
            stdout: stdout.trim(),
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
