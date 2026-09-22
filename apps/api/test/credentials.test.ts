import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CREDENTIAL_VALUE_MAX_LENGTH,
  CredentialKeys,
  ProviderConfigurationKeys,
  SecretCredentialKeys,
  type CredentialBatchOperation,
  type CredentialKey,
} from "@jobctrl/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CredentialStoreUnavailableError,
  createSecurityCommandRunner,
  KeychainCredentialStore,
  type SecurityChildProcess,
  type SecurityCommandRunner,
} from "../src/credentials.js";
import type { NativeCredentialCommandRunner } from "../src/native-credential-store.js";

const SECRET = "test-secret-must-not-appear";
const NOT_FOUND = "The specified item could not be found.";

function result(
  code = 0,
  stderr = "",
  stdout = "",
): {
  code: number;
  stderr: string;
  stdout: string;
} {
  return { code, stderr, stdout };
}

function statefulKeychainRunner(
  initial: ReadonlyMap<CredentialKey, string>,
  failedMutationAttempts: ReadonlySet<number> = new Set(),
) {
  const state = new Map(initial);
  let mutationAttempt = 0;
  const runSecurity = vi.fn<SecurityCommandRunner>(async (args, options) => {
    const accountIndex = args.indexOf("-a") + 1;
    const key = args[accountIndex] as CredentialKey;
    if (args[0] === "find-generic-password") {
      if (!state.has(key)) return result(44, NOT_FOUND);
      return args.includes("-g")
        ? result(0, `password: ${JSON.stringify(state.get(key) ?? "")}`)
        : result();
    }

    const currentAttempt = mutationAttempt;
    mutationAttempt += 1;
    if (failedMutationAttempts.has(currentAttempt)) {
      return result(1, SECRET, SECRET);
    }
    if (args[0] === "add-generic-password") {
      state.set(key, options.sensitiveInput ?? "");
    } else {
      state.delete(key);
    }
    return result();
  });
  return { runSecurity, state };
}

const BATCH_OPERATIONS = [
  { operation: "set", key: "ANTHROPIC_API_KEY", value: `${SECRET}-new-anthropic` },
  { operation: "set", key: "AWS_PROFILE", value: `${SECRET}-new-profile` },
  { operation: "delete", key: "GEMINI_API_KEY" },
  { operation: "delete", key: "GOOGLE_CLOUD_PROJECT" },
] as const satisfies readonly CredentialBatchOperation[];

const PRE_BATCH_STATE = new Map<CredentialKey, string>([
  ["ANTHROPIC_API_KEY", `  ${SECRET}-old-anthropic  `],
  ["GEMINI_API_KEY", `${SECRET}-old-gemini`],
]);

let configDirectory = "";
let configPath = "";

