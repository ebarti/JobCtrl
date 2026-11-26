import { createHash } from "node:crypto";
import { test, expect, json, modelCall, completed, terminal } from "../harness/fixtures.js";
import { createScoredFit, refreshPayload, startRefresh, type FitState, type PendingRefresh, type RefreshOperation } from "./fit-data.js";
import { qualificationBatchDecision } from "./qualification-data.js";
import { captureReusePosting, acceptReuseRequirements, reusableModelCatalog, type CapturedPosting } from "./reuse-data.js";
import { typedExtraction } from "./requirements-data.js";

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
  value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, field]) => [key, canonical(field)])) : value;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

test.describe("manual Fit paid qualification authority", () => {
  const cases = ["exact", "changed effort", "older other effort", "invalid evidence", "changed source", "unsettled"] as const;
  for (const mode of cases) {
    test(`a fresh manual Fit refresh resolves a prior revision conflict with ${mode} receipt authority`, async ({ api, app }) => {
      test.setTimeout(105_000);
      reusableModelCatalog(app);
      const seed = await createScoredFit(api, app, "fit-exact-paid");
      const { library } = seed;
      const settings = await json<{ revision: number; providerModels: { codex: string } }>(api, "get", "/v1/settings");
      await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, dailyBudgetUsd: 0 });
      const fact = library.roles[0]!.achievements[0]!;
      const demand = "Maintain documented recovery for business-critical services.";
      const job = await json<CapturedPosting>(api, "patch", `/v1/jobs/${seed.posting.job_id}`, { expectedRevision: seed.posting.revision, description: demand });
      await acceptReuseRequirements(api, app, job, [{ localId: "recovery", text: demand }], { recovery: { verdict: "new" } }, { expectedRevision: seed.requirements.revision });
      const start = async (key: string) => {
        const pending = await json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending");
        return startRefresh(api, { ...refreshPayload(pending, [job.job_id]), prepare_coverage: false, prepare_wording: false }, key);
      };
      const initialCalls = app.external.calls.length;
      const batches = () => app.external.calls.slice(initialCalls).filter(row => row.body["operation"] === "fit.qualification-batch");
      const effort = async (value: "high" | "low") => {
        const current = await json<{ revision: number }>(api, "get", "/v1/settings");
        await json(api, "patch", "/v1/settings", { expectedRevision: current.revision,
          codexReasoningEfforts: { [settings.providerModels.codex]: value } });
      };
      let olderFingerprint: string | undefined;
      if (mode === "older other effort") {
        await effort("low");
        const earlier = await start("older-low-effort");
        const batch = await modelCall(app, "fit.qualification-batch");
        olderFingerprint = fingerprint(batch.body);
        const invalid = qualificationBatchDecision(batch, () => ({ achievementIds: [fact.achievement_id], evidenceSourceIds: [`evidence:${fact.source_refs[0]!.source_id}`] }));
        invalid.requirements[0]!.achievement_ids = ["unoffered-older-achievement"];
        batch.reply(invalid);
        expect(await terminal(api, earlier.runId)).toMatchObject({ status: "failed", errorCode: "fit_achievement_binding_invalid" });
        await effort("high");
      }
      let lastFingerprint = "";
      const count = 1;
      for (let i = 0; i < count; i++) {
        const old = await start(`before-${i}`);
        const batch = await modelCall(app, "fit.qualification-batch");
        lastFingerprint = fingerprint(batch.body);
        const empty = await captureReusePosting(api, `fit-unrelated-${i}`, `Supervisar las operaciones del equipo ${i}.`);
        const extracting = api.post(`/v1/jobs/${empty.job_id}/requirements`, { data: { expected_posting_revision: empty.revision, expected_revision: 0 } });
        const extraction = await modelCall(app, "requirements.extract");
        extraction.reply(typedExtraction(extraction, { classification: "non_english", status: "unsupported_language" }));
        expect((await extracting).ok()).toBe(true);
        const response = qualificationBatchDecision(batch, () => ({ achievementIds: [fact.achievement_id], evidenceSourceIds: [`evidence:${fact.source_refs[0]!.source_id}`] }));
        if (mode === "invalid evidence") response.requirements[0]!.achievement_ids = ["unoffered-achievement"];
        if (mode === "unsettled") batch.respond({ error: "synthetic_transport_lost" }, 503);
        else batch.reply(response);
        expect(await terminal(api, old.runId)).toMatchObject({ status: "failed", errorCode:
          mode === "unsettled" ? "model_provider_failed" : "revision_conflict" });
        {
          const checkpoint = await app.fitRefreshCheckpoint(old.runId);
          expect(Object.values(checkpoint.calls).find(call => call.kind === "fit.qualification-batch")).toMatchObject({
            status: "started", receipt_id: expect.any(String), input_fingerprint: lastFingerprint,
            selection: { provider: "codex" }, execution: expect.objectContaining({ provider_configuration_sha256: expect.any(String) }),
          });
        }
        expect(await json<RefreshOperation>(api, "get", `/v1/fit/refresh/operations/${old.runId}`))
          .toMatchObject({ factual_published: false, counters: { model_calls: 1 } });
      }
      if (mode === "changed effort" || mode === "older other effort") await effort("low");
      if (mode === "changed source") {
        const extra = "Independently review recovery authorization before each service change.";
        const peer = await captureReusePosting(api, "fit-extra-actual-demand", extra);
        await acceptReuseRequirements(api, app, peer, [{ localId: "authorize", text: extra }], { authorize: { verdict: "new" } });
      }
      const fresh = await start("fresh-manual-operation");
      if (mode === "changed effort" || mode === "changed source" || mode === "older other effort") {
        const additional = await modelCall(app, "fit.qualification-batch");
        expect(fingerprint(additional.body)).not.toBe(lastFingerprint);
        if (olderFingerprint) expect(fingerprint(additional.body)).toBe(olderFingerprint);
        if (mode === "changed effort") expect(additional.body["execution"]).toMatchObject({ reasoning_effort: "low" });
        additional.reply(qualificationBatchDecision(additional, () => ({ achievementIds: [fact.achievement_id], evidenceSourceIds: [`evidence:${fact.source_refs[0]!.source_id}`] })));
      } else {
        await expect.poll(async () => {
          const row = await json<{ status: string }>(api, "get", `/v1/action-runs/${fresh.runId}`);
          return ["failed", "succeeded"].includes(row.status) || batches().length > count;
        }).toBe(true);
        expect(batches(), "An existing identical settled call must never dispatch again").toHaveLength(count);
      }
      if (mode === "invalid evidence" || mode === "unsettled") {
        expect(await terminal(api, fresh.runId)).toMatchObject({ status: "failed", errorCode:
          mode === "unsettled" ? "fit_refresh_qualification_receipt_unsettled" : "fit_achievement_binding_invalid" });
        expect(await json<RefreshOperation>(api, "get", `/v1/fit/refresh/operations/${fresh.runId}`))
          .toMatchObject({ factual_published: false, counters: { model_calls: 0 } });
        expect((await json<FitState>(api, "get", `/v1/jobs/${job.job_id}/fit`)).score).toEqual(seed.fit.score);
        return;
      }
      await completed(api, fresh.runId);
      const scored = await json<FitState>(api, "get", `/v1/jobs/${job.job_id}/fit`);
      expect(scored.current).toBe(true);
      expect(scored.score.revision).toBe(seed.fit.score.revision + 1);
      if (mode === "exact") {
        const checkpoint = await app.fitRefreshCheckpoint(fresh.runId);
        expect(Object.values(checkpoint.calls).find(call => call.kind === "fit.qualification-batch")).toMatchObject({
          origin: "reused_settled_receipt", receipt_id: scored.score.assessments[0]!.provenance.receipt_id,
          input_fingerprint: lastFingerprint,
        });
      }
      expect(scored.score.assessments[0]!.provenance).toMatchObject({ input_fingerprint: fingerprint(batches().at(-1)!.body) });
      expect(await json<RefreshOperation>(api, "get", `/v1/fit/refresh/operations/${fresh.runId}`))
        .toMatchObject({ factual_published: true, counters: { model_calls: mode === "exact" ? 0 : 1 } });
    });
  }
});
