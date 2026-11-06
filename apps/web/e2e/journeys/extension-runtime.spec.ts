import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rmdir } from "node:fs/promises";
import path from "node:path";
import type { APIRequest, APIRequestContext } from "@playwright/test";

import {
  test,
  expect,
  json,
  modelCall,
  action,
  terminal,
  type ApplicationStack,
  type ExternalCall,
} from "../harness/fixtures.js";

test.use({ features: "profile,jobs,discovery" });

const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const title = "Synthetic Extension Reliability Engineer";
const employer = "Synthetic Extension Employer";
const description =
  "Maintain durable workflow recovery, document service ownership, and review operational changes.";

type Source = { source_id: string; text: string };
type Pairing = { ok: true; token: string };
type Bridge = {
  installationBound: boolean;
  connected: boolean;
  lastSeenAt: string | null;
  pendingTasks: number;
  activeTasks: number;
};
type Acknowledgement = {
  ok: true;
  itemId: string;
  jobKey: string;
  importedAt: string;
  provenance: { futureManualActionRequired: boolean };
};

function captureFixture(slug: string) {
  const url = `https://example.com/jobs/${slug}`;
  const structured = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    url,
    title,
    description,
    hiringOrganization: { "@type": "Organization", name: employer },
    jobLocationType: "TELECOMMUTE",
  };
  const html = `<html><head><script type="application/ld+json">${JSON.stringify(structured)}</script></head><body><h1>${title}</h1><p>${employer}</p><p>${description}</p><a href="${url}/apply">Apply</a></body></html>`;
  return { url, html };
}

function source(call: ExternalCall, id: string): Source {
  const found = (call.body["sources"] as Source[]).find(
    (item) => item.source_id === id,
  );
  expect(found, `the actual model request contains source ${id}`).toBeDefined();
  return found!;
}

function citation(call: ExternalCall, id: string) {
  const row = source(call, id);
  return { source_id: row.source_id, quote: row.text };
}

async function respondToCapturedPosting(app: ApplicationStack, beforeReply?: () => Promise<void>) {
  const interpretation = await modelCall(app, "page_interpretation");
  await beforeReply?.();
  const page = citation(interpretation, "rendered_page");
  const field = (value: string) => ({
    value,
    citations: [page],
    rationale: "Explicit source-bound decision for this authored capture.",
  });
  interpretation.reply({
    availability: field("unknown"),
    page_kind: field("posting"),
    access_state: field("clear"),
    apply_control: field("available"),
  });

  const extraction = await modelCall(app, "posting_extraction");
  const inventory = (
    extraction.body["context"] as {
      line_inventory: {
        source_id: string;
        lines: { line_id: string; text: string }[];
      }[];
    }
  ).line_inventory.find(
    (item) => item.source_id === "posting:0:description",
  );
  expect(inventory).toBeDefined();
  expect(source(extraction, "posting:0:description").text).toBe(description);
  const copied = (id: string, value: string) => ({
    value,
    citations: [citation(extraction, id)],
    rationale: "Copy this explicitly selected authored source field.",
  });
  extraction.reply({
    title: copied("posting:0:title", title),
    employer: copied("posting:0:employer", employer),
    description: {
      source_id: "posting:0:description",
      first_line_id: inventory!.lines[0]!.line_id,
      last_line_id: inventory!.lines.at(-1)!.line_id,
      rationale: "Select the entire captured structured description.",
      value: null,
      citations: [],
    },
    location: copied("posting:0:location", "Remote"),
    salary: {
      value: "",
      citations: [],
      rationale: "This authored capture contains no salary field.",
    },
    application_url: copied(
      "link:0:url",
      source(extraction, "link:0:url").text,
    ),
    source_origins: [],
  });
  const quality = await modelCall(app, "description_quality");
  expect(source(quality, "description").text).toBe(description);
  quality.reply({
    confidence: "high",
    citations: [citation(quality, "description")],
    rationale:
      "The explicitly authored capture supplies one complete posting description.",
  });
}

