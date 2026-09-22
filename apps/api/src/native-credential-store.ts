import { spawn } from "node:child_process";
import path from "node:path";

import type { SecretCredentialKey } from "./contracts.js";
import { CREDENTIAL_VALUE_MAX_LENGTH } from "./contracts.js";

export const LINUX_SECRET_TOOL_BINARY = "/usr/bin/secret-tool";
export const NATIVE_CREDENTIAL_COMMAND_TIMEOUT_MS = 5_000;
export const WINDOWS_CREDENTIAL_COMMAND_TIMEOUT_MS = 15_000;
export const WINDOWS_CREDENTIAL_BLOB_MAX_BYTES = 2_560;
export const LINUX_SECRET_TOOL_MAX_INPUT_BYTES = 8_191;
export const MACOS_SECURITY_PROMPT_MAX_INPUT_BYTES = 128;

export type NativeCredentialStoreKind =
  | "macos_keychain"
  | "windows_credential_manager"
  | "linux_secret_service";

export type NativeCredentialOperation = "inspect" | "read" | "set" | "delete";

export interface NativeCredentialCommand {
  key: SecretCredentialKey;
  operation: NativeCredentialOperation;
  service: string;
  value?: string;
}

export interface NativeCredentialCommandResult {
  /** 0 success, 44 confirmed absence, any other value operational failure. */
  code: number;
  stderr: string;
  stdout: string;
}

export type NativeCredentialCommandRunner = (
  command: NativeCredentialCommand,
  timeoutMs: number,
) => Promise<NativeCredentialCommandResult>;

interface ChildInputStream {
  destroy(): unknown;
  end(): unknown;
  end(chunk: string, encoding: BufferEncoding): unknown;
  on(event: "error", listener: () => void): unknown;
}

interface ChildOutputStream {
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
}

export interface NativeCredentialChildProcess {
  readonly stdin: ChildInputStream;
  readonly stdout: ChildOutputStream;
  readonly stderr: ChildOutputStream;
  on(event: "error", listener: () => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

export type NativeCredentialProcessSpawner = (
  binary: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "pipe"]; windowsHide: true },
) => NativeCredentialChildProcess;

type ProcessResult = NativeCredentialCommandResult;

const MAX_CAPTURED_OUTPUT_CHARS = CREDENTIAL_VALUE_MAX_LENGTH + 4_096;

export function nativeStoreKind(platform: NodeJS.Platform): NativeCredentialStoreKind | null {
  if (platform === "darwin") return "macos_keychain";
  if (platform === "win32") return "windows_credential_manager";
  if (platform === "linux") return "linux_secret_service";
  return null;
}

export function nativeCredentialValueSupported(
  platform: NodeJS.Platform,
  value: string,
): boolean {
  if (platform === "darwin") {
    return Buffer.byteLength(value, "utf8") <= MACOS_SECURITY_PROMPT_MAX_INPUT_BYTES;
  }
  if (platform === "linux") {
    return Buffer.byteLength(value, "utf8") <= LINUX_SECRET_TOOL_MAX_INPUT_BYTES;
  }
  if (platform === "win32") {
    return Buffer.byteLength(value, "utf16le") <= WINDOWS_CREDENTIAL_BLOB_MAX_BYTES;
  }
  return true;
}

export function nativeCredentialMaxBytes(platform: NodeJS.Platform): number | null {
  if (platform === "darwin") return MACOS_SECURITY_PROMPT_MAX_INPUT_BYTES;
  if (platform === "linux") return LINUX_SECRET_TOOL_MAX_INPUT_BYTES;
  if (platform === "win32") return WINDOWS_CREDENTIAL_BLOB_MAX_BYTES;
  return null;
}

export function createLinuxSecretServiceRunner(
  spawnProcess: NativeCredentialProcessSpawner = defaultSpawner,
): NativeCredentialCommandRunner {
  const runner: NativeCredentialCommandRunner = async (command, timeoutMs) => {
    const attributes = ["service", command.service, "key", command.key];
    if (command.operation === "set") {
      return runProcess(
        spawnProcess,
        LINUX_SECRET_TOOL_BINARY,
        ["store", `--label=${command.service} ${command.key}`, ...attributes],
        command.value ?? "",
        timeoutMs,
      );
    }
    if (command.operation === "delete") {
      const cleared = await runProcess(
        spawnProcess,
        LINUX_SECRET_TOOL_BINARY,
        ["clear", ...attributes],
        undefined,
        timeoutMs,
      );
      if (cleared.code === 0 || cleared.stderr || cleared.stdout || cleared.code !== 1) {
        return cleared;
      }
      const after = await runner({ ...command, operation: "inspect" }, timeoutMs);
      return after.code === 44 ? after : cleared;
    }

    const lookup = await runProcess(
      spawnProcess,
      LINUX_SECRET_TOOL_BINARY,
      ["lookup", ...attributes],
      undefined,
      timeoutMs,
    );
    if (lookup.code === 0 || lookup.stderr) return lookup;
    if (lookup.code !== 1 || lookup.stdout) return lookup;

    // `secret-tool lookup` uses exit 1 both for an absent item and for some
    // locked-item cases. A metadata search distinguishes a confirmed empty
    // result from an existing item whose secret could not be read.
    const search = await runProcess(
      spawnProcess,
      LINUX_SECRET_TOOL_BINARY,
      ["search", "--all", ...attributes],
      undefined,
      timeoutMs,
    );
    if (search.code !== 0) return search;
    if (!search.stdout && !search.stderr) {
      return { code: 44, stderr: "", stdout: "" };
    }
    // The item exists, but lookup could not return its secret. Presence checks
    // can report it as stored; private reads remain fail-closed.
    return command.operation === "inspect"
      ? { code: 0, stderr: "", stdout: "" }
      : { code: 1, stderr: "credential item is not readable", stdout: "" };
  };
  return runner;
}

