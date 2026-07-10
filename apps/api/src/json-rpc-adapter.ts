/**
 * SubprocessJsonRpcAdapter (Phase 9 / S-34).
 *
 * Spawns the centrally resolved Python CLI command as a long-lived
 * subprocess and pipes JSON-RPC requests over its
 * stdin/stdout.  Replaces the previous "spawn one subprocess per
 * action" pattern in ``local-actions.ts`` — per the no-strangler
 * directive the old per-call subprocess action path is
 * deleted.
 *
 * Lifecycle:
 *
 *   * The adapter is lazy — the worker is spawned on the first
 *     ``call()`` and reused thereafter.
 *   * Crashed workers are detected by the ``stdout`` close event and
 *     the next call respawns transparently.
 *   * ``close()`` shuts the worker down cleanly (used in tests).
 *
 * Per ddd-target.md §6.5 the JSON-RPC handler set covers sync commands
 * and workflow-start commands (``profile_import``, ``apply``, batched
 * ``run_stage``). The server emits exactly one response envelope per
 * request; ``call()`` resolves on that envelope.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { buildJsonRpcRequest, JsonRpcResponseSchema, type JsonRpcResponse, type RpcMethod } from "./contracts.js";
import {
  AUTOMATION_PROJECT_DIR,
  createSourcePythonRuntime,
  type PythonRuntimeCommandResolver,
} from "./python-runtime.js";

export interface JsonRpcCallOptions {
  /** Working directory for the worker process (defaults to repo root). */
  appDir?: string;
  /** Override the default ``uv`` binary. Useful for tests. */
  uvBinary?: string;
  /** Override the worker project directory. Useful for tests. */
  projectDir?: string;
  /** Inject the private Python runtime used by production payloads. */
  pythonRuntime?: PythonRuntimeCommandResolver;
  /**
   * Per-request timeout in ms. A dead or hung worker handler would otherwise
   * leave the request pending forever; on timeout the pending entry is
   * dropped and the promise rejects so the HTTP request can fail cleanly
   * instead of hanging. Generous by default so legitimate long syncs finish.
   */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

export interface JsonRpcDispatcher {
  call(method: RpcMethod, params: Record<string, unknown>): Promise<JsonRpcResponse>;
  close(): Promise<void>;
}

interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class SubprocessJsonRpcAdapter implements JsonRpcDispatcher {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private buffer = "";
  private closed = false;
  private readonly options: {
    appDir: string;
    pythonRuntime: PythonRuntimeCommandResolver;
    requestTimeoutMs: number;
  };

  constructor(options: JsonRpcCallOptions = {}) {
    this.options = {
      appDir: options.appDir ?? AUTOMATION_PROJECT_DIR,
      pythonRuntime:
        options.pythonRuntime ??
        createSourcePythonRuntime({
          ...(options.projectDir ? { projectDir: options.projectDir } : {}),
          ...(options.uvBinary ? { uvBinary: options.uvBinary } : {}),
        }),
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    };
  }

  async call(method: RpcMethod, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    if (this.closed) throw new Error("SubprocessJsonRpcAdapter is closed.");
    const child = this.ensureChild();
    const id = this.nextRequestId++;
    const request = buildJsonRpcRequest(method, params, id);
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`JSON-RPC request '${method}' timed out after ${this.options.requestTimeoutMs}ms`));
        }
      }, this.options.requestTimeoutMs);
      // Don't let a pending timeout keep the process alive on its own.
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      const line = `${JSON.stringify(request)}\n`;
      child.stdin.write(line, (writeError) => {
        if (writeError) {
          const entry = this.pending.get(id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(id);
          }
          reject(writeError);
        }
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (child) {
      this.child = null;
      try {
        child.stdin.end();
      } catch {
        // Already closed.
      }
      child.kill();
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Adapter closed before response."));
    }
    this.pending.clear();
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;

    const command = this.options.pythonRuntime.resolve(
      { kind: "cli", args: ["rpc"] },
      { appDir: this.options.appDir },
    );
    const child = spawn(command.executable, command.argv, {
      cwd: command.cwd,
      env: command.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.on("data", () => {
      // Worker logs to stderr — we intentionally drop them here so the
      // API process doesn't double-log.  The worker's own log file is
      // the source of truth.
    });
    child.on("error", (err) => {
      this.failAllPending(err);
      this.child = null;
    });
    child.on("close", () => {
      this.failAllPending(new Error("Worker subprocess closed unexpectedly."));
      this.child = null;
    });
    this.child = child;
    return child;
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) this.dispatchLine(line);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private dispatchLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // Ignore non-JSON lines (notifications, debug output).
    }
    const validation = JsonRpcResponseSchema.safeParse(parsed);
    if (!validation.success) {
      // Notifications (no id) — ignore.
      return;
    }
    const response = validation.data;
    const id = response.id;
    if (id === null || id === undefined) return; // notification
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(response);
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Singleton dispatcher used by the production server. Tests inject
 * their own dispatcher via the ``actionDispatcher`` option on
 * ``buildApp`` and never touch the singleton.
 */
let _defaultDispatcher: SubprocessJsonRpcAdapter | null = null;
let _defaultDispatcherKey: string | null = null;

function dispatcherKey(options: JsonRpcCallOptions = {}): string {
  const pythonRuntime =
    options.pythonRuntime ??
    createSourcePythonRuntime({
      ...(options.projectDir ? { projectDir: options.projectDir } : {}),
      ...(options.uvBinary ? { uvBinary: options.uvBinary } : {}),
    });
  return JSON.stringify({
    appDir: options.appDir ?? AUTOMATION_PROJECT_DIR,
    pythonRuntime: pythonRuntime.id,
  });
}

export function getDefaultJsonRpcDispatcher(options: JsonRpcCallOptions = {}): SubprocessJsonRpcAdapter {
  const key = dispatcherKey(options);
  if (_defaultDispatcher === null || _defaultDispatcherKey !== key) {
    if (_defaultDispatcher !== null) {
      void _defaultDispatcher.close();
    }
    _defaultDispatcher = new SubprocessJsonRpcAdapter(options);
    _defaultDispatcherKey = key;
  }
  return _defaultDispatcher;
}

/** Reset the singleton — used by tests so each test gets isolation. */
export function resetDefaultJsonRpcDispatcher(): void {
  if (_defaultDispatcher) {
    void _defaultDispatcher.close();
  }
  _defaultDispatcher = null;
  _defaultDispatcherKey = null;
}