describe("KeychainCredentialStore", () => {
  beforeEach(() => {
    configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-credentials-"));
    configPath = path.join(configDirectory, "config.json");
    vi.stubEnv("JOBCTRL_CONFIG_PATH", configPath);
    for (const key of CredentialKeys) vi.stubEnv(key, "");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(configDirectory, { force: true, recursive: true });
  });

  it("reports environment ownership separately and rejects ineffective writes without echoing values", async () => {
    const runSecurity = vi.fn<SecurityCommandRunner>(async () => result(44, NOT_FOUND));
    const store = new KeychainCredentialStore({
      platform: "darwin",
      runSecurity,
      env: { CAPSOLVER_API_KEY: SECRET, JOBCTRL_CONFIG_PATH: configPath },
    });

    const response = await store.list();
    const capSolver = response.credentials.find((entry) => entry.key === "CAPSOLVER_API_KEY");
    const googleAdc = response.credentials.find((entry) => entry.key === "GOOGLE_APPLICATION_CREDENTIALS");

    expect(capSolver).toMatchObject({ configured: false, effectiveSource: "environment", editable: false });
    expect(googleAdc).toMatchObject({ configured: false, effectiveSource: "absent", editable: true });
    await expect(store.set("CAPSOLVER_API_KEY", `${SECRET}-replacement`)).rejects.toMatchObject({
      name: "CredentialManagedByEnvironmentError",
      key: "CAPSOLVER_API_KEY",
    });
    await expect(store.delete("CAPSOLVER_API_KEY")).rejects.toMatchObject({
      name: "CredentialManagedByEnvironmentError",
    });
    await expect(store.applyBatch([{ operation: "delete", key: "CAPSOLVER_API_KEY" }])).rejects.toMatchObject({
      name: "CredentialManagedByEnvironmentError",
    });
    expect(JSON.stringify(response)).not.toContain(SECRET);
  });

  it.each([
    ["linux", "linux_secret_service"],
    ["win32", "windows_credential_manager"],
  ] as const)(
    "supports presence-only native credential operations and config-backed settings on %s",
    async (platform, nativeStore) => {
      const runSecurity = vi.fn<SecurityCommandRunner>();
      const values = new Map<CredentialKey, string>();
      const runNative = vi.fn<NativeCredentialCommandRunner>(async (command) => {
        if (command.operation === "set") {
          values.set(command.key, command.value ?? "");
          return result();
        }
        if (command.operation === "delete") {
          const existed = values.delete(command.key);
          return existed ? result() : result(44);
        }
        if (!values.has(command.key)) return result(44);
        return result(0, "", command.operation === "read" ? values.get(command.key) : "");
      });
      const store = new KeychainCredentialStore({ platform, runNative, runSecurity });

      const response = await store.list();

      expect(runSecurity).not.toHaveBeenCalled();
      expect(response.store).toEqual({
        kind: "config_and_native_credential_store",
        nativeStore,
        maxSecretBytes: platform === "linux" ? 8_191 : 2_560,
        available: true,
        unavailableReason: null,
        requiresWorkerRestart: true,
      });
      expect(response.credentials.filter((credential) => credential.storage === "config")).toEqual(
        ProviderConfigurationKeys.map((key) => expect.objectContaining({
          key,
          configured: false,
          effectiveSource: "absent",
          editable: true,
        })),
      );
      expect(response.credentials.filter((credential) => credential.storage === "native_store")).toEqual(
        SecretCredentialKeys.map((key) => expect.objectContaining({
          key,
          configured: false,
          effectiveSource: "absent",
          editable: true,
        })),
      );

      const updated = await store.applyBatch([
        { operation: "set", key: "GOOGLE_GENAI_USE_VERTEXAI", value: "true" },
        { operation: "set", key: "GOOGLE_CLOUD_PROJECT", value: "jobctrl-test-project" },
        { operation: "set", key: "GOOGLE_CLOUD_LOCATION", value: "europe-west1" },
      ]);

      expect(updated.credentials.find((credential) => credential.key === "GOOGLE_CLOUD_PROJECT")).toMatchObject({
        configured: true,
        storage: "config",
        effectiveSource: "config",
        editable: true,
      });
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toMatchObject({
        provider_connections: {
          google: {
            mode: "vertex",
            project_id: "jobctrl-test-project",
            location: "europe-west1",
          },
        },
      });
      const exact = `  ${SECRET}-héllø  `;
      await store.set("OPENAI_API_KEY", exact);
      expect(await store.readForInternalUse("OPENAI_API_KEY")).toBe(exact);
      expect((await store.list()).credentials.find((entry) => entry.key === "OPENAI_API_KEY")).toMatchObject({
        configured: true,
        effectiveSource: "native_store",
        editable: true,
      });
      await store.delete("OPENAI_API_KEY");
      await store.delete("OPENAI_API_KEY");
      expect(await store.readForInternalUse("OPENAI_API_KEY")).toBeNull();
      expect(runSecurity).not.toHaveBeenCalled();
    },
  );

  it("keeps unsupported platforms fail-closed while config settings remain editable", async () => {
    const store = new KeychainCredentialStore({ platform: "freebsd" });
    const response = await store.list();
    expect(response.store).toMatchObject({
      nativeStore: null,
      maxSecretBytes: null,
      available: false,
      unavailableReason: "unsupported_platform",
    });
    await expect(store.set("OPENAI_API_KEY", SECRET)).rejects.toMatchObject({
      reason: "unsupported_platform",
    });
  });

  it("reports every present Keychain item without requesting its value", async () => {
    const runSecurity = vi.fn<SecurityCommandRunner>(async () => result());
    const store = new KeychainCredentialStore({
      platform: "darwin",
      runSecurity,
    });

    const response = await store.list();

    expect(response.store).toMatchObject({
      available: true,
      unavailableReason: null,
    });
    expect(response.credentials.filter((credential) => credential.storage === "native_store").every(
      (credential) => credential.configured === true,
    )).toBe(true);
    expect(response.credentials.filter((credential) => credential.storage === "config").every(
      (credential) => credential.configured === false,
    )).toBe(true);
    expect(runSecurity).toHaveBeenCalledTimes(SecretCredentialKeys.length);
    for (const [key, call] of SecretCredentialKeys.map(
      (key, index) => [key, runSecurity.mock.calls[index]] as const,
    )) {
      expect(call?.[0]).toEqual([
        "find-generic-password",
        "-s",
        "JobCtrl",
        "-a",
        key,
      ]);
      expect(call?.[1]).not.toHaveProperty("sensitiveInput");
    }
  });

  it.each([
    [44, "anything is ignored for the documented exit"],
    [1, "The specified item could not be found."],
    [
      1,
      "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
    ],
  ])(
    "treats only a confirmed miss as absent (exit %s)",
    async (code, stderr) => {
      const runSecurity = vi.fn<SecurityCommandRunner>(async () =>
        result(code, stderr),
      );
      const store = new KeychainCredentialStore({
        platform: "darwin",
        runSecurity,
      });

      const response = await store.list();

      expect(response.store).toMatchObject({
        available: true,
        unavailableReason: null,
      });
      expect(
        response.credentials.every(
          (credential) => credential.configured === false,
        ),
      ).toBe(true);
    },
  );

  it.each([
    [1, "User interaction is not allowed."],
    [36, "The user name or passphrase you entered is not correct."],
    [
      1,
      "prefix could not be found but this is not the confirmed Keychain message",
    ],
  ])(
    "keeps unexpected or locked-Keychain failures unknown (exit %s)",
    async (code, stderr) => {
      const runSecurity = vi.fn<SecurityCommandRunner>(async () =>
        result(code, stderr, SECRET),
      );
      const store = new KeychainCredentialStore({
        platform: "darwin",
        runSecurity,
      });

      const response = await store.list();

      expect(response.store).toEqual({
        kind: "config_and_native_credential_store",
        nativeStore: "macos_keychain" as const,
        maxSecretBytes: 128,
        available: false,
        unavailableReason: "inspection_failed",
        requiresWorkerRestart: true,
      });
      expect(response.credentials.filter((credential) => credential.storage === "native_store").every(
        (credential) => credential.configured === null && credential.editable === false,
      )).toBe(true);
      expect(response.credentials.filter((credential) => credential.storage === "config").every(
        (credential) => credential.configured === false && credential.editable,
      )).toBe(true);
      expect(JSON.stringify(response)).not.toContain(SECRET);
      expect(JSON.stringify(response)).not.toContain(stderr);
    },
  );

  it("preserves known per-key presence while one Keychain inspection is unavailable", async () => {
    const runSecurity = vi.fn<SecurityCommandRunner>(async (args) => {
      const account = args.at(-1);
      if (account === "OPENAI_API_KEY") return result();
      if (account === "GEMINI_API_KEY") return result(44);
      return result(1, "User interaction is not allowed.");
    });
    const store = new KeychainCredentialStore({
      platform: "darwin",
      runSecurity,
    });

    const response = await store.list();

    expect(response.store).toMatchObject({
      available: false,
      unavailableReason: "inspection_failed",
    });
    expect(response.credentials.map(({ key, configured }) => [key, configured])).toEqual(
      CredentialKeys.map((key) => [
        key,
        key === "OPENAI_API_KEY"
          ? true
          : key === "GEMINI_API_KEY"
            ? false
            : SecretCredentialKeys.some((secretKey) => secretKey === key)
              ? null
              : false,
      ]),
    );
  });

  it("keeps spawn failures and malformed runner results unknown without leaking errors", async () => {
    const failingRunner = vi.fn<SecurityCommandRunner>(async () => {
      throw new Error(`spawn failed: ${SECRET}`);
    });
    const failingStore = new KeychainCredentialStore({
      platform: "darwin",
      runSecurity: failingRunner,
    });
    const malformedStore = new KeychainCredentialStore({
      platform: "darwin",
      runSecurity: vi.fn(async () => ({
        code: Number.NaN,
        stderr: SECRET,
        stdout: SECRET,
      })),
    });

    const [failed, malformed] = await Promise.all([
      failingStore.list(),
      malformedStore.list(),
    ]);

    for (const response of [failed, malformed]) {
      expect(response.store.unavailableReason).toBe("inspection_failed");
      expect(response.credentials.filter((credential) => credential.storage === "native_store").every(
        (credential) => credential.configured === null,
      )).toBe(true);
      expect(response.credentials.filter((credential) => credential.storage === "config").every(
        (credential) => credential.configured === false,
      )).toBe(true);
      expect(JSON.stringify(response)).not.toContain(SECRET);
    }
  });

  it("bounds an injected runner that never resolves at the store layer", async () => {
    vi.useFakeTimers();
    const runSecurity = vi.fn<SecurityCommandRunner>(
      () => new Promise(() => undefined),
    );
    const store = new KeychainCredentialStore({
      platform: "darwin",
      runSecurity,
      commandTimeoutMs: 25,
    });

    const pending = store.list();
    await vi.advanceTimersByTimeAsync(25);
    const response = await pending;

    expect(runSecurity).toHaveBeenCalledTimes(SecretCredentialKeys.length);
    expect(response.store.unavailableReason).toBe("inspection_failed");
    expect(response.credentials.filter((credential) => credential.storage === "native_store").every(
      (credential) => credential.configured === null,
    )).toBe(true);
    expect(response.credentials.filter((credential) => credential.storage === "config").every(
      (credential) => credential.configured === false,
    )).toBe(true);
  });

  it("clears every store-layer deadline when an injected runner rejects early", async () => {
    vi.useFakeTimers();
    const runSecurity = vi.fn<SecurityCommandRunner>(async () => {
      throw new Error("synthetic spawn failure");
    });
    const store = new KeychainCredentialStore({
      platform: "darwin",
      runSecurity,
      commandTimeoutMs: 2_000,
    });

    const response = await store.list();

    expect(response.store.unavailableReason).toBe("inspection_failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stores on macOS without returning the secret and reports restart activation", async () => {
    const runSecurity = vi.fn<SecurityCommandRunner>(async (args) =>
      result(args[0] === "find-generic-password" ? 0 : 0),
    );
    const store = new KeychainCredentialStore({
      platform: "darwin",
      runSecurity,
    });

    const response = await store.set("OPENAI_API_KEY", SECRET);

    expect(runSecurity).toHaveBeenCalledWith(
      [
        "add-generic-password",
        "-s",
        "JobCtrl",
        "-a",
        "OPENAI_API_KEY",
        "-U",
        "-w",
      ],
      expect.objectContaining({
        sensitiveInput: SECRET,
        timeoutMs: 2_000,
      }),
    );
    const [args] = runSecurity.mock.calls[0] ?? [];
    expect(args).not.toContain(SECRET);
    expect(args?.at(-1)).toBe("-w");
    expect(response.store.available).toBe(true);
    expect(response.store.requiresWorkerRestart).toBe(true);
    expect(JSON.stringify(response)).not.toContain(SECRET);
  });

  it.each([
    ["snowman-☃", `password: 0x${Buffer.from("snowman-☃", "utf8").toString("hex")} "ignored display"`],
    ["deadbeef", 'password: "deadbeef"'],
    ['quote-"', 'password: "quote-""'],
    ['slash-\\', `password: 0x${Buffer.from("slash-\\", "utf8").toString("hex")} "ignored display"`],
  ])("decodes typed macOS private reads without confusing literal hexadecimal (%s)", async (expected, stderr) => {
    const runSecurity = vi.fn<SecurityCommandRunner>(async (args) =>
      args.includes("-g") ? result(0, stderr) : result(),
    );
    const store = new KeychainCredentialStore({ platform: "darwin", runSecurity });

    await expect(store.readForInternalUse("ANTHROPIC_API_KEY")).resolves.toBe(expected);
    expect(runSecurity).toHaveBeenCalledWith(
      ["find-generic-password", "-s", "JobCtrl", "-a", "ANTHROPIC_API_KEY", "-g"],
      expect.objectContaining({ timeoutMs: 2_000 }),
    );
  });

  it("makes deletion idempotent only for a confirmed absent item", async () => {
    const runSecurity = vi.fn<SecurityCommandRunner>(async (args) =>
      args[0] === "delete-generic-password"
        ? result(44, "untrusted output")
        : result(44, "The specified item could not be found."),
    );
    const store = new KeychainCredentialStore({
      platform: "darwin",
      runSecurity,
    });

    const response = await store.delete("OPENAI_API_KEY");

    expect(
      response.credentials.every(
        (credential) => credential.configured === false,
      ),
    ).toBe(true);
    expect(runSecurity).toHaveBeenCalledWith(
      ["delete-generic-password", "-s", "JobCtrl", "-a", "OPENAI_API_KEY"],
      expect.objectContaining({ timeoutMs: 2_000 }),
    );
    expect(runSecurity.mock.calls[0]?.[1]).not.toHaveProperty("sensitiveInput");
  });

  it("surfaces mutation failures as a stable sanitized operational error", async () => {
    const runSecurity = vi.fn<SecurityCommandRunner>(async () =>
      result(1, SECRET, SECRET),
    );
    const store = new KeychainCredentialStore({
      platform: "darwin",
      runSecurity,
    });

    for (const mutation of [
      store.set("OPENAI_API_KEY", SECRET),
      store.delete("OPENAI_API_KEY"),
    ]) {
      const error = await mutation.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CredentialStoreUnavailableError);
      expect(error).toMatchObject({ reason: "operational_failure" });
      expect(String(error)).not.toContain(SECRET);
      expect(JSON.stringify(error)).not.toContain(SECRET);
    }
  });

  it("applies a mixed batch without returning captured or submitted values", async () => {
    const { runSecurity, state } = statefulKeychainRunner(PRE_BATCH_STATE);
    fs.writeFileSync(configPath, JSON.stringify({
      provider_connections: {
        google: { mode: "vertex", project_id: `${SECRET}-old-project` },
      },
    }));
    const store = new KeychainCredentialStore({ platform: "darwin", runSecurity });

    const response = await store.applyBatch(BATCH_OPERATIONS);

    expect(state.get("ANTHROPIC_API_KEY")).toBe(`${SECRET}-new-anthropic`);
    expect(state.has("GEMINI_API_KEY")).toBe(false);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toMatchObject({
      provider_connections: {
        claude: { aws_profile: `${SECRET}-new-profile` },
        google: { mode: "vertex" },
      },
    });
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).provider_connections.google).not.toHaveProperty(
      "project_id",
    );
    expect(JSON.stringify(response)).not.toContain(SECRET);
    expect(runSecurity.mock.calls.filter(([args]) => args[0] === "find-generic-password" && args.includes("-g"))).toHaveLength(2);
    expect(JSON.stringify(runSecurity.mock.calls.map(([args]) => args))).not.toContain(SECRET);
  });

  it("refuses a batch before mutation when an existing snapshot cannot be restored safely", async () => {
    const externalValue = "x".repeat(129);
    const { runSecurity, state } = statefulKeychainRunner(new Map([
      ["ANTHROPIC_API_KEY", externalValue],
    ]));
    const store = new KeychainCredentialStore({ platform: "darwin", runSecurity });

    const error = await store.applyBatch([
      { operation: "delete", key: "ANTHROPIC_API_KEY" },
    ]).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CredentialValueUnsupportedError",
      key: "ANTHROPIC_API_KEY",
      maxBytes: 128,
    });
    expect(state.get("ANTHROPIC_API_KEY")).toBe(externalValue);
    expect(runSecurity.mock.calls.map(([args]) => args[0])).toEqual(["find-generic-password"]);
  });

  it.each([
    ["first set", 0],
    ["delete", 1],
  ] as const)(
    "restores the exact pre-batch state when the %s operation boundary fails",
    async (_label, failedMutationAttempt) => {
      const { runSecurity, state } = statefulKeychainRunner(
        PRE_BATCH_STATE,
        new Set([failedMutationAttempt]),
      );
      const store = new KeychainCredentialStore({ platform: "darwin", runSecurity });

      const error = await store.applyBatch(BATCH_OPERATIONS).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CredentialStoreUnavailableError);
      expect(error).toMatchObject({ reason: "operational_failure" });
      expect(state.size).toBe(PRE_BATCH_STATE.size);
      for (const [key, value] of PRE_BATCH_STATE) {
        expect(state.get(key)).toBe(value);
      }
      expect(String(error)).not.toContain(SECRET);
      expect(JSON.stringify(error)).not.toContain(SECRET);
      expect(JSON.stringify(runSecurity.mock.calls.map(([args]) => args))).not.toContain(SECRET);
    },
  );

  it("surfaces a sanitized partial-failure state when compensating recovery fails", async () => {
    const { runSecurity, state } = statefulKeychainRunner(
      PRE_BATCH_STATE,
      new Set([1, 2]),
    );
    const store = new KeychainCredentialStore({ platform: "darwin", runSecurity });

    const error = await store.applyBatch(BATCH_OPERATIONS).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CredentialStoreUnavailableError);
    expect(error).toMatchObject({ reason: "partial_failure" });
    expect(String(error)).toContain("recovery was incomplete");
    expect(String(error)).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(state.get("ANTHROPIC_API_KEY")).toBe(`${SECRET}-new-anthropic`);
    expect(JSON.stringify(runSecurity.mock.calls.map(([args]) => args))).not.toContain(SECRET);
  });
});