export function createWindowsCredentialManagerRunner(
  env: NodeJS.ProcessEnv = process.env,
  spawnProcess: NativeCredentialProcessSpawner = defaultSpawner,
): NativeCredentialCommandRunner {
  return async (command, timeoutMs) => {
    const systemRoot = env.SystemRoot?.trim() || env.WINDIR?.trim();
    if (!systemRoot) {
      return { code: 1, stderr: "credential helper is unavailable", stdout: "" };
    }
    const binary = path.win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const payload = JSON.stringify({
      key: command.key,
      operation: command.operation,
      service: command.service,
      ...(command.value === undefined ? {} : { value: command.value }),
    });
    return runProcess(
      spawnProcess,
      binary,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_CREDENTIAL_SCRIPT],
      payload,
      timeoutMs,
    );
  };
}

function runProcess(
  spawnProcess: NativeCredentialProcessSpawner,
  binary: string,
  args: string[],
  stdin: string | undefined,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child: NativeCredentialChildProcess;
    try {
      child = spawnProcess(binary, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      reject(new Error("credential helper could not start"));
      return;
    }

    let settled = false;
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: string | Buffer) =>
      `${current}${String(chunk)}`.slice(0, MAX_CAPTURED_OUTPUT_CHARS);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const terminate = () => {
      try {
        child.stdin.destroy();
      } catch {
        // Sanitized failure below remains authoritative.
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // Sanitized failure below remains authoritative.
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", () => finish(() => {
      terminate();
      reject(new Error("credential helper could not start"));
    }));
    child.on("close", (code) => finish(() => resolve({
      code: code ?? 1,
      stderr: stderr.trim(),
      stdout,
    })));
    child.stdin.on("error", () => finish(() => {
      terminate();
      reject(new Error("credential helper input failed"));
    }));
    const timer = setTimeout(() => finish(() => {
      terminate();
      reject(new Error("credential helper timed out"));
    }), timeoutMs);

    try {
      if (stdin === undefined) child.stdin.end();
      else child.stdin.end(stdin, "utf8");
    } catch {
      finish(() => {
        terminate();
        reject(new Error("credential helper input failed"));
      });
    }
  });
}

const defaultSpawner: NativeCredentialProcessSpawner = (binary, args, options) =>
  spawn(binary, args, options) as NativeCredentialChildProcess;

// Static helper code is safe in argv. The target, key, and secret arrive only
// over stdin. CredRead/CredWrite/CredDelete operate on Windows Credential
// Manager generic credentials; unmanaged secret buffers are zeroed and freed.
const WINDOWS_CREDENTIAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;
public static class JobCtrlCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
    public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredFree")]
  public static extern void CredFree(IntPtr buffer);
}
'@
try {
  Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop
  [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  Add-Type -TypeDefinition $source -ErrorAction Stop
  $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $target = [string]$inputData.service + ':' + [string]$inputData.key
  $credentialPointer = [IntPtr]::Zero
  if ($inputData.operation -eq 'set') {
    $bytes = [Text.Encoding]::Unicode.GetBytes([string]$inputData.value)
    if ($bytes.Length -gt ${WINDOWS_CREDENTIAL_BLOB_MAX_BYTES}) { exit 1 }
    $blob = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)
    try {
      [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
      $credential = New-Object JobCtrlCred+CREDENTIAL
      $credential.Type = 1; $credential.TargetName = $target; $credential.UserName = [string]$inputData.service
      $credential.CredentialBlob = $blob; $credential.CredentialBlobSize = $bytes.Length; $credential.Persist = 2
      if (-not [JobCtrlCred]::CredWrite([ref]$credential, 0)) { exit 1 }
      exit 0
    } finally {
      for ($i = 0; $i -lt $bytes.Length; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($blob, $i, 0) }
      [Runtime.InteropServices.Marshal]::FreeCoTaskMem($blob)
      [Array]::Clear($bytes, 0, $bytes.Length)
    }
  }
  if ($inputData.operation -eq 'delete') {
    if ([JobCtrlCred]::CredDelete($target, 1, 0)) { exit 0 }
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 44 }
    exit 1
  }
  if (-not [JobCtrlCred]::CredRead($target, 1, 0, [ref]$credentialPointer)) {
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 44 }
    exit 1
  }
  try {
    if ($inputData.operation -eq 'inspect') { exit 0 }
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($credentialPointer, [type][JobCtrlCred+CREDENTIAL])
    if ($credential.CredentialBlobSize -eq 0) { exit 1 }
    $secret = [Runtime.InteropServices.Marshal]::PtrToStringUni($credential.CredentialBlob, $credential.CredentialBlobSize / 2)
    [Console]::Out.Write($secret)
    exit 0
  } finally { [JobCtrlCred]::CredFree($credentialPointer) }
} catch { exit 1 }
`;
