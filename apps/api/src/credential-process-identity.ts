import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ProcessIdentityObservation =
  | { state: "alive"; identity: string }
  | { state: "exited" }
  | { state: "timeout" }
  | { state: "unverified" };

export type ProcessIdentityReader = (pid: number, timeoutMs?: number) => Promise<ProcessIdentityObservation>;

export function validCredentialProcessIdentity(identity: string): boolean {
  if (identity.length > 200) return false;
  if (process.platform === "darwin") return /^darwin:[1-9]\d*:\d+$/u.test(identity);
  if (process.platform === "linux") return /^linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/iu.test(identity);
  if (process.platform === "win32") return /^windows:\d+:\d+$/u.test(identity);
  return false;
}

// Uses Darwin's kernel start time, as in the existing launcher custody code;
// generation reads detect PID reuse while the observation is being made.
const IDENTITY_SCRIPT = String.raw`
import ctypes, errno, os, platform, struct, sys
pid = int(sys.stdin.read())
try:
    if platform.system() == 'Darwin':
        class Unique(ctypes.Structure):
            _fields_ = [('uuid', ctypes.c_byte * 16), ('unique_id', ctypes.c_uint64),
                        ('parent_unique_id', ctypes.c_uint64), ('pid_version', ctypes.c_int32),
                        ('reserved2', ctypes.c_uint32), ('reserved3', ctypes.c_uint64), ('reserved4', ctypes.c_uint64)]
        class Short(ctypes.Structure):
            _fields_ = [('pid', ctypes.c_uint32), ('ppid', ctypes.c_uint32),
                        ('pgid', ctypes.c_uint32), ('state', ctypes.c_uint32), ('remaining', ctypes.c_byte * 48)]
        class BSD(ctypes.Structure):
            _fields_ = [('data', ctypes.c_byte * 136)]
        lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        lib.proc_pidinfo.restype = ctypes.c_int
        def read(flavor, kind):
            value = kind()
            ctypes.set_errno(0)
            size = lib.proc_pidinfo(pid, flavor, 1, ctypes.byref(value), ctypes.sizeof(value))
            if size != ctypes.sizeof(value):
                if size == 0 and ctypes.get_errno() == errno.ESRCH:
                    raise ProcessLookupError()
                raise RuntimeError('inspection unavailable')
            return value
        before = read(17, Unique)
        short = read(13, Short)
        bsd = bytes(read(3, BSD).data)
        after = read(17, Unique)
        start_seconds, start_microseconds = struct.unpack_from('=QQ', bsd, 120)
        if short.pid != pid or struct.unpack_from('=I', bsd, 12)[0] != pid or before.unique_id == 0 or start_seconds == 0 or (before.unique_id, before.pid_version) != (after.unique_id, after.pid_version):
            raise RuntimeError('identity changed')
        if short.state == 5:
            print('exited')
        else:
            print('alive:darwin:' + str(start_seconds) + ':' + str(start_microseconds))
    elif platform.system() == 'Windows':
        from ctypes import wintypes
        k = ctypes.WinDLL('kernel32', use_last_error=True)
        k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k.OpenProcess.restype = wintypes.HANDLE
        k.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k.WaitForSingleObject.restype = wintypes.DWORD
        k.GetProcessTimes.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME)]
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = k.OpenProcess(0x101000, False, pid)
        if not handle:
            if ctypes.get_last_error() == 87: raise ProcessLookupError()
            raise RuntimeError('inspection unavailable')
        try:
            state = k.WaitForSingleObject(handle, 0)
            if state == 0:
                print('exited')
            elif state == 258:
                created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
                if not k.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
                    raise RuntimeError('inspection unavailable')
                print('alive:windows:' + str(created.dwHighDateTime) + ':' + str(created.dwLowDateTime))
            else:
                raise RuntimeError('inspection unavailable')
        finally:
            k.CloseHandle(handle)
    else:
        raise RuntimeError('inspection unavailable')
except ProcessLookupError:
    print('exited')
except Exception:
    print('unverified')
`;

export const readCredentialProcessIdentity: ProcessIdentityReader = async (pid, timeoutMs = 1_000) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unverified" };
  if (process.platform === "linux") {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        readLinuxIdentity(pid),
        new Promise<ProcessIdentityObservation>((resolve) => {
          timer = setTimeout(() => resolve({ state: "timeout" }), Math.max(1, Math.min(timeoutMs, 1_000)));
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
  if (process.platform !== "darwin" && process.platform !== "win32") return { state: "unverified" };
  const sourcePython = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "../../../workers/automation/.venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  const executable = process.env.JOBCTRL_PYTHON_EXECUTABLE || sourcePython;
  if (!path.isAbsolute(executable)) return { state: "unverified" };
  return readViaPython(executable, pid, timeoutMs);
};

async function readLinuxIdentity(pid: number): Promise<ProcessIdentityObservation> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    const fields = stat.slice(end + 1).trim().split(/\s+/u);
    if (end < 0 || fields.length < 20 || !/^\d+$/u.test(fields[19] ?? "")) return { state: "unverified" };
    if (fields[0] === "Z" || fields[0] === "X") return { state: "exited" };
    const boot = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (!/^[0-9a-f-]{36}$/iu.test(boot)) return { state: "unverified" };
    return { state: "alive", identity: `linux:${boot}:${fields[19]}` };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      try { process.kill(pid, 0); } catch (probe) {
        if (probe instanceof Error && "code" in probe && probe.code === "ESRCH") return { state: "exited" };
      }
    }
    return { state: "unverified" };
  }
}

function readViaPython(executable: string, pid: number, timeoutMs: number): Promise<ProcessIdentityObservation> {
  return new Promise((resolve) => {
    let settled = false;
    let exited = false;
    let output = "";
    const done = (value: ProcessIdentityObservation): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn(executable, ["-I", "-B", "-c", IDENTITY_SCRIPT], {
        stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
        env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {},
      });
    } catch {
      resolve({ state: "unverified" });
      return;
    }
    const timer = setTimeout(() => {
      try { if (!exited) child.kill("SIGKILL"); } catch { /* No process authority is inferred. */ }
      done({ state: "timeout" });
    }, Math.max(1, Math.min(timeoutMs, 1_000)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output = (output + chunk).slice(0, 257); });
    child.on("exit", () => { exited = true; });
    child.on("error", () => done({ state: "unverified" }));
    child.stdin.on("error", () => {
      try { if (!exited) child.kill("SIGKILL"); } catch { /* Only this owned probe is targeted. */ }
      done({ state: "unverified" });
    });
    child.on("close", (code) => {
      const value = output.trim();
      if (code !== 0) done({ state: "unverified" });
      else if (value === "exited") done({ state: "exited" });
      else if (/^alive:(?:darwin|windows):[a-z0-9:-]{1,200}$/iu.test(value)) done({ state: "alive", identity: value.slice(6) });
      else done({ state: "unverified" });
    });
    child.stdin.end(String(pid));
  });
}
