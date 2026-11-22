import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rmdir } from "node:fs/promises";
import path from "node:path";
import type { APIRequest, APIRequestContext } from "@playwright/test";

import {
  test,
  expect,
  json,
  modelCall,
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

test("extension pairing authorizes capture and token rotation revokes the old token", async ({ app, api, playwright }) => {
  const initial = await pairingToken(api);
  const unpaired = await extensionClient(playwright.request, app);
  const paired = await extensionClient(playwright.request, app, initial.token);
  const hostile = await playwright.request.newContext({ baseURL: app.baseURL,
    extraHTTPHeaders: { Origin: "https://untrusted.example", Authorization: `Bearer ${initial.token}` } });
  try {
    expect((await unpaired.get("/v1/extension/auth/status")).status()).toBe(401);
    expect((await paired.get("/v1/extension/pairing-token")).status()).toBe(401);
    expect((await hostile.post("/v1/extension/captures", { data: {} })).status()).toBe(403);
    expect(await json(paired, "get", "/v1/extension/auth/status")).toMatchObject({ authenticated: true, capabilities: ["capture"] });
    expect((await paired.post("/v1/extension/discovery/claim", { data: {} })).status()).toBe(404);
    const tokenPath = path.join(app.workspace, "extension-capability-token");
    const saved = path.join(app.workspace, ".token-before-rotation");
    await rename(tokenPath, saved);
    await mkdir(tokenPath, { mode: 0o700 });
    try {
      expect((await api.post("/v1/extension/pairing-token/rotate", { headers: { "Sec-Fetch-Site": "same-origin" }, data: {} })).status()).toBe(503);
    } finally {
      await rmdir(tokenPath);
      await rename(saved, tokenPath);
    }
    expect((await paired.get("/v1/extension/auth/status")).status()).toBe(200);
    const rotation = await api.post("/v1/extension/pairing-token/rotate", { headers: { "Sec-Fetch-Site": "same-origin" }, data: {} });
    expect(rotation.status()).toBe(200);
    const rotated = await rotation.json() as Pairing;
    expect(rotated.token).not.toBe(initial.token);
    expect((await paired.get("/v1/extension/auth/status")).status()).toBe(401);
  } finally {
    await Promise.all([unpaired.dispose(), paired.dispose(), hostile.dispose()]);
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
