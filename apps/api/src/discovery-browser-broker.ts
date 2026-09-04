import { randomUUID } from "node:crypto";

import type {
  DiscoveryBrowserBridgeStatusResponse,
  DiscoveryBrowserTaskAcceptedResponse,
  DiscoveryBrowserTaskCreateRequest,
  DiscoveryBrowserTaskLeaseResponse,
  DiscoveryBrowserTaskResult,
  DiscoveryBrowserTaskStatusResponse,
} from "@jobctrl/contracts";

const EXTENSION_CONNECTED_WINDOW_MS = 45_000;
const COMPLETED_TASK_RETENTION_MS = 5 * 60_000;
const LEASE_GRACE_MS = 15_000;
const PENDING_TASK_WAIT_MS = 30_000;
const MAX_IN_FLIGHT_TASKS = 4;

type BrokerTaskState = "pending" | "leased" | "succeeded" | "failed";

interface BrokerTask {
  input: DiscoveryBrowserTaskCreateRequest;
  requestFingerprint: string;
  state: BrokerTaskState;
  createdAtMs: number;
  updatedAtMs: number;
  leaseId: string | null;
  leaseExpiresAtMs: number | null;
  result: DiscoveryBrowserTaskResult | null;
}

export class DiscoveryBrowserBrokerError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "DiscoveryBrowserBrokerError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface DiscoveryBrowserBrokerOptions {
  now?: () => number;
}

/**
 * Process-local rendezvous between the Temporal worker and the paired extension.
 *
 * The owning durability boundary remains Temporal: if the API process restarts,
 * an in-flight read-only browser request is retried by its activity. Keeping the
 * broker memory-only prevents search URLs, response bodies, and authenticated
 * page content from becoming a second persistence authority.
 */
export class DiscoveryBrowserBroker {
  readonly #tasks = new Map<string, BrokerTask>();
  readonly #now: () => number;
  #lastSeenAtMs: number | null = null;
  #extensionVersion: string | null = null;

  constructor(options: DiscoveryBrowserBrokerOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  touchExtension(extensionVersion: string): void {
    this.#lastSeenAtMs = this.#now();
    this.#extensionVersion = extensionVersion.trim().slice(0, 80) || "unknown";
    this.#reap();
  }

  disconnectExtension(): void {
    this.#lastSeenAtMs = null;
    this.#extensionVersion = null;
    this.#tasks.clear();
  }

  createTask(input: DiscoveryBrowserTaskCreateRequest): DiscoveryBrowserTaskAcceptedResponse {
    const now = this.#now();
    this.#reap();
    if (!this.#connectedAt(now)) {
      throw new DiscoveryBrowserBrokerError(
        503,
        "discovery_extension_unavailable",
        "The paired JobCtrl extension is not connected in the user's Chrome profile.",
      );
    }
    const requestFingerprint = stableTaskFingerprint(input);
    const existing = this.#tasks.get(input.taskId);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new DiscoveryBrowserBrokerError(
          409,
          "discovery_browser_task_conflict",
          "The browser task id is already bound to a different request.",
        );
      }
      return {
        ok: true,
        taskId: input.taskId,
        status: existing.state,
      };
    }
    const inFlight = [...this.#tasks.values()].filter(
      (task) => task.state === "pending" || task.state === "leased",
    ).length;
    if (inFlight >= MAX_IN_FLIGHT_TASKS) {
      throw new DiscoveryBrowserBrokerError(
        429,
        "discovery_browser_capacity",
        "The selected Chrome extension is at its bounded Discovery task capacity.",
      );
    }
    this.#tasks.set(input.taskId, {
      input,
      requestFingerprint,
      state: "pending",
      createdAtMs: now,
      updatedAtMs: now,
      leaseId: null,
      leaseExpiresAtMs: null,
      result: null,
    });
    return { ok: true, taskId: input.taskId, status: "pending" };
  }

  leaseNext(extensionVersion: string): DiscoveryBrowserTaskLeaseResponse {
    this.touchExtension(extensionVersion);
    const now = this.#now();
    const task = [...this.#tasks.values()]
      .filter((candidate) => candidate.state === "pending")
      .sort((left, right) => left.createdAtMs - right.createdAtMs)[0];
    if (!task) {
      return { ok: true, status: "idle" };
    }
    const leaseId = randomUUID();
    task.state = "leased";
    task.leaseId = leaseId;
    task.leaseExpiresAtMs = now + task.input.timeoutMs + LEASE_GRACE_MS;
    task.updatedAtMs = now;
    return {
      ok: true,
      status: "task",
      taskId: task.input.taskId,
      leaseId,
      timeoutMs: task.input.timeoutMs,
      request: task.input.request,
    };
  }

  completeTask(taskId: string, leaseId: string, result: DiscoveryBrowserTaskResult): void {
    this.#reap();
    const task = this.#tasks.get(taskId);
    if (!task) {
      throw new DiscoveryBrowserBrokerError(
        404,
        "discovery_browser_task_not_found",
        "The browser task no longer exists.",
      );
    }
    if (task.state === "succeeded" || task.state === "failed") {
      if (task.leaseId === leaseId && JSON.stringify(task.result) === JSON.stringify(result)) {
        return;
      }
      throw new DiscoveryBrowserBrokerError(
        409,
        "discovery_browser_task_already_completed",
        "The browser task already has a terminal result.",
      );
    }
    if (task.state !== "leased" || task.leaseId !== leaseId) {
      throw new DiscoveryBrowserBrokerError(
        409,
        "discovery_browser_lease_stale",
        "The browser task lease is no longer current.",
      );
    }
    if (
      result.status === "succeeded" &&
      !sameHttpOrigin(task.input.request.url, result.finalUrl)
    ) {
      throw new DiscoveryBrowserBrokerError(
        400,
        "unsafe_discovery_browser_redirect",
        "The browser task left its validated source origin.",
      );
    }
    task.state = result.status;
    task.result = result;
    task.updatedAtMs = this.#now();
    task.leaseExpiresAtMs = null;
  }

  leaseActive(taskId: string, leaseId: string, extensionVersion: string): boolean {
    this.touchExtension(extensionVersion);
    const task = this.#tasks.get(taskId);
    return Boolean(task?.state === "leased" && task.leaseId === leaseId);
  }

  taskStatus(taskId: string): DiscoveryBrowserTaskStatusResponse {
    this.#reap();
    const task = this.#tasks.get(taskId);
    if (!task) {
      throw new DiscoveryBrowserBrokerError(
        404,
        "discovery_browser_task_not_found",
        "The browser task no longer exists.",
      );
    }
    if (task.state === "succeeded" || task.state === "failed") {
      if (!task.result) {
        throw new Error("Terminal browser task is missing its result.");
      }
      return {
        ok: true,
        taskId,
        status: task.state,
        result: task.result,
      };
    }
    return { ok: true, taskId, status: task.state };
  }

  cancelTask(taskId: string): void {
    this.#tasks.delete(taskId);
  }

  status(): DiscoveryBrowserBridgeStatusResponse {
    this.#reap();
    const now = this.#now();
    const states = [...this.#tasks.values()].map((task) => task.state);
    return {
      ok: true,
      connected: this.#connectedAt(now),
      installationBound: false,
      installationIdSuffix: null,
      lastSeenAt: this.#lastSeenAtMs === null ? null : new Date(this.#lastSeenAtMs).toISOString(),
      extensionVersion: this.#extensionVersion,
      pendingTasks: states.filter((state) => state === "pending").length,
      activeTasks: states.filter((state) => state === "leased").length,
    };
  }

  #connectedAt(now: number): boolean {
    return this.#lastSeenAtMs !== null && now - this.#lastSeenAtMs <= EXTENSION_CONNECTED_WINDOW_MS;
  }

  #reap(): void {
    const now = this.#now();
    for (const [taskId, task] of this.#tasks) {
      if (
        task.state === "leased" &&
        task.leaseExpiresAtMs !== null &&
        task.leaseExpiresAtMs <= now
      ) {
        task.state = "pending";
        task.leaseId = null;
        task.leaseExpiresAtMs = null;
        task.updatedAtMs = now;
      }
      if (
        task.state === "pending" &&
        now - task.updatedAtMs > PENDING_TASK_WAIT_MS
      ) {
        this.#tasks.delete(taskId);
        continue;
      }
      if (
        (task.state === "succeeded" || task.state === "failed") &&
        now - task.updatedAtMs > COMPLETED_TASK_RETENTION_MS
      ) {
        this.#tasks.delete(taskId);
      }
    }
  }
}

function stableTaskFingerprint(input: DiscoveryBrowserTaskCreateRequest): string {
  return JSON.stringify(input);
}

function sameHttpOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}
