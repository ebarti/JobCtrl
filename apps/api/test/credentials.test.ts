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
  type KeychainCredentialStoreOptions,
  type SecurityChildProcess,
  type SecurityCommandRunner,
  type SecurityProcessSpawner,
} from "../src/credentials.js";
import type { NativeCredentialCommandRunner } from "../src/native-credential-store.js";

const SECRET = "test-secret-must-not-appear";
const syntheticIdentity = process.platform === "linux"
  ? "linux:00000000-0000-0000-0000-000000000000:1"
  : process.platform === "win32" ? "windows:1:1" : "darwin:1:1";
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

function createTestStore(options: KeychainCredentialStoreOptions = {}): KeychainCredentialStore {
  return new KeychainCredentialStore({
    mutationLockPath: path.join(configDirectory, "credential-mutations.sqlite3"),
    processIdentityReader: async () => ({ state: "alive", identity: syntheticIdentity }),
    ...options,
  });
}

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
    const store = createTestStore({
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
      const store = createTestStore({ platform, runNative, runSecurity });

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
    const store = createTestStore({ platform: "freebsd" });
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
    const store = createTestStore({
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
      const store = createTestStore({
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
      const store = createTestStore({
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
    const store = createTestStore({
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
    const failingStore = createTestStore({
      platform: "darwin",
      runSecurity: failingRunner,
    });
    const malformedStore = createTestStore({
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
    const store = createTestStore({
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
    const store = createTestStore({
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
    const store = createTestStore({
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
    const store = createTestStore({ platform: "darwin", runSecurity });

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
    const store = createTestStore({
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
    const store = createTestStore({
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
    const store = createTestStore({ platform: "darwin", runSecurity });

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
    const store = createTestStore({ platform: "darwin", runSecurity });

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
      const store = createTestStore({ platform: "darwin", runSecurity });

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
    const store = createTestStore({ platform: "darwin", runSecurity });

    const error = await store.applyBatch(BATCH_OPERATIONS).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CredentialStoreUnavailableError);
    expect(error).toMatchObject({ reason: "partial_failure" });
    expect(String(error)).toContain("recovery was incomplete");
    expect(String(error)).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(state.get("ANTHROPIC_API_KEY")).toBe(`${SECRET}-new-anthropic`);
    expect(JSON.stringify(runSecurity.mock.calls.map(([args]) => args))).not.toContain(SECRET);
  });

  it("does not let a failed older batch undo a newer batch from another store", async () => {
    const { runSecurity: underlyingRunner, state } = statefulKeychainRunner(PRE_BATCH_STATE);
    let releaseFailure!: () => void;
    let reportBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => { reportBlocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseFailure = resolve; });
    const runSecurity = vi.fn<SecurityCommandRunner>(async (args, options) => {
      if (args[0] === "delete-generic-password" && args[args.indexOf("-a") + 1] === "GEMINI_API_KEY") {
        reportBlocked();
        await release;
        return result(1, SECRET, SECRET);
      }
      return underlyingRunner(args, options);
    });
    const first = createTestStore({ platform: "darwin", runSecurity, configPath, env: {} });
    const second = createTestStore({ platform: "darwin", runSecurity, configPath, env: {} });

    const older = first.applyBatch([
      { operation: "set", key: "ANTHROPIC_API_KEY", value: `${SECRET}-older` },
      { operation: "delete", key: "GEMINI_API_KEY" },
    ]).catch((error: unknown) => error);
    await blocked;
    const newer = second.applyBatch([
      { operation: "set", key: "ANTHROPIC_API_KEY", value: `${SECRET}-newer` },
    ]);
    await Promise.race([newer, new Promise<void>((resolve) => setTimeout(resolve, 50))]);
    releaseFailure();
    const [olderResult, newerResult] = await Promise.all([older, newer]);

    expect(olderResult).toMatchObject({ reason: "operational_failure" });
    expect(newerResult.credentials.find((entry) => entry.key === "ANTHROPIC_API_KEY")).toMatchObject({
      configured: true,
      effectiveSource: "native_store",
    });
    expect(state.get("ANTHROPIC_API_KEY") === `${SECRET}-newer`).toBe(true);
    expect(state.get("GEMINI_API_KEY") === PRE_BATCH_STATE.get("GEMINI_API_KEY")).toBe(true);
    expect(JSON.stringify(newerResult)).not.toContain(SECRET);
    expect(JSON.stringify(olderResult)).not.toContain(SECRET);
    expect(JSON.stringify(runSecurity.mock.calls.map(([args]) => args))).not.toContain(SECRET);
  });

  it.each(["set", "delete"] as const)("serializes a single-key %s against batch compensation", async (method) => {
    const { runSecurity: underlyingRunner, state } = statefulKeychainRunner(PRE_BATCH_STATE);
    let releaseFailure!: () => void;
    let reportBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => { reportBlocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseFailure = resolve; });
    const runSecurity = vi.fn<SecurityCommandRunner>(async (args, options) => {
      if (args[0] === "delete-generic-password" && args[args.indexOf("-a") + 1] === "GEMINI_API_KEY") {
        reportBlocked();
        await release;
        return result(1, SECRET, SECRET);
      }
      return underlyingRunner(args, options);
    });
    const first = createTestStore({ platform: "darwin", runSecurity, configPath, env: {} });
    const second = createTestStore({ platform: "darwin", runSecurity, configPath, env: {} });
    const older = first.applyBatch([
      { operation: "set", key: "ANTHROPIC_API_KEY", value: `${SECRET}-older` },
      { operation: "delete", key: "GEMINI_API_KEY" },
    ]).catch((error: unknown) => error);
    await blocked;
    const newer = method === "set"
      ? second.set("ANTHROPIC_API_KEY", `${SECRET}-newer`)
      : second.delete("ANTHROPIC_API_KEY");
    await Promise.race([newer, new Promise<void>((resolve) => setTimeout(resolve, 50))]);
    releaseFailure();
    const [olderResult, newerResult] = await Promise.all([older, newer]);
    expect(olderResult).toMatchObject({ reason: "operational_failure" });
    expect(newerResult.credentials.find((entry) => entry.key === "ANTHROPIC_API_KEY")?.configured).toBe(method === "set");
    expect(method === "set"
      ? state.get("ANTHROPIC_API_KEY") === `${SECRET}-newer`
      : !state.has("ANTHROPIC_API_KEY")).toBe(true);
    expect(JSON.stringify(newerResult)).not.toContain(SECRET);
  });

  it("retains ownership after a timed-out mutation until the runner really stops", async () => {
    const { runSecurity: underlyingRunner, state } = statefulKeychainRunner(PRE_BATCH_STATE);
    let releaseMutation!: () => void;
    const release = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const runSecurity = vi.fn<SecurityCommandRunner>(async (args, options) => {
      if (args[0] === "add-generic-password" && options.sensitiveInput === `${SECRET}-older`) {
        await release;
      }
      return underlyingRunner(args, options);
    });
    const olderStore = createTestStore({ platform: "darwin", runSecurity, configPath, env: {}, commandTimeoutMs: 25 });
    const newerStore = createTestStore({ platform: "darwin", runSecurity, configPath, env: {}, mutationLockTimeoutMs: 60 });

    const oldResult = await olderStore.applyBatch([
      { operation: "set", key: "ANTHROPIC_API_KEY", value: `${SECRET}-older` },
    ]).catch((error: unknown) => error);
    expect(oldResult).toMatchObject({ reason: "partial_failure" });
    const environmentOwned = createTestStore({
      platform: "darwin", runSecurity, configPath, env: { ANTHROPIC_API_KEY: SECRET },
      mutationLockTimeoutMs: 60,
    });
    await expect(environmentOwned.set("ANTHROPIC_API_KEY", `${SECRET}-newer`)).rejects.toMatchObject({
      name: "CredentialManagedByEnvironmentError",
    });
    const blockedResult = await newerStore.set("ANTHROPIC_API_KEY", `${SECRET}-newer`).catch((error: unknown) => error);
    expect(blockedResult).toMatchObject({ reason: "busy" });
    expect(state.get("ANTHROPIC_API_KEY") === PRE_BATCH_STATE.get("ANTHROPIC_API_KEY")).toBe(true);
    releaseMutation();
    const successor = await newerStore.set("ANTHROPIC_API_KEY", `${SECRET}-newer`);
    expect(successor.credentials.find((entry) => entry.key === "ANTHROPIC_API_KEY")?.configured).toBe(true);
    expect(state.get("ANTHROPIC_API_KEY") === `${SECRET}-newer`).toBe(true);
    expect(JSON.stringify([oldResult, blockedResult, successor])).not.toContain(SECRET);
    expect(JSON.stringify(runSecurity.mock.calls.map(([args]) => args))).not.toContain(SECRET);
  });

  it.each(["linux", "win32"] as const)("fences a timed-out %s native mutation until it settles", async (platform) => {
    let releaseMutation!: () => void;
    const release = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const state = new Map<CredentialKey, string>();
    const runNative = vi.fn<NativeCredentialCommandRunner>(async (command) => {
      if (command.operation === "set") {
        if (command.value === `${SECRET}-older`) await release;
        state.set(command.key, command.value ?? "");
        return result();
      }
      return state.has(command.key)
        ? result(0, "", command.operation === "read" ? state.get(command.key) : "")
        : result(44);
    });
    const older = createTestStore({ platform, runNative, configPath, env: {}, commandTimeoutMs: 25 });
    const newer = createTestStore({ platform, runNative, configPath, env: {}, mutationLockTimeoutMs: 60 });
    const oldResult = await older.set("ANTHROPIC_API_KEY", `${SECRET}-older`).catch((error: unknown) => error);
    expect(oldResult).toMatchObject({ reason: "partial_failure" });
    const busy = await newer.set("ANTHROPIC_API_KEY", `${SECRET}-newer`).catch((error: unknown) => error);
    expect(busy).toMatchObject({ reason: "busy" });
    releaseMutation();
    const saved = await newer.set("ANTHROPIC_API_KEY", `${SECRET}-newer`);
    expect(saved.credentials.find((entry) => entry.key === "ANTHROPIC_API_KEY")?.configured).toBe(true);
    expect(state.get("ANTHROPIC_API_KEY") === `${SECRET}-newer`).toBe(true);
    expect(JSON.stringify([oldResult, busy, saved])).not.toContain(SECRET);
  });

  it("refuses an unfamiliar coordinator file without touching credentials", async () => {
    const lockPath = path.join(configDirectory, "unfamiliar-lock.sqlite3");
    const contents = "unrelated synthetic file";
    fs.writeFileSync(lockPath, contents);
    const runSecurity = vi.fn<SecurityCommandRunner>();
    const store = createTestStore({ platform: "darwin", runSecurity, env: {}, configPath, mutationLockPath: lockPath });
    const error = await store.set("ANTHROPIC_API_KEY", SECRET).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: "operational_failure" });
    expect(String(error)).not.toContain(SECRET);
    expect(runSecurity).not.toHaveBeenCalled();
    expect(fs.readFileSync(lockPath, "utf8")).toBe(contents);
  });

  it("reports an unverified process identity without touching credentials", async () => {
    const runSecurity = vi.fn<SecurityCommandRunner>();
    const store = createTestStore({
      platform: "darwin", runSecurity, env: {}, configPath,
      processIdentityReader: async () => ({ state: "unverified" }),
    });
    const error = await store.set("ANTHROPIC_API_KEY", SECRET).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: "ownership_unverified" });
    expect(String(error)).not.toContain(SECRET);
    expect(runSecurity).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(configDirectory, "credential-mutations.sqlite3.inflight"))).toBe(false);
  });

  it("withholds helper input when the spawned helper identity is unverified", async () => {
    const stdin = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
    const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const child = Object.assign(new EventEmitter(), {
      pid: 42, stdin, stdout, stderr,
      kill: vi.fn(() => { queueMicrotask(() => child.emit("close", 1)); return true; }),
    });
    const runSecurity = createSecurityCommandRunner(() => child as SecurityChildProcess);
    const store = createTestStore({
      platform: "darwin", runSecurity, env: {}, configPath,
      processIdentityReader: async (pid) => pid === process.pid
        ? { state: "alive", identity: syntheticIdentity }
        : { state: "unverified" },
    });
    const error = await store.set("ANTHROPIC_API_KEY", SECRET).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: "ownership_unverified" });
    expect(stdin.end).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(fs.existsSync(path.join(configDirectory, "credential-mutations.sqlite3.inflight"))).toBe(false);
    expect(String(error)).not.toContain(SECRET);
  });

  it("does not record or signal a helper that exits during identity registration", async () => {
    const stdin = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
    const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const child = Object.assign(new EventEmitter(), { pid: 42, stdin, stdout, stderr, kill: vi.fn(() => true) });
    let reportInspection!: () => void;
    let finishInspection!: () => void;
    const inspecting = new Promise<void>((resolve) => { reportInspection = resolve; });
    const release = new Promise<void>((resolve) => { finishInspection = resolve; });
    const store = createTestStore({
      platform: "darwin", runSecurity: createSecurityCommandRunner(() => child as SecurityChildProcess), env: {}, configPath,
      processIdentityReader: async (pid) => {
        if (pid !== process.pid) { reportInspection(); await release; }
        return { state: "alive", identity: syntheticIdentity };
      },
    });
    const update = store.set("ANTHROPIC_API_KEY", SECRET).catch((caught: unknown) => caught);
    await inspecting;
    child.emit("exit", 1);
    child.emit("close", 1);
    finishInspection();
    const error = await update;
    expect(error).toMatchObject({ reason: "ownership_unverified" });
    expect(stdin.end).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(configDirectory, "credential-mutations.sqlite3.inflight"))).toBe(false);
  });

  it("clears an unstarted helper marker after a synchronous runner failure", async () => {
    let fail = true;
    const runSecurity = vi.fn<SecurityCommandRunner>((args) => {
      if (args[0] === "add-generic-password" && fail) {
        fail = false;
        throw new Error(SECRET);
      }
      return Promise.resolve(result());
    });
    const store = createTestStore({ platform: "darwin", runSecurity, env: {}, configPath });
    const failed = await store.set("ANTHROPIC_API_KEY", SECRET).catch((error: unknown) => error);
    expect(failed).toMatchObject({ reason: "operational_failure" });
    expect(String(failed)).not.toContain(SECRET);
    expect(fs.existsSync(path.join(configDirectory, "credential-mutations.sqlite3.inflight"))).toBe(false);
    await expect(store.set("ANTHROPIC_API_KEY", SECRET)).resolves.toMatchObject({ ok: true });
  });

  it("retains a recorded helper fence when a runner throws after registration", async () => {
    const runSecurity = vi.fn<SecurityCommandRunner>((args, options) => {
      if (args[0] === "add-generic-password") {
        options.onSpawn?.(process.pid);
        throw new Error(SECRET);
      }
      return Promise.resolve(result(44));
    });
    const store = createTestStore({ platform: "darwin", runSecurity, env: {}, configPath });
    const failed = await store.applyBatch([
      { operation: "set", key: "ANTHROPIC_API_KEY", value: SECRET },
    ]).catch((error: unknown) => error);
    expect(failed).toMatchObject({ reason: "partial_failure" });
    expect(runSecurity.mock.calls.filter(([args]) => args[0] !== "find-generic-password")).toHaveLength(1);
    const next = createTestStore({ platform: "darwin", runSecurity, env: {}, configPath, mutationLockTimeoutMs: 60 });
    const busy = await next.set("ANTHROPIC_API_KEY", SECRET).catch((error: unknown) => error);
    expect(busy).toMatchObject({ reason: "busy" });
    expect(JSON.stringify([failed, busy])).not.toContain(SECRET);
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
    const spawnSecurity = vi.fn<SecurityProcessSpawner>(() => child);
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
    expect(settlements).toBe(0);
    childEmitter.emit("close", 0);
    await vi.runAllTimersAsync();

    const error = await command.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "Keychain command timed out." });
    expect(String(error)).not.toContain(SECRET);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(stdin.end).toHaveBeenCalledExactlyOnceWith(
      `1${SECRET}\n${SECRET}\n`,
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
    const spawnSecurity = vi.fn<SecurityProcessSpawner>(() => child);
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
    const [binary, forwardedArgs] = spawnSecurity.mock.calls[0] ?? [];
    expect(binary).toBe("/bin/sh");
    expect(JSON.stringify(forwardedArgs?.slice(-args.length)) === JSON.stringify(args)).toBe(true);
    expect(JSON.stringify(forwardedArgs).includes(SECRET)).toBe(false);
    expect(args).not.toContain(SECRET);
    expect(args.at(-1)).toBe("-w");
    expect(stdin.end).toHaveBeenCalledExactlyOnceWith(
      `1${SECRET}\n${SECRET}\n`,
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
    childEmitter.emit("close", 1);

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