describe("default security command runner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills a timed-out child and settles exactly once even if close follows", async () => {
    vi.useFakeTimers();
    const stdin = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: vi.fn(),
    });
    const stdout = Object.assign(new EventEmitter(), {
      setEncoding: vi.fn(),
    });
    const stderr = Object.assign(new EventEmitter(), {
      setEncoding: vi.fn(),
    });
    const childEmitter = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill: vi.fn(() => true),
    });
    const child = childEmitter as SecurityChildProcess;
    const spawnSecurity = vi.fn(() => child);
    const runner = createSecurityCommandRunner(spawnSecurity);
    let settlements = 0;

    const command = runner(
      [
        "add-generic-password",
        "-s",
        "JobCtrl",
        "-a",
        "OPENAI_API_KEY",
        "-U",
        "-w",
      ],
      { sensitiveInput: SECRET, timeoutMs: 2_000 },
    );
    void command.then(
      () => {
        settlements += 1;
      },
      () => {
        settlements += 1;
      },
    );
    await vi.advanceTimersByTimeAsync(2_000);
    childEmitter.emit("close", 0);
    await vi.runAllTimersAsync();

    const error = await command.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "Keychain command timed out." });
    expect(String(error)).not.toContain(SECRET);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(stdin.end).toHaveBeenCalledExactlyOnceWith(
      `${SECRET}\n${SECRET}\n`,
      "utf8",
    );
    expect(stdin.destroy).toHaveBeenCalledTimes(1);
    expect(settlements).toBe(1);
  });

  it("keeps a distinctive secret out of argv and writes it to stdin exactly once", async () => {
    const stdin = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: vi.fn(),
    });
    const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const childEmitter = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill: vi.fn(() => true),
    });
    const child = childEmitter as SecurityChildProcess;
    const spawnSecurity = vi.fn(() => child);
    const runner = createSecurityCommandRunner(spawnSecurity);
    const args = [
      "add-generic-password",
      "-s",
      "JobCtrl",
      "-a",
      "OPENAI_API_KEY",
      "-U",
      "-w",
    ];

    const command = runner(args, {
      sensitiveInput: SECRET,
      timeoutMs: 2_000,
    });
    childEmitter.emit("close", 0);

    await expect(command).resolves.toEqual(result());
    expect(spawnSecurity).toHaveBeenCalledWith("/usr/bin/security", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(args).not.toContain(SECRET);
    expect(args.at(-1)).toBe("-w");
    expect(stdin.end).toHaveBeenCalledExactlyOnceWith(
      `${SECRET}\n${SECRET}\n`,
      "utf8",
    );
    expect(stdin.destroy).not.toHaveBeenCalled();
  });

  it("preserves private snapshot stdout exactly instead of trimming credential spaces", async () => {
    const stdin = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: vi.fn(),
    });
    const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const childEmitter = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill: vi.fn(() => true),
    });
    const runner = createSecurityCommandRunner(
      () => childEmitter as SecurityChildProcess,
    );
    const args = [
      "find-generic-password",
      "-s",
      "JobCtrl",
      "-a",
      "ANTHROPIC_API_KEY",
      "-w",
    ];

    const command = runner(args, { timeoutMs: 2_000 });
    stdout.emit("data", `  ${SECRET}  \n`);
    childEmitter.emit("close", 0);

    await expect(command).resolves.toEqual(
      result(0, "", `  ${SECRET}  \n`),
    );
    expect(stdin.end).toHaveBeenCalledTimes(1);
    expect(stdin.end.mock.calls[0]).toEqual([]);
    expect(args).not.toContain(SECRET);
  });

  it("rejects empty, unbounded, control-character, misplaced, and non-write sensitive input before spawn", async () => {
    const spawnSecurity = vi.fn();
    const runner = createSecurityCommandRunner(spawnSecurity);
    const safeArgs = [
      "add-generic-password",
      "-s",
      "JobCtrl",
      "-a",
      "OPENAI_API_KEY",
      "-U",
      "-w",
    ];
    const invalidInvocations = [
      [safeArgs, ""],
      [
        safeArgs,
        `${SECRET}${"x".repeat(
          CREDENTIAL_VALUE_MAX_LENGTH + 1 - SECRET.length,
        )}`,
      ],
      [safeArgs, `first-line\r${SECRET}`],
      [safeArgs, `first-line\n${SECRET}`],
      [safeArgs, `first-value\0${SECRET}`],
      [
        [
          "add-generic-password",
          "-s",
          "JobCtrl",
          "-a",
          "OPENAI_API_KEY",
          "-w",
          SECRET,
          "-U",
        ],
        SECRET,
      ],
      [
        ["find-generic-password", "-s", "JobCtrl", "-a", "OPENAI_API_KEY"],
        SECRET,
      ],
      [
        ["delete-generic-password", "-s", "JobCtrl", "-a", "OPENAI_API_KEY"],
        SECRET,
      ],
    ] as const;

    for (const [args, sensitiveInput] of invalidInvocations) {
      const error = await runner([...args], {
        sensitiveInput,
        timeoutMs: 2_000,
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        message: "Keychain command input is invalid.",
      });
      expect(String(error)).not.toContain(SECRET);
    }
    expect(spawnSecurity).not.toHaveBeenCalled();
  });

  it("sanitizes synchronous and asynchronous stdin failures without double settlement", async () => {
    const makeChild = () => {
      const stdin = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
        end: vi.fn(),
      });
      const stdout = Object.assign(new EventEmitter(), {
        setEncoding: vi.fn(),
      });
      const stderr = Object.assign(new EventEmitter(), {
        setEncoding: vi.fn(),
      });
      const childEmitter = Object.assign(new EventEmitter(), {
        stdin,
        stdout,
        stderr,
        kill: vi.fn(() => true),
      });
      return { childEmitter, stdin };
    };
    const sync = makeChild();
    sync.stdin.end.mockImplementation(() => {
      throw new Error(`sync stdin failure ${SECRET}`);
    });
    const asyncChild = makeChild();
    const syncRunner = createSecurityCommandRunner(
      () => sync.childEmitter as SecurityChildProcess,
    );
    const asyncRunner = createSecurityCommandRunner(
      () => asyncChild.childEmitter as SecurityChildProcess,
    );
    let syncSettlements = 0;
    let asyncSettlements = 0;

    const args = [
      "add-generic-password",
      "-s",
      "JobCtrl",
      "-a",
      "OPENAI_API_KEY",
      "-U",
      "-w",
    ];
    const syncCommand = syncRunner(args, {
      sensitiveInput: SECRET,
      timeoutMs: 2_000,
    });
    void syncCommand.then(
      () => {
        syncSettlements += 1;
      },
      () => {
        syncSettlements += 1;
      },
    );
    const syncFailure = syncCommand.catch((caught: unknown) => caught);
    const asyncCommand = asyncRunner(args, {
      sensitiveInput: SECRET,
      timeoutMs: 2_000,
    });
    void asyncCommand.then(
      () => {
        asyncSettlements += 1;
      },
      () => {
        asyncSettlements += 1;
      },
    );
    const asyncFailure = asyncCommand.catch((caught: unknown) => caught);
    asyncChild.stdin.emit("error", new Error(`async stdin failure ${SECRET}`));
    sync.childEmitter.emit("close", 0);
    asyncChild.childEmitter.emit("close", 0);

    for (const failure of [syncFailure, asyncFailure]) {
      const error = await failure;
      expect(error).toMatchObject({
        message: "Keychain command input failed.",
      });
      expect(String(error)).not.toContain(SECRET);
    }
    expect(sync.childEmitter.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(asyncChild.childEmitter.kill).toHaveBeenCalledExactlyOnceWith(
      "SIGKILL",
    );
    expect(sync.stdin.destroy).toHaveBeenCalledTimes(1);
    expect(asyncChild.stdin.destroy).toHaveBeenCalledTimes(1);
    expect(syncSettlements).toBe(1);
    expect(asyncSettlements).toBe(1);
  });

  it("sanitizes synchronous and asynchronous spawn errors", async () => {
    const syncRunner = createSecurityCommandRunner(() => {
      throw new Error(`sync ${SECRET}`);
    });
    const stdin = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: vi.fn(),
    });
    const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const childEmitter = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill: vi.fn(() => true),
    });
    const child = childEmitter as SecurityChildProcess;
    const asyncRunner = createSecurityCommandRunner(() => child);
    const asyncFailure = asyncRunner(["find-generic-password"], {
      timeoutMs: 2_000,
    }).catch((caught: unknown) => caught);
    childEmitter.emit("error", new Error(`async ${SECRET}`));

    for (const failure of [
      syncRunner(["find-generic-password"], { timeoutMs: 2_000 }).catch(
        (caught: unknown) => caught,
      ),
      asyncFailure,
    ]) {
      const error = await failure;
      expect(error).toMatchObject({
        message: "Keychain command could not start.",
      });
      expect(String(error)).not.toContain(SECRET);
    }
  });
});