async function extensionClient(
  request: APIRequest,
  app: ApplicationStack,
  token?: string,
) {
  return request.newContext({
    baseURL: app.baseURL,
    extraHTTPHeaders: {
      Origin: extensionOrigin,
      "Sec-Fetch-Site": "cross-site",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function pairingToken(api: APIRequestContext): Promise<Pairing> {
  const response = await api.get("/v1/extension/pairing-token", { headers: { "Sec-Fetch-Site": "same-origin" } });
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<Pairing>;
}

async function claim(client: APIRequestContext, installationId: string) {
  return json(client, "post", "/v1/extension/discovery/claim", {
    installationId,
    extensionVersion: "synthetic-e2e",
    replace: true,
  });
}

async function dns(app: ApplicationStack, addresses = ["1.1.1.1"]) {
  const request = await app.external.next();
  expect(request.method).toBe("POST");
  expect(request.path).toBe("/dns");
  expect(request.body).toEqual({ hostname: "example.com" });
  request.respond({ addresses });
}

test("extension pairing is local, first-party status works, and token rotation revokes the old installation", async ({
  app,
  api,
  playwright,
}) => {
  const sameOrigin = await playwright.request.newContext({
    baseURL: app.baseURL,
    extraHTTPHeaders: { "Sec-Fetch-Site": "same-origin" },
  });
  const unpaired = await extensionClient(playwright.request, app);
  let paired: APIRequestContext | undefined;
  try {
    // A real same-origin browser GET omits Origin and may omit Referer under
    // the application's no-referrer policy. It still reads actual status.
    const pairing = await json<Pairing>(
      sameOrigin,
      "get",
      "/v1/extension/pairing-token",
    );
    const status = await json<Bridge>(
      sameOrigin,
      "get",
      "/v1/discovery/browser-extension/status",
    );
    expect(status.installationBound).toBe(false);
    const diagnostic = await app.cli(["doctor", "--json"]);
    expect(diagnostic.exitCode, diagnostic.stderr).toBe(0);
    const readiness = JSON.parse(diagnostic.stdout) as {
      browserCapabilities: { id: string; status: string; detail: string }[];
    };
    const coreBrowser = readiness.browserCapabilities.find(
      (capability) => capability.id === "core-browser",
    );
    expect(coreBrowser, JSON.stringify(readiness.browserCapabilities)).toBeDefined();
    expect(coreBrowser?.status, coreBrowser?.detail).toBe("ready");
    expect((await unpaired.get("/v1/extension/auth/status")).status()).toBe(401);
    expect((await unpaired.get("/v1/extension/pairing-token")).status()).toBeGreaterThanOrEqual(400);
    const pairedClient = await extensionClient(playwright.request, app, pairing.token);
    paired = pairedClient;
    const auth = await json<{ authenticated: boolean; capabilities: string[] }>(
      pairedClient,
      "get",
      "/v1/extension/auth/status",
    );
    expect(auth.authenticated).toBe(true);
    expect(auth.capabilities).toContain("capture");
    const installation = randomUUID();
    await claim(pairedClient, installation);
    expect(
      (await json<Bridge>(sameOrigin, "get", "/v1/discovery/browser-extension/status"))
        .installationBound,
    ).toBe(true);
    const hostile = await playwright.request.newContext({
      baseURL: app.baseURL,
      extraHTTPHeaders: {
        Origin: "https://untrusted.example",
        Authorization: `Bearer ${pairing.token}`,
      },
    });
    try {
      expect(
        (await hostile.post("/v1/extension/discovery/claim", {
          data: { installationId: randomUUID(), extensionVersion: "hostile", replace: true },
        })).status(),
      ).toBe(403);
    } finally {
      await hostile.dispose();
    }
    // Corrupt only an owned EXTERNAL capability-file boundary. A failed
    // rotation must preserve the still-accepted installation and old bytes.
    const tokenPath = path.join(app.workspace, "extension-capability-token");
    const retainedTokenPath = path.join(app.workspace, ".token-before-rotation");
    await rename(tokenPath, retainedTokenPath);
    await mkdir(tokenPath, { mode: 0o700 });
    try {
      const refused = await api.post("/v1/extension/pairing-token/rotate", { headers: { "Sec-Fetch-Site": "same-origin" }, data: {} });
      expect(refused.status()).toBe(503);
      expect((await json<Bridge>(sameOrigin, "get", "/v1/discovery/browser-extension/status")).installationBound).toBe(true);
    } finally {
      await rmdir(tokenPath);
      await rename(retainedTokenPath, tokenPath);
    }
    const rotating = await api.post("/v1/extension/pairing-token/rotate", { headers: { "Sec-Fetch-Site": "same-origin" }, data: {} });
    expect(rotating.status(), await rotating.text()).toBe(200);
    const rotated = await rotating.json() as Pairing;
    expect(rotated.token).not.toBe(pairing.token);
    expect((await pairedClient.get("/v1/extension/auth/status")).status()).toBe(401);
    const disconnected = await json<Bridge>(
      sameOrigin,
      "get",
      "/v1/discovery/browser-extension/status",
    );
    expect(disconnected.installationBound).toBe(false);
    expect(disconnected.connected).toBe(false);
  } finally {
    await paired?.dispose();
    await unpaired.dispose();
    await sameOrigin.dispose();
  }
});

test("extension capture keeps canonical provenance and stable replay across worker restart", async ({
  app,
  api,
  playwright,
}) => {
  const pairing = await pairingToken(api);
  const client = await extensionClient(playwright.request, app, pairing.token);
  const fixture = captureFixture("stable-extension-capture");
  const captureId = "capture:" + randomUUID();
  const body = {
    captureId,
    originatingUrl: fixture.url,
    capturedUrl: fixture.url,
    captureMode: "saved_html",
    contentHtmlBase64: Buffer.from(fixture.html).toString("base64"),
    futureManualActionRequired: true,
    captureClient: "browser_extension",
    extensionVersion: "synthetic-e2e",
  };
  try {
    const importing = client.post("/v1/extension/captures", { data: body });
    const [accepted] = await Promise.all([
      importing,
      respondToCapturedPosting(app, async () => {
        const concurrent = await client.post("/v1/extension/captures", { data: body });
        expect(concurrent.status()).toBe(409);
        expect((await concurrent.json()).error.code).toBe("extension_capture_in_progress");
      }),
    ]);
    expect(accepted.status(), await accepted.text()).toBe(200);
    const acknowledgement = await accepted.json() as Acknowledgement;
    expect(acknowledgement.itemId).toBe(
      "extension:" + createHash("sha256").update(captureId).digest("hex").slice(0, 32),
    );
    expect(acknowledgement.provenance.futureManualActionRequired).toBe(true);
    const posting = await json<{
      job_id: string;
      revision: number;
      provenance: { captureProvenance: { originatingUrl: string; futureManualActionRequired: boolean } };
    }>(api, "get", `/v1/jobs/${acknowledgement.jobKey}`);
    expect(posting.job_id).toBe(acknowledgement.jobKey);
    expect(posting.provenance.captureProvenance).toMatchObject({
      originatingUrl: fixture.url,
      futureManualActionRequired: true,
    });
    const calls = app.external.calls.length;
    const replay = await json<Acknowledgement>(client, "post", "/v1/extension/captures", body);
    expect(replay).toEqual(acknowledgement);
    expect(app.external.calls).toHaveLength(calls);
    const changed = await client.post("/v1/extension/captures", {
      data: { ...body, contentText: "A different capture cannot reuse this identity." },
    });
    expect(changed.status()).toBe(409);
    expect((await changed.json()).error.code).toBe("extension_capture_superseded");
    expect((await json<{ revision: number }>(api, "get", `/v1/jobs/${posting.job_id}`)).revision).toBe(posting.revision);
    const restarted = await app.restartWorker();
    expect(restarted.current).not.toBe(restarted.previous);
    expect(await json<Acknowledgement>(client, "post", "/v1/extension/captures", body)).toEqual(acknowledgement);
    expect(app.external.calls).toHaveLength(calls);
  } finally {
    await client.dispose();
  }
});

test("pending browser tasks survive HEAD, lease once, reject private DNS and fence cancellation", async ({
  app,
  api,
  playwright,
}) => {
  const pairing = await pairingToken(api);
  const extension = await extensionClient(playwright.request, app, pairing.token);
  const worker = await playwright.request.newContext({
    baseURL: app.baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${pairing.token}` },
  });
  const installation = randomUUID();
  const extensionHeaders = {
    "x-jobctrl-extension-installation": installation,
    "x-jobctrl-extension-version": "synthetic-e2e",
  };
  let held: ExternalCall | undefined;
  let runId: string | undefined;
  try {
    await claim(extension, installation);
    const fixture = captureFixture("active-browser-parent");
    const submitted = await action(api, "jobs.capture_url", { url: fixture.url, html: fixture.html });
    runId = submitted.runId;
    held = await modelCall(app, "page_interpretation");
    const running = await json<{ status: string; workflowId: string; temporalRunId: string }>(
      api, "get", `/v1/action-runs/${runId}`,
    );
    expect(running.status).toBe("running");
    expect(running.temporalRunId).toBeTruthy();
    const envelope = {
      runId,
      workflowId: running.workflowId,
      temporalRunId: running.temporalRunId,
      sourceId: "synthetic-extension-source",
      sourceFamily: "enrichment",
      request: { mode: "rendered_page", url: fixture.url },
      timeoutMs: 120_000,
    };
    // Only the local worker may administer tasks, even with a valid Chrome token.
    expect((await extension.post("/v1/extension/discovery/tasks", {
      data: { ...envelope, taskId: "forbidden:" + randomUUID() },
    })).status()).toBe(403);
    const rejected = worker.post("/v1/extension/discovery/tasks", {
      data: { ...envelope, taskId: "private-dns:" + randomUUID() },
    });
    await dns(app, ["127.0.0.1"]);
    expect((await rejected).status()).toBe(400);
    const taskId = "browser:" + randomUUID();
    const creating = worker.post("/v1/extension/discovery/tasks", {
      data: { ...envelope, taskId },
    });
    await dns(app);
    expect((await creating).status()).toBe(201);
    const before = await json<Bridge>(api, "get", "/v1/discovery/browser-extension/status");
    expect(before.pendingTasks).toBe(1);
    const calls = app.external.calls.length;
    for (let index = 0; index < 5; index += 1) {
      const response = await extension.head("/v1/extension/discovery/tasks/next", { headers: extensionHeaders });
      expect(response.status()).toBe(200);
      expect((await response.body()).length).toBe(0);
    }
    const after = await json<Bridge>(api, "get", "/v1/discovery/browser-extension/status");
    expect(after.lastSeenAt).toBe(before.lastSeenAt);
    expect(after.pendingTasks).toBe(1);
    expect(after.activeTasks).toBe(0);
    expect(app.external.calls).toHaveLength(calls);
    expect((await json<{ status: string }>(worker, "get", `/v1/extension/discovery/tasks/${taskId}`)).status).toBe("pending");
    const polling = extension.get("/v1/extension/discovery/tasks/next", { headers: extensionHeaders });
    await dns(app);
    const leasedResponse = await polling;
    expect(leasedResponse.status()).toBe(200);
    const leased = await leasedResponse.json() as { status: string; taskId: string; leaseId: string };
    expect(leased.status).toBe("task");
    expect(leased.taskId).toBe(taskId);
    const nextPoll = await extension.get("/v1/extension/discovery/tasks/next", { headers: extensionHeaders });
    expect((await nextPoll.json()).status).toBe("idle");
    const active = await extension.get(`/v1/extension/discovery/tasks/${taskId}/lease?leaseId=${leased.leaseId}`, { headers: extensionHeaders });
    expect((await active.json()).active).toBe(true);
    const delayedTaskId = "browser:dns-delay:" + randomUUID();
    const delayedCreation = worker.post("/v1/extension/discovery/tasks", {
      data: { ...envelope, taskId: delayedTaskId },
    });
    await dns(app);
    expect((await delayedCreation).status()).toBe(201);
    const delayedPoll = extension.get("/v1/extension/discovery/tasks/next", { headers: extensionHeaders });
    const delayedDns = await app.external.next();
    expect(delayedDns.method).toBe("POST");
    expect(delayedDns.path).toBe("/dns");
    expect(delayedDns.body).toEqual({ hostname: "example.com" });
    await json(api, "post", `/v1/action-runs/${runId}/cancel`, {});
    held.disconnect();
    expect(delayedDns.closed).not.toBe(true);
    delayedDns.respond({ addresses: ["1.1.1.1"] });
    expect((await (await delayedPoll).json()).status).toBe("idle");
    await terminal(api, runId);
    expect((await json<{ status: string }>(worker, "get", `/v1/extension/discovery/tasks/${delayedTaskId}`)).status).toBe("failed");
    const inactive = await extension.get(`/v1/extension/discovery/tasks/${taskId}/lease?leaseId=${leased.leaseId}`, { headers: extensionHeaders });
    expect((await inactive.json()).active).toBe(false);
    const late = await extension.post(`/v1/extension/discovery/tasks/${taskId}/result`, {
      headers: extensionHeaders,
      data: { leaseId: leased.leaseId, result: { status: "failed", errorCode: "request_failed", message: "Late result", retryable: false } },
    });
    expect(late.status()).toBe(409);
    expect((await json<{ status: string }>(worker, "get", `/v1/extension/discovery/tasks/${taskId}`)).status).toBe("failed");
  } finally {
    if (runId) {
      await api.post(`/v1/action-runs/${runId}/cancel`, { data: {} });
    }
    held?.disconnect();
    await extension.dispose();
    await worker.dispose();
  }
});
