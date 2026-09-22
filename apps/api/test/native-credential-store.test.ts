import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { KeychainCredentialStore } from "../src/credentials.js";
import {
  createLinuxSecretServiceRunner,
  createWindowsCredentialManagerRunner,
  LINUX_SECRET_TOOL_BINARY,
  type NativeCredentialChildProcess,
  type NativeCredentialProcessSpawner,
} from "../src/native-credential-store.js";

const SECRET = "  synthetic-native-secret-☃  ";

interface ScriptedResult {
  code: number;
  stderr?: string;
  stdout?: string;
}

function scriptedSpawner(results: ScriptedResult[]) {
  const calls: Array<{ binary: string; args: string[]; input: string }> = [];
  const spawnProcess = vi.fn<NativeCredentialProcessSpawner>((binary, args) => {
    const result = results.shift();
    if (!result) throw new Error("unexpected native command");
    const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const child = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
        end: vi.fn((input?: string) => {
          calls.push({ binary, args, input: input ?? "" });
          queueMicrotask(() => {
            if (result.stdout) stdout.emit("data", result.stdout);
            if (result.stderr) stderr.emit("data", result.stderr);
            child.emit("close", result.code);
          });
        }),
      }),
      stdout,
      stderr,
      kill: vi.fn(() => true),
    }) as NativeCredentialChildProcess & EventEmitter;
    return child;
  });
  return { calls, spawnProcess };
}

describe("Linux Secret Service command contract", () => {
  it("passes the secret only over stdin and confirms absence with metadata search", async () => {
    const { calls, spawnProcess } = scriptedSpawner([
      { code: 0 },
      { code: 1 },
      { code: 0 },
    ]);
    const runner = createLinuxSecretServiceRunner(spawnProcess);

    await expect(runner({ operation: "set", key: "GEMINI_API_KEY", service: "JobCtrl", value: SECRET }, 100)).resolves.toMatchObject({ code: 0 });
    await expect(runner({ operation: "read", key: "GEMINI_API_KEY", service: "JobCtrl" }, 100)).resolves.toMatchObject({ code: 44 });

    expect(calls[0]).toMatchObject({
      binary: LINUX_SECRET_TOOL_BINARY,
      args: ["store", "--label=JobCtrl GEMINI_API_KEY", "service", "JobCtrl", "key", "GEMINI_API_KEY"],
      input: SECRET,
    });
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain(SECRET);
    expect(calls.slice(1).map((call) => call.args[0])).toEqual(["lookup", "search"]);
  });

  it("makes a silent already-absent clear idempotent and keeps locked reads fail-closed", async () => {
    const { spawnProcess } = scriptedSpawner([
      { code: 1 },
      { code: 1 },
      { code: 0 },
      { code: 1 },
      { code: 0, stderr: "attribute.service = JobCtrl" },
    ]);
    const runner = createLinuxSecretServiceRunner(spawnProcess);

    await expect(runner({ operation: "delete", key: "OPENAI_API_KEY", service: "JobCtrl" }, 100)).resolves.toMatchObject({ code: 44 });
    await expect(runner({ operation: "read", key: "OPENAI_API_KEY", service: "JobCtrl" }, 100)).resolves.toMatchObject({ code: 1, stdout: "" });
  });
});

describe("Windows Credential Manager command contract", () => {
  it("uses Cred* P/Invoke with UTF-8 stdin and no target or secret in argv", async () => {
    const { calls, spawnProcess } = scriptedSpawner([{ code: 0 }]);
    const runner = createWindowsCredentialManagerRunner(
      { SystemRoot: String.raw`C:\Windows` },
      spawnProcess,
    );

    await expect(runner({ operation: "set", key: "ANTHROPIC_API_KEY", service: "JobCtrl", value: SECRET }, 100)).resolves.toMatchObject({ code: 0 });

    expect(calls[0]?.binary).toBe(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
    expect(JSON.stringify(calls[0]?.args)).not.toContain(SECRET);
    expect(JSON.stringify(calls[0]?.args)).not.toContain("ANTHROPIC_API_KEY");
    expect(JSON.parse(calls[0]?.input ?? "{}")).toEqual({
      operation: "set",
      key: "ANTHROPIC_API_KEY",
      service: "JobCtrl",
      value: SECRET,
    });
    expect(calls[0]?.args.at(-1)).toContain("CredWriteW");
    expect(calls[0]?.args.at(-1)).toContain("InputEncoding");
    expect(calls[0]?.args.at(-1)).toContain("OutputEncoding");
  });
});

describe("native helper byte limits", () => {
  it.each([
    ["darwin", "a".repeat(129)],
    ["linux", "é".repeat(4_096)],
    ["win32", "é".repeat(1_281)],
  ] as const)("rejects values the %s helper cannot store before spawning", async (platform, value) => {
    const runNative = vi.fn();
    const store = new KeychainCredentialStore({ platform, runNative });
    await expect(store.set("ANTHROPIC_API_KEY", value)).rejects.toMatchObject({
      name: "CredentialValueUnsupportedError",
      key: "ANTHROPIC_API_KEY",
    });
    expect(runNative).not.toHaveBeenCalled();
  });
});
