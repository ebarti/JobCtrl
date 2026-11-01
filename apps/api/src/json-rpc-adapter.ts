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

import { buildJsonRpcRequest, JsonRpcResponseSchema, type JsonRpcResponse, parseRpcParams, parseRpcResponse, type ContractRpcMethod, type RpcParams, type RpcResponse, RpcContractError } from "./contracts.js";
import {
  AUTOMATION_PROJECT_DIR,
  createSourcePythonRuntime,
  type PythonRuntimeCommandResolver,
} from "./python-runtime.js";

export interface JsonRpcCallOptions {
  /** Working directory for the worker process (defaults to repo root). */
  appDir?: string;
  /** Canonical non-secret settings file for the worker process. */
  configPath?: string;
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
  call<M extends ContractRpcMethod>(method: M, params: RpcParams<NoInfer<M>>): Promise<JsonRpcResponse>;
  close(): Promise<void>;
}

interface PendingRequest {
  method: ContractRpcMethod;
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
  private draining = false;
  private drainFailure: Error | null = null;
  private drainPromise: Promise<void> | null = null;
  private readonly options: {
    appDir: string;
    configPath?: string;
    pythonRuntime: PythonRuntimeCommandResolver;
    requestTimeoutMs: number;
  };

  constructor(options: JsonRpcCallOptions = {}) {
    this.options = {
      appDir: options.appDir ?? AUTOMATION_PROJECT_DIR,
      ...(options.configPath ? { configPath: options.configPath } : {}),
      pythonRuntime:
        options.pythonRuntime ??
        createSourcePythonRuntime({
          ...(options.projectDir ? { projectDir: options.projectDir } : {}),
          ...(options.uvBinary ? { uvBinary: options.uvBinary } : {}),
        }),
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    };
  }

  async call<M extends ContractRpcMethod>(method: M, params: RpcParams<NoInfer<M>>): Promise<RpcResponse<M>> {
    const validatedParams = parseRpcParams(method, params);
    if (this.closed) throw new Error("SubprocessJsonRpcAdapter is closed.");
    const child = this.ensureChild();
    const id = this.nextRequestId++;
    const request = buildJsonRpcRequest(method, validatedParams, id);
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`JSON-RPC request '${method}' timed out after ${this.options.requestTimeoutMs}ms`));
        }
      }, this.options.requestTimeoutMs);
      // Don't let a pending timeout keep the process alive on its own.
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
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
    return parseRpcResponse(method, validatedParams, response);
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

  /** Stop admission, request EOF and wait for the RPC server's in-flight work.
   * A timeout is a failure, not proof that the child or its work stopped.
   */
  drain(timeoutMs = 30_000): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.closed = true;
    this.draining = true;
    const child = this.child;
    if (!child) return Promise.resolve();
    this.drainPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("JSON-RPC subprocess did not drain before the shutdown deadline."));
      }, timeoutMs);
      child.once("close", () => {
        clearTimeout(timer);
        if (this.drainFailure) reject(this.drainFailure);
        else resolve();
      });
      child.stdin.end();
    });
    return this.drainPromise;
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;

    const command = this.options.pythonRuntime.resolve(
      { kind: "cli", args: ["rpc"] },
      {
        appDir: this.options.appDir,
        ...(this.options.configPath ? { configPath: this.options.configPath } : {}),
      },
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
      if (this.draining) this.drainFailure = err;
      this.failAllPending(err);
      this.child = null;
    });
    child.on("close", (code, signal) => {
      if (this.draining && (this.pending.size > 0 || code !== 0 || signal !== null)) {
        this.drainFailure ??= new Error("JSON-RPC subprocess exited before completing its drain.");
      }
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
      // A malformed correlated response must fail as invalid output. Progress
      // notifications have no matching id and remain outside settlement.
      if (parsed && typeof parsed === "object" && "id" in parsed) {
        const id = parsed.id;
        const pending = typeof id === "number" || typeof id === "string" ? this.pending.get(id) : undefined;
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id as number | string);
          pending.reject(new RpcContractError(pending.method, "result"));
        }
      }
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
 * Context-scoped dispatchers used by the production server. Tests inject
 * their own dispatcher via the ``actionDispatcher`` option on
 * ``buildApp`` and never touch the singleton.
 */
const defaultDispatchers = new Map<string, SubprocessJsonRpcAdapter>();
let defaultDispatchersDraining = false;

function dispatcherKey(options: JsonRpcCallOptions = {}): string {
  const pythonRuntime =
    options.pythonRuntime ??
    createSourcePythonRuntime({
      ...(options.projectDir ? { projectDir: options.projectDir } : {}),
      ...(options.uvBinary ? { uvBinary: options.uvBinary } : {}),
    });
  return JSON.stringify({
    appDir: options.appDir ?? AUTOMATION_PROJECT_DIR,
    configPath: options.configPath ?? null,
    pythonRuntime: pythonRuntime.id,
  });
}

export function getDefaultJsonRpcDispatcher(options: JsonRpcCallOptions = {}): SubprocessJsonRpcAdapter {
  if (defaultDispatchersDraining) throw new Error("JSON-RPC dispatch is shutting down.");
  const key = dispatcherKey(options);
  let dispatcher = defaultDispatchers.get(key);
  if (!dispatcher) {
    dispatcher = new SubprocessJsonRpcAdapter(options);
    defaultDispatchers.set(key, dispatcher);
  }
  return dispatcher;
}

/** Close every cached context — used by tests so each test gets isolation. */
export function resetDefaultJsonRpcDispatcher(): void {
  for (const dispatcher of defaultDispatchers.values()) void dispatcher.close();
  defaultDispatchers.clear();
  defaultDispatchersDraining = false;
}

/** Process-entrypoint shutdown only: fence the process-owned pool and await EOF. */
export async function drainDefaultJsonRpcDispatchers(): Promise<void> {
  defaultDispatchersDraining = true;
  const results = await Promise.allSettled([...defaultDispatchers.values()].map((dispatcher) => dispatcher.drain()));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}

/** Enforce the same boundary for production callers and injected dispatchers. */
export async function callRpc<M extends ContractRpcMethod>(
  dispatcher: JsonRpcDispatcher, method: M, params: RpcParams<NoInfer<M>>,
): Promise<RpcResponse<M>> {
  const validated = parseRpcParams(method, params);
  return parseRpcResponse(method, validated, await dispatcher.call(method, validated));
}

export { RpcContractError } from "./contracts.js";
