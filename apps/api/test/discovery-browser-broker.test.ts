import { describe, expect, it } from "vitest";

import {
  DiscoveryBrowserBroker,
  DiscoveryBrowserBrokerError,
} from "../src/discovery-browser-broker.js";

const task = {
  taskId: "discover-run-1:linkedin:page-1",
  workflowId: "discover-local",
  temporalRunId: "run-1",
  sourceFamily: "jobspy" as const,
  sourceId: "jobspy:linkedin",
  request: {
    mode: "http_request" as const,
    url: "https://www.linkedin.com/jobs-guest/jobs/api/search",
    method: "GET" as const,
    headers: {},
  },
  timeoutMs: 60_000,
};

describe("DiscoveryBrowserBroker", () => {
  it("fails task creation closed when no live extension has checked in", () => {
    const broker = new DiscoveryBrowserBroker();
    expect(() => broker.createTask(task)).toThrowError(
      expect.objectContaining<Partial<DiscoveryBrowserBrokerError>>({
        statusCode: 503,
        code: "discovery_extension_unavailable",
      }),
    );
  });

  it("leases and completes one execution-bound read request", () => {
    let now = Date.parse("2026-09-02T10:00:00.000Z");
    const broker = new DiscoveryBrowserBroker({ now: () => now });
    broker.touchExtension("0.1.2");

    expect(broker.createTask(task)).toEqual({
      ok: true,
      taskId: task.taskId,
      status: "pending",
    });
    const lease = broker.leaseNext("0.1.2");
    expect(lease).toMatchObject({
      ok: true,
      status: "task",
      taskId: task.taskId,
      request: task.request,
    });
    if (lease.status !== "task") throw new Error("expected a task lease");

    const result = {
      status: "succeeded" as const,
      finalUrl: task.request.url,
      statusCode: 200,
      contentType: "text/html",
      title: "",
      bodyText: "<article>Fixture role</article>",
    };
    broker.completeTask(task.taskId, lease.leaseId, result);
    expect(broker.taskStatus(task.taskId)).toEqual({
      ok: true,
      taskId: task.taskId,
      status: "succeeded",
      result,
    });

    now += 46_000;
    expect(broker.status()).toMatchObject({ connected: false, extensionVersion: "0.1.2" });
  });

  it("requeues an expired lease and rejects stale completion", () => {
    let now = 1_000;
    const broker = new DiscoveryBrowserBroker({ now: () => now });
    broker.touchExtension("0.1.2");
    broker.createTask({ ...task, timeoutMs: 1_000 });
    const first = broker.leaseNext("0.1.2");
    if (first.status !== "task") throw new Error("expected first lease");

    now += 16_001;
    const second = broker.leaseNext("0.1.2");
    if (second.status !== "task") throw new Error("expected replacement lease");
    expect(second.leaseId).not.toBe(first.leaseId);
    expect(() =>
      broker.completeTask(task.taskId, first.leaseId, {
        status: "failed",
        errorCode: "request_failed",
        message: "stale result",
        retryable: true,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<DiscoveryBrowserBrokerError>>({
        code: "discovery_browser_lease_stale",
      }),
    );
  });

  it("binds a task id to exactly one immutable request", () => {
    const broker = new DiscoveryBrowserBroker();
    broker.touchExtension("0.1.2");
    broker.createTask(task);
    expect(() =>
      broker.createTask({
        ...task,
        request: { ...task.request, url: "https://example.test/different" },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<DiscoveryBrowserBrokerError>>({
        code: "discovery_browser_task_conflict",
      }),
    );
  });

  it("expires an abandoned pending task instead of leaving stale browser work forever", () => {
    let now = 1_000;
    const broker = new DiscoveryBrowserBroker({ now: () => now });
    broker.touchExtension("0.1.2");
    broker.createTask({ ...task, timeoutMs: 1_000 });

    now += 30_001;

    expect(() => broker.taskStatus(task.taskId)).toThrowError(
      expect.objectContaining<Partial<DiscoveryBrowserBrokerError>>({
        code: "discovery_browser_task_not_found",
      }),
    );
    expect(broker.status()).toMatchObject({ pendingTasks: 0, activeTasks: 0 });
  });

  it("disconnects immediately when the pairing token is rotated", () => {
    const broker = new DiscoveryBrowserBroker();
    broker.touchExtension("0.1.2");
    expect(broker.status().connected).toBe(true);

    broker.disconnectExtension();

    expect(broker.status()).toMatchObject({
      connected: false,
      lastSeenAt: null,
      extensionVersion: null,
    });
  });

  it("keeps the extension connected while an active lease heartbeats", () => {
    let now = 1_000;
    const broker = new DiscoveryBrowserBroker({ now: () => now });
    broker.touchExtension("0.1.2");
    broker.createTask({ ...task, timeoutMs: 120_000 });
    const lease = broker.leaseNext("0.1.2");
    if (lease.status !== "task") throw new Error("expected task lease");

    now += 46_000;
    expect(broker.leaseActive(task.taskId, lease.leaseId, "0.1.2")).toBe(true);
    expect(broker.status().connected).toBe(true);
    expect(
      broker.createTask({
        ...task,
        taskId: "discover-run-1:linkedin:page-2",
        request: { ...task.request, url: `${task.request.url}?page=2` },
      }),
    ).toMatchObject({ status: "pending" });
  });

  it("bounds admission to the four concurrent extension executors", () => {
    const broker = new DiscoveryBrowserBroker();
    broker.touchExtension("0.1.2");
    for (let index = 0; index < 4; index += 1) {
      broker.createTask({
        ...task,
        taskId: `discover-run-1:source:${index}`,
        request: { ...task.request, url: `${task.request.url}?source=${index}` },
      });
    }

    expect(() =>
      broker.createTask({
        ...task,
        taskId: "discover-run-1:source:overflow",
        request: { ...task.request, url: `${task.request.url}?overflow=1` },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<DiscoveryBrowserBrokerError>>({
        statusCode: 429,
        code: "discovery_browser_capacity",
      }),
    );

    const leases = Array.from({ length: 4 }, () => broker.leaseNext("0.1.2"));
    expect(leases.every((lease) => lease.status === "task")).toBe(true);
    for (const lease of leases) {
      if (lease.status !== "task") throw new Error("expected a task lease");
      expect(broker.leaseActive(lease.taskId, lease.leaseId, "0.1.2")).toBe(true);
      broker.completeTask(lease.taskId, lease.leaseId, {
        status: "succeeded",
        finalUrl: lease.request.url,
        statusCode: 200,
        contentType: "text/html",
        title: "",
        bodyText: "fixture",
      });
    }
    expect(broker.status()).toMatchObject({ pendingTasks: 0, activeTasks: 0 });
  });
});
