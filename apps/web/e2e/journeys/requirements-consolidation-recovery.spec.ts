import type { APIResponse, Request, Response, Route } from "@playwright/test";
import { expect, json, modelCall, terminal, test } from "../harness/fixtures.js";
import { acceptBaseline } from "./core-data.js";
import { acceptedPdf, readCatalog, requirementsPath } from "./consolidation-data.js";
import { createScoredFit } from "./fit-data.js";

const action = "requirements.consolidate";
const startPath = `/v1/actions/${action}`;
const lookupPath = `/v1/action-runs/by-idempotency-key?action=${action}`;
const recoveryKey = (scope: "catalog" | "earlier-catalog") =>
  `jobctrl:request-recovery:local:${encodeURIComponent(JSON.stringify(["local", action, scope]))}`;

for (const legacy of [false, true]) {
  test(legacy
    ? "an interrupted older consolidation retains its key when using the current skills catalog"
    : "an interrupted consolidation retries the frozen catalog revision and handles a definitive refusal", async ({
    page, api, app, allowRequestFailure, allowResponseError,
  }) => {
    const workspace = await json<{ databaseInstanceId: string }>(api, "get", "/v1/health");
    const original = await readCatalog(api);
    expect(original.normalization.ready).toBe(false);
    let interrupted: Request | undefined;
    const startRequest = (url: URL) => url.origin === app.baseURL && url.pathname === startPath;
    const dropBeforeAdmission = async (route: Route) => {
      interrupted = route.request();
      await route.abort("failed");
    };
    const lookupRequest = (url: URL) => url.href === app.baseURL + lookupPath;
    const forwarded = new Map<Request, APIResponse>();
    const lookupChecks: Promise<void>[] = [];
    const lookupCheckErrors: unknown[] = [];
    const forwardLookup = async (route: Route) => {
      const upstream = await route.fetch();
      if (upstream.status() === 404) {
        // Retain the real API response for assertion. Chromium can release its
        // own copy when the browser reloads while checking an absent key.
        forwarded.set(route.request(), upstream);
      }
      try {
        await route.fulfill({ response: upstream });
      } finally {
        if (!forwarded.has(route.request())) await upstream.dispose();
      }
    };
    const watchLookups = (response: Response) => {
      if (!lookupRequest(new URL(response.url())) || response.status() !== 404) return;
      const idempotencyKey = interrupted?.headers()["idempotency-key"];
      const upstream = forwarded.get(response.request());
      if (!idempotencyKey || !upstream) {
        lookupCheckErrors.push(new Error("The exact interrupted request and canonical response were not observed"));
        return;
      }
      lookupChecks.push(allowResponseError(response, {
        method: "GET", status: 404, code: "not_found", action, idempotencyKey,
        databaseInstanceId: workspace.databaseInstanceId,
      }, upstream).catch((error: unknown) => { lookupCheckErrors.push(error); }));
    };
    const checkLookups = async () => {
      await Promise.all(lookupChecks);
      expect(lookupCheckErrors, "Every absent lookup belongs to the exact interrupted request").toEqual([]);
    };
    page.on("response", watchLookups);
    await page.route(lookupRequest, forwardLookup);
    await page.goto("/requirements");
    const panel = page.getByRole("region", { name: "Skill consolidation", exact: true });
    const failedRequest = page.waitForEvent("requestfailed", (request) => startRequest(new URL(request.url())));
    await page.route(startRequest, dropBeforeAdmission, { times: 1 });
    await panel.getByRole("button", { name: "Consolidate skills", exact: true }).click();
    allowRequestFailure(await failedRequest, "net::ERR_FAILED");
    expect(interrupted?.postDataJSON()).toEqual({ expected_catalog_revision: original.catalog_revision });
    const admissionHeaders = interrupted!.headers();
    const idempotencyKey = admissionHeaders["idempotency-key"]!;
    expect(idempotencyKey).toBeTruthy();
    expect(admissionHeaders["expected-database-instance-id"]).toBe(workspace.databaseInstanceId);
    const lookup = () => api.get(lookupPath, { headers: { "Idempotency-Key": idempotencyKey } });
    expect((await lookup()).status()).toBe(404);

    if (legacy) {
      // Recreate the earlier browser's saved identity shape while keeping the
      // real request fingerprint and application state.
      const removed = await page.evaluate((key) => {
        const stored = sessionStorage.getItem(key);
        if (!stored) throw new Error("The real earlier request identity was not retained");
        const { sourceRevision, ...legacyIdentity } = JSON.parse(stored);
        sessionStorage.setItem(key, JSON.stringify(legacyIdentity));
        return { sourceRevision, requestId: legacyIdentity.requestId } as { sourceRevision: number; requestId: string };
      }, recoveryKey("catalog"));
      expect(removed).toEqual({ sourceRevision: original.catalog_revision, requestId: idempotencyKey });
    }

    const seed = await createScoredFit(api, app, legacy ? "legacy-consolidation-recovery" : "consolidation-recovery");
    const current = await readCatalog(api);
    expect(current.catalog_revision).toBeGreaterThan(original.catalog_revision);
    expect(current.normalization.ready).toBe(true);
    const accepted = await acceptBaseline(api, seed.posting.job_id, seed.profile.profileVersion);
    const pdf = await acceptedPdf(api, accepted.resume_id);
    const requirements = await json(api, "get", requirementsPath(seed.posting.job_id));
    const initialCalls = app.external.calls.length;
    await checkLookups();
    await page.reload();
    await expect(panel.getByText(/No run has been recorded for this request/)).toBeVisible();
    try {
      if (legacy) {
        await panel.getByRole("button", { name: "Use current catalog", exact: true }).click();
        await expect(panel.getByText(/No run has been recorded for the earlier request/)).toBeVisible();
        await checkLookups();
        await page.reload();
        await expect(panel.getByText(/No run has been recorded for the earlier request/)).toBeVisible();
        const earlier = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!), recoveryKey("earlier-catalog"));
        expect(earlier.requestId).toBe(idempotencyKey);

        // A new request for the current catalog exposes a durable receipt.
        // The delayed earlier request cannot acquire a second scope.
        const admitted = await api.post(startPath, { data: { expected_catalog_revision: current.catalog_revision } });
        expect(admitted.status()).toBe(202);
        const currentRunId = (await admitted.json() as { runId: string }).runId;
        const held = await modelCall(app, "requirements.match_catalog");
        const late = () => api.post(startPath, {
          headers: { "Idempotency-Key": idempotencyKey },
          data: { expected_catalog_revision: original.catalog_revision },
        });
        const occupied = await late();
        expect(occupied.status()).toBe(409);
        expect((await occupied.json()).error).toMatchObject({ code: "action_scope_busy", details: { runId: currentRunId } });
        expect(await json(api, "post", `/v1/action-runs/${currentRunId}/cancel`, {})).toMatchObject({ cancellationRequested: true });
        expect((await terminal(api, currentRunId)).status).toBe("cancelled");
        await expect.poll(() => held.closed).toBe(true);
        const stale = await late();
        expect(stale.status()).toBe(409);
        expect((await stale.json()).error.code).toBe("requirements_consolidation_catalog_changed");
        expect(app.external.calls.slice(initialCalls).map(call => call.body["operation"])).toEqual(["requirements.match_catalog"]);
      } else {
        const retry = page.waitForResponse((response) => startRequest(new URL(response.url()))
          && response.request().method() === "POST");
        await panel.getByRole("button", { name: "Retry the same consolidation", exact: true }).click();
        const rejected = await retry;
        await allowResponseError(rejected, { method: "POST", status: 409, code: "requirements_consolidation_catalog_changed" });
        expect(rejected.request().headers()["idempotency-key"]).toBe(idempotencyKey);
        expect(rejected.request().postDataJSON()).toEqual({ expected_catalog_revision: original.catalog_revision });
        await expect(panel.getByText(/The skills catalog changed before the request started/)).toBeVisible();
        await checkLookups();
        await page.reload();
        await expect(panel).toHaveCount(0);
        expect(await page.evaluate((key) => sessionStorage.getItem(key), recoveryKey("catalog"))).toBeNull();
        expect(app.external.calls).toHaveLength(initialCalls);
      }
      expect((await lookup()).status()).toBe(404);
      expect(await readCatalog(api)).toEqual(current);
      expect(await json(api, "get", requirementsPath(seed.posting.job_id))).toEqual(requirements);
      expect(await acceptedPdf(api, accepted.resume_id)).toEqual(pdf);
    } finally {
      try {
        await page.unrouteAll({ behavior: "wait" });
        await checkLookups();
      } finally {
        page.off("response", watchLookups);
        await Promise.all([...forwarded.values()].map((response) => response.dispose()));
      }
    }
  });
}
