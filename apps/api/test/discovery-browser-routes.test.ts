import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/server.js";
import { initializeExactV7Database } from "./v7-schema.js";

const EXTENSION_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const INSTALLATION_ID = "00000000-0000-4000-8000-000000000099";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-browser-bridge-"));
  dirs.push(dir);
  const dbPath = path.join(dir, "jobctrl.db");
  initializeExactV7Database(dbPath);
  const app = buildApp({
    appDir: dir,
    dbPath,
    configPath: path.join(dir, "config.json"),
    jobUrlValidator: async () => ({ allowed: true }),
  });
  const token = fs.readFileSync(path.join(dir, "extension-capability-token"), "utf8").trim();
  return { app, token, dir };
}

describe("live Discovery browser routes", () => {
  it("rejects a Discovery launch before dispatch when the live extension is offline", async () => {
    const { app } = fixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/pipeline/actions/run-stage",
        payload: { stages: ["discover"], limit: 1 },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        ok: false,
        error: "discovery_extension_unavailable",
      });
      expect(response.json().message).toContain("current Chrome profile");
      expect(response.json().message).toContain("does not use a copied profile");

      const compositeResponse = await app.inject({
        method: "POST",
        url: "/v1/pipeline/actions/run-stage",
        payload: { stages: ["score", "discover"], limit: 1 },
      });
      expect(compositeResponse.statusCode).toBe(503);
      expect(compositeResponse.json()).toMatchObject({
        ok: false,
        error: "discovery_extension_unavailable",
      });

    } finally {
      await app.close();
    }
  });

  it("requires a connected extension, executes a bounded task, and exposes readiness", async () => {
    const { app, token } = fixture();
    const workerHeaders = {
      authorization: `Bearer ${token}`,
      host: "127.0.0.1:8766",
    };
    const extensionHeaders = {
      ...workerHeaders,
      origin: EXTENSION_ORIGIN,
      "sec-fetch-site": "none",
      "x-jobctrl-extension-installation": INSTALLATION_ID,
      "x-jobctrl-extension-version": "0.1.2",
    };
    const payload = {
      taskId: "discover-local:run-1:linkedin-page-1",
      workflowId: "discover-local",
      temporalRunId: "run-1",
      sourceFamily: "jobspy",
      sourceId: "jobspy:linkedin",
      request: {
        mode: "http_request",
        url: "https://www.linkedin.com/jobs-guest/jobs/api/search",
        method: "GET",
        headers: {},
      },
      timeoutMs: 60_000,
    };

    try {
      const unavailable = await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/tasks",
        headers: workerHeaders,
        payload,
      });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toMatchObject({ error: "discovery_extension_unavailable" });

      const claimed = await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/claim",
        headers: extensionHeaders,
        payload: {
          installationId: INSTALLATION_ID,
          extensionVersion: "0.1.2",
          replace: true,
        },
      });
      expect(claimed.statusCode).toBe(200);

      const idle = await app.inject({
        method: "GET",
        url: "/v1/extension/discovery/tasks/next?extensionVersion=0.1.2",
        headers: extensionHeaders,
      });
      expect(idle.statusCode).toBe(200);
      expect(idle.json()).toEqual({ ok: true, status: "idle" });

      const spoofedIdentity = await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/tasks",
        headers: workerHeaders,
        payload: {
          ...payload,
          request: {
            ...payload.request,
            headers: { "Sec-CH-UA": '"Hard-coded browser";v="1"' },
          },
        },
      });
      expect(spoofedIdentity.statusCode).toBe(400);

      const accepted = await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/tasks",
        headers: workerHeaders,
        payload,
      });
      expect(accepted.statusCode).toBe(202);
      expect(accepted.json()).toMatchObject({ status: "pending", taskId: payload.taskId });

      const leased = await app.inject({
        method: "GET",
        url: "/v1/extension/discovery/tasks/next?extensionVersion=0.1.2",
        headers: extensionHeaders,
      });
      const lease = leased.json();
      expect(lease).toMatchObject({ status: "task", taskId: payload.taskId, request: payload.request });

      const heartbeat = await app.inject({
        method: "GET",
        url: `/v1/extension/discovery/tasks/${encodeURIComponent(payload.taskId)}/lease?leaseId=${encodeURIComponent(lease.leaseId)}`,
        headers: extensionHeaders,
      });
      expect(heartbeat.statusCode).toBe(200);
      expect(heartbeat.json()).toEqual({ ok: true, active: true });

      const completed = await app.inject({
        method: "POST",
        url: `/v1/extension/discovery/tasks/${encodeURIComponent(payload.taskId)}/result`,
        headers: extensionHeaders,
        payload: {
          leaseId: lease.leaseId,
          result: {
            status: "succeeded",
            finalUrl: payload.request.url,
            statusCode: 200,
            contentType: "text/html",
            title: "",
            bodyText: "<article>Fixture result</article>",
          },
        },
      });
      expect(completed.statusCode).toBe(200);

      const status = await app.inject({
        method: "GET",
        url: `/v1/extension/discovery/tasks/${encodeURIComponent(payload.taskId)}`,
        headers: workerHeaders,
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        status: "succeeded",
        result: { bodyText: "<article>Fixture result</article>" },
      });

      const readiness = await app.inject({
        method: "GET",
        url: "/v1/discovery/browser-extension/status",
        headers: { host: "127.0.0.1:8766" },
      });
      expect(readiness.json()).toMatchObject({
        ok: true,
        connected: true,
        installationBound: true,
        extensionVersion: "0.1.2",
        pendingTasks: 0,
        activeTasks: 0,
      });
      expect(readiness.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });

  it("does not let an extension-origin request create worker tasks", async () => {
    const { app, token } = fixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/tasks",
        headers: {
          authorization: `Bearer ${token}`,
          host: "127.0.0.1:8766",
          origin: EXTENSION_ORIGIN,
          "sec-fetch-site": "none",
        },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "discovery_browser_worker_required" });
    } finally {
      await app.close();
    }
  });

  it("accepts contract-bounded task and result bodies above Fastify's default parser limit", async () => {
    const { app, token } = fixture();
    const workerHeaders = {
      authorization: `Bearer ${token}`,
      host: "127.0.0.1:8766",
    };
    const extensionHeaders = {
      ...workerHeaders,
      origin: EXTENSION_ORIGIN,
      "sec-fetch-site": "none",
      "x-jobctrl-extension-installation": INSTALLATION_ID,
      "x-jobctrl-extension-version": "0.1.2",
    };
    const taskId = "discover-local:run-large:ats-post";
    const requestBody = "x".repeat(1_100_000);
    const resultBody = "y".repeat(1_100_000);

    try {
      await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/claim",
        headers: extensionHeaders,
        payload: {
          installationId: INSTALLATION_ID,
          extensionVersion: "0.1.2",
          replace: true,
        },
      });

      const accepted = await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/tasks",
        headers: workerHeaders,
        payload: {
          taskId,
          workflowId: "discover-local",
          temporalRunId: "run-large",
          sourceFamily: "ats_api",
          request: {
            mode: "http_request",
            url: "https://example.com/api/jobs",
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestBody,
          },
          timeoutMs: 60_000,
        },
      });
      expect(accepted.statusCode).toBe(202);

      const leased = await app.inject({
        method: "GET",
        url: "/v1/extension/discovery/tasks/next?extensionVersion=0.1.2",
        headers: extensionHeaders,
      });
      const lease = leased.json();
      expect(lease.request.body).toHaveLength(requestBody.length);

      const completed = await app.inject({
        method: "POST",
        url: `/v1/extension/discovery/tasks/${encodeURIComponent(taskId)}/result`,
        headers: extensionHeaders,
        payload: {
          leaseId: lease.leaseId,
          result: {
            status: "succeeded",
            finalUrl: "https://example.com/api/jobs",
            statusCode: 200,
            contentType: "application/json",
            title: "",
            bodyText: resultBody,
          },
        },
      });
      expect(completed.statusCode).toBe(200);

      const status = await app.inject({
        method: "GET",
        url: `/v1/extension/discovery/tasks/${encodeURIComponent(taskId)}`,
        headers: workerHeaders,
      });
      expect(status.json().result.bodyText).toHaveLength(resultBody.length);
    } finally {
      await app.close();
    }
  });

  it("binds leases to exactly one selected Chrome extension installation", async () => {
    const { app, token, dir } = fixture();
    const baseHeaders = {
      authorization: `Bearer ${token}`,
      host: "127.0.0.1:8766",
      origin: EXTENSION_ORIGIN,
      "sec-fetch-site": "none",
      "x-jobctrl-extension-version": "0.1.2",
    };
    const selected = INSTALLATION_ID;
    const other = "00000000-0000-4000-8000-000000000098";
    try {
      const automaticClaim = await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/claim",
        headers: baseHeaders,
        payload: { installationId: selected, extensionVersion: "0.1.2", replace: false },
      });
      expect(automaticClaim.statusCode).toBe(409);
      expect(automaticClaim.json()).toMatchObject({
        error: "discovery_extension_selection_required",
      });

      const firstClaim = await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/claim",
        headers: baseHeaders,
        payload: { installationId: selected, extensionVersion: "0.1.2", replace: true },
      });
      expect(firstClaim.statusCode).toBe(200);
      const selectedPath = path.join(dir, "extension-discovery-installation-id");
      expect(fs.readFileSync(selectedPath, "utf8").trim()).toBe(selected);
      expect(fs.statSync(selectedPath).mode & 0o777).toBe(0o600);

      const otherPoll = await app.inject({
        method: "GET",
        url: "/v1/extension/discovery/tasks/next?extensionVersion=0.1.2",
        headers: { ...baseHeaders, "x-jobctrl-extension-installation": other },
      });
      expect(otherPoll.statusCode).toBe(409);
      expect(otherPoll.json()).toMatchObject({ error: "discovery_extension_not_selected" });

      const conflictingClaim = await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/claim",
        headers: baseHeaders,
        payload: { installationId: other, extensionVersion: "0.1.2", replace: false },
      });
      expect(conflictingClaim.statusCode).toBe(409);

      const replacement = await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/claim",
        headers: baseHeaders,
        payload: { installationId: other, extensionVersion: "0.1.2", replace: true },
      });
      expect(replacement.statusCode).toBe(200);

      const oldPoll = await app.inject({
        method: "GET",
        url: "/v1/extension/discovery/tasks/next?extensionVersion=0.1.2",
        headers: { ...baseHeaders, "x-jobctrl-extension-installation": selected },
      });
      expect(oldPoll.statusCode).toBe(409);
      const newPoll = await app.inject({
        method: "GET",
        url: "/v1/extension/discovery/tasks/next?extensionVersion=0.1.2",
        headers: { ...baseHeaders, "x-jobctrl-extension-installation": other },
      });
      expect(newPoll.statusCode).toBe(200);
      expect(newPoll.json()).toEqual({ ok: true, status: "idle" });

      const rotated = await app.inject({
        method: "POST",
        url: "/v1/extension/pairing-token/rotate",
        headers: {
          origin: "http://127.0.0.1:5173",
          "sec-fetch-site": "same-origin",
        },
        payload: {},
      });
      expect(rotated.statusCode).toBe(200);
      expect(fs.existsSync(selectedPath)).toBe(false);
      const afterRotation = await app.inject({
        method: "GET",
        url: "/v1/discovery/browser-extension/status",
      });
      expect(afterRotation.json()).toMatchObject({
        connected: false,
        installationBound: false,
        installationIdSuffix: null,
      });
    } finally {
      await app.close();
    }
  });

  it("does not return a lease to an installation replaced during lease-time validation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-browser-selection-race-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactV7Database(dbPath);
    let validationCount = 0;
    let releaseLeaseValidation: () => void = () => undefined;
    const leaseValidationGate = new Promise<void>((resolve) => {
      releaseLeaseValidation = resolve;
    });
    let signalLeaseValidationStarted: () => void = () => undefined;
    const leaseValidationStarted = new Promise<void>((resolve) => {
      signalLeaseValidationStarted = resolve;
    });
    const app = buildApp({
      appDir: dir,
      dbPath,
      configPath: path.join(dir, "config.json"),
      jobUrlValidator: async () => {
        validationCount += 1;
        if (validationCount === 2) {
          signalLeaseValidationStarted();
          await leaseValidationGate;
        }
        return { allowed: true };
      },
    });
    const token = fs.readFileSync(path.join(dir, "extension-capability-token"), "utf8").trim();
    const workerHeaders = { authorization: `Bearer ${token}`, host: "127.0.0.1:8766" };
    const selected = INSTALLATION_ID;
    const replacement = "00000000-0000-4000-8000-000000000098";
    const baseExtensionHeaders = {
      ...workerHeaders,
      origin: EXTENSION_ORIGIN,
      "sec-fetch-site": "none",
      "x-jobctrl-extension-version": "0.1.2",
    };
    try {
      const firstClaim = await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/claim",
        headers: {
          ...baseExtensionHeaders,
          "x-jobctrl-extension-installation": selected,
        },
        payload: { installationId: selected, extensionVersion: "0.1.2", replace: true },
      });
      expect(firstClaim.statusCode).toBe(200);

      const accepted = await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/tasks",
        headers: workerHeaders,
        payload: {
          taskId: "discover-local:selection-race",
          workflowId: "discover-local",
          temporalRunId: "run-selection-race",
          sourceFamily: "smartextract",
          request: { mode: "rendered_page", url: "https://careers.example.test/jobs" },
          timeoutMs: 60_000,
        },
      });
      expect(accepted.statusCode).toBe(202);

      const staleLeasePromise = app.inject({
        method: "GET",
        url: "/v1/extension/discovery/tasks/next?extensionVersion=0.1.2",
        headers: {
          ...baseExtensionHeaders,
          "x-jobctrl-extension-installation": selected,
        },
      });
      await leaseValidationStarted;

      const replacementClaim = await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/claim",
        headers: {
          ...baseExtensionHeaders,
          "x-jobctrl-extension-installation": replacement,
        },
        payload: { installationId: replacement, extensionVersion: "0.1.2", replace: true },
      });
      expect(replacementClaim.statusCode).toBe(200);
      releaseLeaseValidation();

      const staleLease = await staleLeasePromise;
      expect(staleLease.statusCode).toBe(409);
      expect(staleLease.json()).toMatchObject({ error: "discovery_extension_not_selected" });

      const replacementPoll = await app.inject({
        method: "GET",
        url: "/v1/extension/discovery/tasks/next?extensionVersion=0.1.2",
        headers: {
          ...baseExtensionHeaders,
          "x-jobctrl-extension-installation": replacement,
        },
      });
      expect(replacementPoll.statusCode).toBe(200);
      expect(replacementPoll.json()).toEqual({ ok: true, status: "idle" });
    } finally {
      releaseLeaseValidation();
      await app.close();
    }
  });

  it("does not accept a result from an installation replaced during result validation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-browser-result-selection-race-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactV7Database(dbPath);
    let validationCount = 0;
    let releaseResultValidation: () => void = () => undefined;
    const resultValidationGate = new Promise<void>((resolve) => {
      releaseResultValidation = resolve;
    });
    let signalResultValidationStarted: () => void = () => undefined;
    const resultValidationStarted = new Promise<void>((resolve) => {
      signalResultValidationStarted = resolve;
    });
    const app = buildApp({
      appDir: dir,
      dbPath,
      configPath: path.join(dir, "config.json"),
      jobUrlValidator: async () => {
        validationCount += 1;
        if (validationCount === 3) {
          signalResultValidationStarted();
          await resultValidationGate;
        }
        return { allowed: true };
      },
    });
    const token = fs.readFileSync(path.join(dir, "extension-capability-token"), "utf8").trim();
    const workerHeaders = { authorization: `Bearer ${token}`, host: "127.0.0.1:8766" };
    const selected = INSTALLATION_ID;
    const replacement = "00000000-0000-4000-8000-000000000098";
    const baseExtensionHeaders = {
      ...workerHeaders,
      origin: EXTENSION_ORIGIN,
      "sec-fetch-site": "none",
      "x-jobctrl-extension-version": "0.1.2",
    };
    try {
      const firstClaim = await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/claim",
        headers: {
          ...baseExtensionHeaders,
          "x-jobctrl-extension-installation": selected,
        },
        payload: { installationId: selected, extensionVersion: "0.1.2", replace: true },
      });
      expect(firstClaim.statusCode).toBe(200);

      const taskId = "discover-local:result-selection-race";
      const accepted = await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/tasks",
        headers: workerHeaders,
        payload: {
          taskId,
          workflowId: "discover-local",
          temporalRunId: "run-result-selection-race",
          sourceFamily: "ats_api",
          request: {
            mode: "http_request",
            url: "https://careers.example.test/api/jobs",
            method: "GET",
            headers: {},
          },
          timeoutMs: 60_000,
        },
      });
      expect(accepted.statusCode).toBe(202);
      const leased = await app.inject({
        method: "GET",
        url: "/v1/extension/discovery/tasks/next?extensionVersion=0.1.2",
        headers: {
          ...baseExtensionHeaders,
          "x-jobctrl-extension-installation": selected,
        },
      });
      expect(leased.statusCode).toBe(200);
      const lease = leased.json();
      expect(lease).toMatchObject({ status: "task", taskId });

      const staleResultPromise = app.inject({
        method: "POST",
        url: `/v1/extension/discovery/tasks/${encodeURIComponent(taskId)}/result`,
        headers: {
          ...baseExtensionHeaders,
          "x-jobctrl-extension-installation": selected,
        },
        payload: {
          leaseId: lease.leaseId,
          result: {
            status: "succeeded",
            finalUrl: "https://careers.example.test/api/jobs",
            statusCode: 200,
            contentType: "application/json",
            title: "",
            bodyText: "[]",
          },
        },
      });
      await resultValidationStarted;

      const replacementClaim = await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/claim",
        headers: {
          ...baseExtensionHeaders,
          "x-jobctrl-extension-installation": replacement,
        },
        payload: { installationId: replacement, extensionVersion: "0.1.2", replace: true },
      });
      expect(replacementClaim.statusCode).toBe(200);
      releaseResultValidation();

      const staleResult = await staleResultPromise;
      expect(staleResult.statusCode).toBe(409);
      expect(staleResult.json()).toMatchObject({ error: "discovery_extension_not_selected" });
    } finally {
      releaseResultValidation();
      await app.close();
    }
  });

  it("rejects multibyte request content that exceeds the UTF-8 byte contract", async () => {
    const { app, token } = fixture();
    const workerHeaders = {
      authorization: `Bearer ${token}`,
      host: "127.0.0.1:8766",
    };
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/tasks",
        headers: workerHeaders,
        payload: {
          taskId: "discover-local:multibyte",
          workflowId: "discover-local",
          temporalRunId: "run-multibyte",
          sourceFamily: "ats_api",
          request: {
            mode: "http_request",
            url: "https://example.com/api/jobs",
            method: "POST",
            headers: {},
            body: "界".repeat(700_000),
          },
          timeoutMs: 60_000,
        },
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("revalidates DNS at lease time before Chrome receives a queued destination", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-browser-rebind-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactV7Database(dbPath);
    let validationCount = 0;
    const app = buildApp({
      appDir: dir,
      dbPath,
      configPath: path.join(dir, "config.json"),
      jobUrlValidator: async () => ({
        allowed: ++validationCount === 1,
        ...(validationCount > 1 ? { reason: "URL host now resolves to a non-public address." } : {}),
      }),
    });
    const token = fs.readFileSync(path.join(dir, "extension-capability-token"), "utf8").trim();
    const workerHeaders = { authorization: `Bearer ${token}`, host: "127.0.0.1:8766" };
    const extensionHeaders = {
      ...workerHeaders,
      origin: EXTENSION_ORIGIN,
      "sec-fetch-site": "none",
      "x-jobctrl-extension-installation": INSTALLATION_ID,
      "x-jobctrl-extension-version": "0.1.2",
    };
    const taskId = "discover-local:dns-rebind";
    try {
      await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/claim",
        headers: extensionHeaders,
        payload: {
          installationId: INSTALLATION_ID,
          extensionVersion: "0.1.2",
          replace: true,
        },
      });
      const accepted = await app.inject({
        method: "POST",
        url: "/v1/extension/discovery/tasks",
        headers: workerHeaders,
        payload: {
          taskId,
          workflowId: "discover-local",
          temporalRunId: "run-rebind",
          sourceFamily: "smartextract",
          request: { mode: "rendered_page", url: "https://careers.example.test/jobs" },
          timeoutMs: 60_000,
        },
      });
      expect(accepted.statusCode).toBe(202);

      const lease = await app.inject({
        method: "GET",
        url: "/v1/extension/discovery/tasks/next?extensionVersion=0.1.2",
        headers: extensionHeaders,
      });
      expect(lease.statusCode).toBe(200);
      expect(lease.json()).toEqual({ ok: true, status: "idle" });
      expect(validationCount).toBe(2);

      const taskStatus = await app.inject({
        method: "GET",
        url: `/v1/extension/discovery/tasks/${encodeURIComponent(taskId)}`,
        headers: workerHeaders,
      });
      expect(taskStatus.json()).toMatchObject({
        status: "failed",
        result: { status: "failed", errorCode: "unsafe_redirect", retryable: false },
      });
    } finally {
      await app.close();
    }
  });
});
