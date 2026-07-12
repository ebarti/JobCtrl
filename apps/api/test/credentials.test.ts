import { EventEmitter } from "node:events";

import {
  CREDENTIAL_VALUE_MAX_LENGTH,
  CredentialKeys,
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
      return result(0, "", args.includes("-w") ? `${state.get(key) ?? ""}\n` : "");
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
  ["GOOGLE_CLOUD_PROJECT", `${SECRET}-old-project`],
]);

describe("KeychainCredentialStore", () => {
  beforeEach(() => {
    for (const key of CredentialKeys) vi.stubEnv(key, "");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("reports environment ownership separately and rejects ineffective writes without echoing values", async () => {
    const runSecurity = vi.fn<SecurityCommandRunner>(async () => result(44, NOT_FOUND));
    const store = new KeychainCredentialStore({
      platform: "darwin",
      runSecurity,
      env: { CAPSOLVER_API_KEY: SECRET },
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

  it.each(["linux", "win32"] as const)(
    "returns an explicit unsupported capability without spawning security on %s",
    async (platform) => {
      const runSecurity = vi.fn<SecurityCommandRunner>();
      const store = new KeychainCredentialStore({ platform, runSecurity });

      const response = await store.list();

      expect(runSecurity).not.toHaveBeenCalled();
      expect(response.store).toEqual({
        kind: "macos_keychain",
        available: false,
        unavailableReason: "unsupported_platform",
        requiresWorkerRestart: true,
      });
      expect(
        response.credentials.every(
          (credential) => credential.configured === null,
        ),
      ).toBe(true);
      expect(response.credentials.every((credential) => credential.effectiveSource === "inspection_unknown")).toBe(true);
      await expect(store.set("OPENAI_API_KEY", SECRET)).rejects.toMatchObject({
        name: "CredentialStoreUnavailableError",
        reason: "unsupported_platform",
      });
      await expect(store.delete("OPENAI_API_KEY")).rejects.toMatchObject({
        name: "CredentialStoreUnavailableError",
        reason: "unsupported_platform",
      });
      await expect(
        store.applyBatch([
          { operation: "delete", key: "ANTHROPIC_API_KEY" },
        ]),
      ).rejects.toMatchObject({
        name: "CredentialStoreUnavailableError",
        reason: "unsupported_platform",
      });
      expect(runSecurity).not.toHaveBeenCalled();
    },
  );

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
    expect(
      response.credentials.every(
        (credential) => credential.configured === true,
      ),
    ).toBe(true);
    expect(runSecurity).toHaveBeenCalledTimes(CredentialKeys.length);
    for (const [key, call] of CredentialKeys.map(
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
        kind: "macos_keychain",
        available: false,
        unavailableReason: "inspection_failed",
        requiresWorkerRestart: true,
      });
      expect(
        response.credentials.every(
          (credential) => credential.configured === null,
        ),
      ).toBe(true);
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
        key === "OPENAI_API_KEY" ? true : key === "GEMINI_API_KEY" ? false : null,
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
      expect(
        response.credentials.every(
          (credential) => credential.configured === null,
        ),
      ).toBe(true);
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

    expect(runSecurity).toHaveBeenCalledTimes(CredentialKeys.length);
    expect(response.store.unavailableReason).toBe("inspection_failed");
    expect(
      response.credentials.every(
        (credential) => credential.configured === null,
      ),
    ).toBe(true);
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
    const store = new KeychainCredentialStore({ platform: "darwin", runSecurity });

    const response = await store.applyBatch(BATCH_OPERATIONS);

    expect(state.get("ANTHROPIC_API_KEY")).toBe(`${SECRET}-new-anthropic`);
    expect(state.get("AWS_PROFILE")).toBe(`${SECRET}-new-profile`);
    expect(state.has("GEMINI_API_KEY")).toBe(false);
    expect(state.has("GOOGLE_CLOUD_PROJECT")).toBe(false);
    expect(JSON.stringify(response)).not.toContain(SECRET);
    expect(runSecurity.mock.calls.filter(([args]) => args[0] === "find-generic-password" && args.includes("-w"))).toHaveLength(4);
    expect(JSON.stringify(runSecurity.mock.calls.map(([args]) => args))).not.toContain(SECRET);
  });

  it.each([
    ["first set", 0],
    ["second set", 1],
    ["first delete", 2],
    ["second delete", 3],
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
