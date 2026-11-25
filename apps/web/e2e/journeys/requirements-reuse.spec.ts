import { test, expect, json, modelCall, action, completed, terminal, type ExternalCall } from "../harness/fixtures.js";
import { createBaseline } from "./core-data.js";
import { captureReusePosting, acceptReuseRequirements, reusableModelCatalog, type CapturedPosting, type RequirementSnapshot } from "./reuse-data.js";
import { catalogContext, catalogMatching, catalogSource, citeSources, modelSources, EXTRACTION_PROMPT_VERSION,
  REFRESH_NORMALIZATION_PROMPT_VERSION, typedExtraction } from "./requirements-data.js";

const requirement = [{ localId: "recovery", text: "Implement durable workflow recovery." }];
const body = requirement[0]!.text;

function assertDestination(snapshot: RequirementSnapshot, posting: CapturedPosting, semanticSourceId: string) {
  expect(snapshot).toMatchObject({ job_id: posting.job_id, posting_revision: posting.revision, posting_hash: posting.source_hash, stale: false });
  const occurrence = snapshot.requirements[0]!;
  expect(occurrence).toMatchObject({ job_id: posting.job_id, source_id: posting.source_id, source_revision: posting.source_revision, source_hash: posting.source_hash, model_source_id: semanticSourceId });
  expect(occurrence.provenance.extraction.source_binding).toMatchObject({ version: 2, contract_version: "requirements-v2", semantic_source: { version: 2, contract_version: "requirements-v2", source_id: semanticSourceId }, destination_posting: {
    job_id: posting.job_id, revision: posting.revision, source_id: posting.source_id, source_revision: posting.source_revision, source_hash: posting.source_hash,
  } });
  expect(occurrence.provenance.resolution).toHaveLength(1);
  expect(occurrence.equivalence_determination_ids).toEqual(occurrence.provenance.resolution.map((receipt) => receipt.receipt_id));
  for (const receipt of occurrence.provenance.resolution) {
    expect(receipt).toMatchObject({ prompt_version: REFRESH_NORMALIZATION_PROMPT_VERSION,
      input_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      accepted_result_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  }
}

function assertNormalizationDestination(call: ExternalCall, posting: CapturedPosting) {
  const context = catalogContext(call);
  expect(context.incoming).toEqual([expect.objectContaining({ job_id: posting.job_id })]);
  expect(context.occurrences.filter((row) => row.job_id === posting.job_id)).toHaveLength(1);
  const reference = context.posting_sources.find((row) => row.job_id === posting.job_id)!;
  expect(reference).toMatchObject({ job_id: posting.job_id, revision: posting.revision, source_hash: posting.source_hash });
  expect(call.body["context"]).toMatchObject({ catalog_tables: {
    strings: expect.arrayContaining([posting.source_hash]), row_fields: expect.any(Array),
    segment_paths: expect.any(Array), segment_layouts: expect.any(Array),
  } });
  for (const source of modelSources(call)) catalogSource(call, source.source_id);
  expect(catalogSource(call, reference.source_id)).toMatchObject({ job_id: posting.job_id, revision: posting.revision,
    source_id: posting.source_id, source_revision: posting.source_revision, source_hash: posting.source_hash });
}

test("Requirements exact content reuse keeps extraction destination bindings and normalizes each Job against its complete catalog with model and effort authority", async ({ api, app }) => {
  reusableModelCatalog(app);
  const first = await captureReusePosting(api, "reuse-first", body);
  const accepted = await acceptReuseRequirements(api, app, first, requirement, { recovery: { verdict: "new" } });
  expect(accepted.extraction!.body["prompt_version"]).toBe(EXTRACTION_PROMPT_VERSION);
  const context = accepted.extraction!.body["context"] as { posting_content: { source_id: string; text_fingerprint: string }; refresh_binding: unknown };
  const semanticSourceId = context.posting_content.source_id;
  expect(semanticSourceId).toBe(`posting-content:requirements-v2:${context.posting_content.text_fingerprint}`);
  expect(accepted.extraction!.body["sources"]).toEqual([{ source_id: semanticSourceId, text: body }]);
  expect(context.refresh_binding).toBeNull();
  expect(JSON.stringify(accepted.extraction!.body)).not.toContain(first.job_id);
  expect(JSON.stringify(accepted.extraction!.body)).not.toContain("Synthetic reuse-first");
  assertDestination(accepted.snapshot, first, semanticSourceId);
  assertNormalizationDestination(accepted.matching!, first);
  const canonicalId = accepted.snapshot.requirements[0]!.requirement_id;
  const equivalent = { recovery: { verdict: "equivalent" as const, requirementId: canonicalId } };

  // The first new meaning changed the catalog; only matching needs one new
  // determination for the second real destination Job.
  const second = await captureReusePosting(api, "reuse-second", body);
  const beforeSecond = app.external.calls.length;
  const reusedExtraction = await acceptReuseRequirements(api, app, second, requirement, equivalent, { extract: false });
  expect(app.external.calls.slice(beforeSecond).map((call) => call.body["operation"])).toEqual(["requirements.match_catalog"]);
  expect(reusedExtraction.snapshot.requirements[0]!.extraction_determination_id).toBe(accepted.snapshot.requirements[0]!.extraction_determination_id);
  expect(reusedExtraction.matching!.body["prompt_version"]).toBe(REFRESH_NORMALIZATION_PROMPT_VERSION);
  assertDestination(reusedExtraction.snapshot, second, semanticSourceId);
  assertNormalizationDestination(reusedExtraction.matching!, second);

  const third = await captureReusePosting(api, "reuse-third", body);
  const beforeThird = app.external.calls.length;
  const exact = await acceptReuseRequirements(api, app, third, requirement, equivalent, { extract: false });
  expect(app.external.calls.slice(beforeThird).map((call) => call.body["operation"])).toEqual(["requirements.match_catalog"]);
  expect(exact.snapshot.requirements[0]!.extraction_determination_id).toBe(accepted.snapshot.requirements[0]!.extraction_determination_id);
  expect(exact.snapshot.requirements[0]!.equivalence_determination_ids).not.toEqual(reusedExtraction.snapshot.requirements[0]!.equivalence_determination_ids);
  expect(new Set([accepted, reusedExtraction, exact].map((value) => value.snapshot.requirements[0]!.occurrence_id)).size).toBe(3);
  assertDestination(exact.snapshot, third, semanticSourceId);
  assertNormalizationDestination(exact.matching!, third);

  const differentBody = `~r0\n${body}\n~~ Literal source context with ~7.`;
  const changedBody = await captureReusePosting(api, "reuse-exact-context", differentBody);
  expect(changedBody.description).toBe(differentBody);
  const beforeBody = app.external.calls.length;
  const literalReferences = requirement.map(row => ({ ...row, sourceNote: "~r0", rationale: "~~7" }));
  const changed = await acceptReuseRequirements(api, app, changedBody, literalReferences, equivalent);
  const changedCall = changed.matching!;
  expect(catalogSource(changedCall, catalogContext(changedCall).incoming[0]!.model_source_id))
    .toMatchObject({ source_note: "~r0", rationale: "~~7" });
  expect(app.external.calls.slice(beforeBody).map((call) => call.body["operation"])).toEqual(["requirements.extract", "requirements.match_catalog"]);
  expect(changed.snapshot.requirements[0]!.extraction_determination_id).not.toBe(accepted.snapshot.requirements[0]!.extraction_determination_id);
  expect((changed.extraction!.body["sources"] as { source_id: string; text: string }[])[0]!).toMatchObject({ text: differentBody });
  expect((changed.extraction!.body["sources"] as { source_id: string }[])[0]!.source_id).not.toBe(semanticSourceId);

  const separate = [{ localId: "import", text: "Build a versioned data import tool." }];
  const newCatalogPosting = await captureReusePosting(api, "reuse-catalog-addition", separate[0]!.text);
  await acceptReuseRequirements(api, app, newCatalogPosting, separate, { import: { verdict: "new" } });
  const afterCatalog = await captureReusePosting(api, "reuse-after-catalog", body);
  const beforeCatalog = app.external.calls.length;
  const rematched = await acceptReuseRequirements(api, app, afterCatalog, requirement, equivalent, { extract: false });
  expect(app.external.calls.slice(beforeCatalog).map((call) => call.body["operation"])).toEqual(["requirements.match_catalog"]);
  const matchingContext = catalogContext(rematched.matching!);
  expect(matchingContext.candidates).toHaveLength(2);
  expect(matchingContext.incoming).toHaveLength(1);
  expect(rematched.snapshot.requirements[0]!.extraction_determination_id).toBe(accepted.snapshot.requirements[0]!.extraction_determination_id);
  expect(rematched.snapshot.requirements[0]!.equivalence_determination_ids).not.toEqual(exact.snapshot.requirements[0]!.equivalence_determination_ids);

  const settings = await json<{ revision: number; providerModels: Record<string, string> }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, providerModels: { ...settings.providerModels, codex: "gpt-6.1" }, dailyBudgetUsd: 0 });
  const differentModel = await captureReusePosting(api, "reuse-selected-model", body);
  const beforeModel = app.external.calls.length;
  const modeled = await acceptReuseRequirements(api, app, differentModel, requirement, equivalent);
  expect(app.external.calls.slice(beforeModel).map((call) => call.body["operation"])).toEqual(["requirements.extract", "requirements.match_catalog"]);
  expect(modeled.extraction!.body["model"]).toBe("gpt-6.1");
  expect(modeled.snapshot.requirements[0]!.extraction_determination_id).not.toBe(accepted.snapshot.requirements[0]!.extraction_determination_id);
  expect(modeled.extraction!.body["execution"]).toMatchObject({ reasoning_effort: "high", provider_configuration_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });

  const current = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: current.revision, codexReasoningEfforts: { "gpt-6.1": "low" } });
  const differentEffort = await captureReusePosting(api, "reuse-selected-effort", body);
  const beforeEffort = app.external.calls.length;
  const effort = await acceptReuseRequirements(api, app, differentEffort, requirement, equivalent);
  expect(app.external.calls.slice(beforeEffort).map((call) => call.body["operation"])).toEqual(["requirements.extract", "requirements.match_catalog"]);
  expect(effort.extraction!.body["execution"]).toMatchObject({ reasoning_effort: "low" });
  expect(effort.snapshot.requirements[0]!.extraction_determination_id).not.toBe(modeled.snapshot.requirements[0]!.extraction_determination_id);
  assertDestination(effort.snapshot, differentEffort, semanticSourceId);
});

test("one complete single-job comparison binds all 100 original postings and every occurrence slot", async ({ api, app }, info) => {
  test.setTimeout(240_000);
  await createBaseline(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, dailyBudgetUsd: 0 });

  const description = (index: number) => {
    const note = `Synthetic division ${index} reviews its own source evidence and retains the service details. `;
    return `${body}\n${note.repeat(12).trimEnd()}`;
  };
  // Use the Requirements entrypoint to build the retained catalog. Discovery
  // now prepares each admitted job independently.
  const historical = new Map<string, CapturedPosting>();
  let canonicalId: string | undefined;
  for (let index = 1; index < 100; index++) {
    const posting = await captureReusePosting(api, `tables-division-${index}`, description(index));
    const prior = await acceptReuseRequirements(api, app, posting, requirement, {
      recovery: canonicalId ? { verdict: "equivalent", requirementId: canonicalId } : { verdict: "new" },
    });
    canonicalId ??= prior.snapshot.requirements[0]!.requirement_id;
    expect(prior.snapshot.requirements[0]!.requirement_id).toBe(canonicalId);
    historical.set(posting.job_id, posting);
  }
  expect(canonicalId).toBeTruthy();
  expect(historical.size).toBe(99);
  const { jobs } = await json<{ jobs: CapturedPosting[] }>(api, "get", "/v1/jobs?limit=100");
  expect(jobs.map((row) => row.job_id).sort()).toEqual([...historical.keys()].sort());
  for (const row of jobs) expect(row.description).toBe(historical.get(row.job_id)!.description);

  const last = await captureReusePosting(api, "tables-division-100", description(100));
  const postings = new Map([...jobs, last].map((row) => [row.job_id, row]));
  const before = app.external.calls.length;
  const result = await acceptReuseRequirements(api, app, last, requirement, {
    recovery: { verdict: "equivalent", requirementId: canonicalId! },
  });
  expect(result.snapshot.requirements[0]!.requirement_id).toBe(canonicalId);
  const call = result.matching!;
  const context = catalogContext(call);
  expect(app.external.calls.slice(before).map(row => row.body["operation"])).toEqual(["requirements.extract", "requirements.match_catalog"]);
  expect(context.posting_sources.map(row => row.job_id).sort()).toEqual([...postings.keys()].sort());
  for (const row of context.posting_sources) {
    const original = postings.get(row.job_id)!;
    expect(catalogSource(call, row.source_id)).toMatchObject({ job_id: original.job_id, source_hash: original.source_hash, text: original.description });
  }
  const schema = call.body["response_schema"] as { $defs: { OccurrenceSlots: { properties: Record<string, unknown>; required: string[] } } };
  expect(context.occurrences).toHaveLength(100);
  expect(schema.$defs.OccurrenceSlots.required.slice().sort()).toEqual(context.occurrences.map(row => row.occurrence_id).sort());
  expect(new Set(Object.values(schema.$defs.OccurrenceSlots.properties).map(value => JSON.stringify(value))).size).toBe(1);
  const sentBytes = Buffer.byteLength(JSON.stringify(call.body));
  expect(sentBytes).toBeLessThan(1024 * 1024);
  await info.attach("100-posting-comparison", { contentType: "application/json", body: JSON.stringify({
    postingCount: context.posting_sources.length, occurrenceCount: context.occurrences.length, sentBytes,
  }) });
});

test("an interrupted single-job catalog comparison preserves accepted receipts and needs an explicit new refresh", async ({ api, app }) => {
  test.setTimeout(120_000);
  const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, dailyBudgetUsd: 0 });
  const posting = await captureReusePosting(api, "single-catalog-wire", body);
  const payload = { job_id: posting.job_id, expected_posting_revision: posting.revision, expected_revision: 0 };
  const send = () => api.post("/v1/actions/requirements.refresh", { headers: { "idempotency-key": "original-wire" }, data: payload });
  const admission = await send();
  expect(admission.ok()).toBe(true);
  const original = (await admission.json()).runId;
  const extraction = await modelCall(app, "requirements.extract");
  extraction.reply(typedExtraction(extraction, { requirements: requirement }));
  const comparison = await modelCall(app, "requirements.match_catalog");
  expect(comparison.body["prompt_version"]).toBe(REFRESH_NORMALIZATION_PROMPT_VERSION);
  assertNormalizationDestination(comparison, posting);
  comparison.reply(catalogMatching(comparison, { recovery: { verdict: "new" } }));
  await completed(api, original);
  const snapshot = () => json<RequirementSnapshot>(api, "get", `/v1/jobs/${posting.job_id}/requirements`);
  const accepted = await snapshot();

  const priorJob = await captureReusePosting(api, "single-catalog-prior-refusal", `${body}\nAdditional source.`);
  const prior = api.post(`/v1/jobs/${priorJob.job_id}/requirements`, { data: { expected_revision: 0, expected_posting_revision: priorJob.revision } });
  const priorExtraction = await modelCall(app, "requirements.extract");
  priorExtraction.reply({ unexpected: true });
  expect((await prior).status()).toBe(502);
  const priorAttempt = () => json(api, "get", `/v1/jobs/${priorJob.job_id}/requirements/attempts/latest`);
  const refused = await priorAttempt();
  expect(refused).toMatchObject({ state: "blocked", failure_code: "model_schema_violation" });

  const force = { ...payload, expected_revision: accepted.revision, force: true };
  const interrupted = await action(api, "requirements.refresh", force);
  const oldExtraction = await modelCall(app, "requirements.extract");
  oldExtraction.reply(typedExtraction(oldExtraction, { requirements: requirement }));
  const held = await modelCall(app, "requirements.match_catalog");
  expect(held.body["prompt_version"]).toBe(REFRESH_NORMALIZATION_PROMPT_VERSION);
  assertNormalizationDestination(held, posting);
  const count = app.external.calls.length;
  const replacement = await app.restartWorker();
  expect(replacement.current).not.toBe(replacement.previous);
  expect(await terminal(api, interrupted.runId)).toMatchObject({ status: "failed", errorCode: "requirements_consolidation_call_unsettled" });
  const replay = await send();
  expect(replay.ok()).toBe(true);
  expect(await replay.json()).toMatchObject({ runId: original, status: "succeeded" });
  expect(app.external.calls).toHaveLength(count);
  expect(await priorAttempt()).toEqual(refused);
  expect(await json(api, "get", `/v1/jobs/${priorJob.job_id}/requirements`)).toBeNull();
  expect(await snapshot()).toEqual(accepted);

  const fresh = await action(api, "requirements.refresh", force);
  const currentExtraction = await modelCall(app, "requirements.extract");
  currentExtraction.reply(typedExtraction(currentExtraction, { requirements: requirement }));
  const packed = await modelCall(app, "requirements.match_catalog");
  expect(packed.body["prompt_version"]).toBe(REFRESH_NORMALIZATION_PROMPT_VERSION);
  assertNormalizationDestination(packed, posting);
  const choice = catalogMatching(packed, { recovery: { verdict: "equivalent", requirementId: accepted.requirements[0]!.requirement_id } });
  packed.reply(choice);
  await completed(api, fresh.runId);
  expect((await snapshot()).requirements[0]!.provenance.resolution[0]).toMatchObject({ prompt_version: REFRESH_NORMALIZATION_PROMPT_VERSION });
  expect(app.external.calls.filter(call => call.body["operation"] === "requirements.match_catalog")).toHaveLength(3);
});

test.describe("role-analysis offered-source authority", () => {
test.use({ features: "jobs" });

test("role analysis reuses exact body authority across Jobs while force and effort make fresh calls", async ({ api, app }, testInfo) => {
  reusableModelCatalog(app);
  const description = "Own workflow recovery and retain explicit operational review receipts.";
  const first = await captureReusePosting(api, "role-reuse-first", description);
  const second = await captureReusePosting(api, "role-reuse-peer", description);
  type Analysis = { current: boolean; accepted: { provenance: { receipt_id: string }; source_binding: { semantic_source: { source_id: string }; destination_posting: { job_id: string; revision: number; source_hash: string } } } };
  const analyze = (posting: CapturedPosting) => api.post(`/v1/jobs/${posting.job_id}/analysis`, { data: { expectedRevision: posting.revision } });
  const pending = analyze(first);
  const call = await modelCall(app, "jobs.role_analysis");
  expect(call.body["prompt_version"]).toBe("role-analysis-v3-offered-sources");
  expect(call.body["context"]).toEqual({ qualified_requirements: [] });
  expect(JSON.stringify(call.body)).not.toContain(first.job_id);
  const source = modelSources(call)[0]!;
  expect(source.text).toBe(description);
  const reply = (current: typeof call) => {
    const statement = { text: description, citations: citeSources(current, modelSources(current).map((row) => row.source_id)), uncertainty: "Only the supplied current posting is considered." };
    current.reply({ role_framing: statement, inferred_seniority: { value: "unknown", citations: statement.citations, rationale: "This posting does not establish a level." }, ideal_candidate_narrative: statement, keywords: [] });
  };
  reply(call);
  const response = await pending;
  expect(response.status(), await response.text()).toBe(200);
  const accepted = await response.json() as Analysis;
  const beforePeer = app.external.calls.length;
  const peerResponse = await analyze(second);
  expect(peerResponse.status(), await peerResponse.text()).toBe(200);
  const peer = await peerResponse.json() as Analysis;
  expect(app.external.calls).toHaveLength(beforePeer);
  expect(peer.accepted.provenance).toEqual(accepted.accepted.provenance);
  expect(peer.accepted.source_binding.semantic_source).toEqual(accepted.accepted.source_binding.semantic_source);
  expect(peer.accepted.source_binding.destination_posting).toEqual({ job_id: second.job_id, revision: second.revision, source_hash: second.source_hash });

  const forced = await action(api, "jobs.analyze", { job_id: second.job_id, expectedRevision: second.revision, force: true });
  const fresh = await modelCall(app, "jobs.role_analysis");
  expect(fresh.body["context"]).toEqual({ qualified_requirements: [], refresh_identity: forced.runId });
  reply(fresh);
  await completed(api, forced.runId);
  const refreshed = await json<Analysis>(api, "get", `/v1/jobs/${second.job_id}/analysis`);
  expect(refreshed.current).toBe(true);
  expect(refreshed.accepted.provenance.receipt_id).not.toBe(peer.accepted.provenance.receipt_id);

  const settings = await json<{ revision: number; providerModels: { codex: string } }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, codexReasoningEfforts: { [settings.providerModels.codex]: "low" } });
  const third = await captureReusePosting(api, "role-reuse-effort", description);
  const changed = analyze(third);
  const effort = await modelCall(app, "jobs.role_analysis");
  expect(effort.body["execution"]).toMatchObject({ reasoning_effort: "low" });
  reply(effort);
  expect((await changed).status()).toBe(200);
  expect(app.external.calls.filter((item) => item.body["operation"] === "jobs.role_analysis")).toHaveLength(3);

  const priorAnalysis = await json<Analysis>(api, "get", `/v1/jobs/${third.job_id}/analysis`);
  const replacement = await app.restartWorker("jobs");
  expect(replacement.current).not.toBe(replacement.previous);
  expect(await json<Analysis>(api, "get", `/v1/jobs/${third.job_id}/analysis`)).toEqual(priorAnalysis);
  const beforeRestartReuse = app.external.calls.length;
  const reused = await analyze(third);
  expect(reused.status(), await reused.text()).toBe(200);
  expect((await reused.json() as Analysis).accepted).toEqual(priorAnalysis.accepted);
  expect(app.external.calls).toHaveLength(beforeRestartReuse);

  // Restore the forced analysis's exact selection and require its distinct
  // immutable receipt to remain reusable too, without a provider determination.
  const restoredSettings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: restoredSettings.revision,
    codexReasoningEfforts: { [settings.providerModels.codex]: "high" } });
  const beforeForcedReuse = app.external.calls.length;
  const reusedForced = await analyze(second);
  expect(reusedForced.status(), await reusedForced.text()).toBe(200);
  expect((await reusedForced.json() as Analysis).accepted).toEqual(refreshed.accepted);
  expect(app.external.calls).toHaveLength(beforeForcedReuse);
  expect(app.external.calls.filter((item) => item.body["operation"] === "jobs.role_analysis")).toHaveLength(3);

  const beforeFailure = await json<Analysis>(api, "get", `/v1/jobs/${second.job_id}/analysis`);
  const refused = await action(api, "jobs.analyze", { job_id: second.job_id, expectedRevision: second.revision, force: true });
  const invalid = await modelCall(app, "jobs.role_analysis");
  expect(invalid.body["prompt_version"]).toBe("role-analysis-v3-offered-sources");
  expect(invalid.body["context"]).toEqual({ qualified_requirements: [], refresh_identity: refused.runId });
  const citations = citeSources(invalid, modelSources(invalid).map((row) => row.source_id));
  const schema = invalid.body["response_schema"] as { $defs: { Citation: { properties: { source_id: { enum: string[] } } } } };
  expect(schema.$defs.Citation.properties.source_id.enum).toEqual([citations[0]!.source_id]);
  const statement = { text: description, citations, uncertainty: "Only the supplied current posting is considered." };
  invalid.reply({
    role_framing: { ...statement, citations: [{ ...citations[0]!, source_id: `${citations[0]!.source_id}:foreign` }] },
    inferred_seniority: { value: "unknown", citations, rationale: "This posting does not establish a level." },
    ideal_candidate_narrative: statement,
    keywords: [],
  });
  expect(await terminal(api, refused.runId)).toMatchObject({ status: "failed", errorCode: "role_analysis_failed" });
  const retained = await json<Analysis>(api, "get", `/v1/jobs/${second.job_id}/analysis`);
  expect(retained.current).toBe(true);
  expect(retained.accepted).toEqual(beforeFailure.accepted);
  const history = await json<{ attempts: { failure_code: string; data: Record<string, unknown> }[] }>(api, "get", `/v1/jobs/${second.job_id}/snapshots`);
  const attempt = history.attempts.find((row) => row.failure_code === "role_analysis_failed")!;
  expect(attempt).toBeTruthy();
  expect(attempt.data).toEqual({ operation: "role_analysis", failures: [{
    code: "model_schema_violation", provider: invalid.body["provider"], model: invalid.body["model"],
  }] });
  expect(JSON.stringify(attempt.data)).not.toContain(description);
  expect(JSON.stringify(attempt.data)).not.toContain(citations[0]!.source_id);
  const beforeReads = app.external.calls.length;
  await json(api, "get", `/v1/jobs/${second.job_id}/analysis`);
  await json(api, "get", `/v1/jobs/${second.job_id}/snapshots`);
  expect(app.external.calls).toHaveLength(beforeReads);
  expect(app.external.calls.filter((item) => item.body["operation"] === "jobs.role_analysis")).toHaveLength(4);

  const valid = await action(api, "jobs.analyze", { job_id: second.job_id, expectedRevision: second.revision, force: true });
  const bound = await modelCall(app, "jobs.role_analysis");
  expect(bound.body["prompt_version"]).toBe("role-analysis-v3-offered-sources");
  expect((bound.body["response_schema"] as typeof schema).$defs.Citation.properties.source_id.enum).toEqual([citations[0]!.source_id]);
  reply(bound);
  await completed(api, valid.runId);
  const acceptedV3 = await json<Analysis>(api, "get", `/v1/jobs/${second.job_id}/analysis`);
  expect(acceptedV3.current).toBe(true);
  expect(acceptedV3.accepted.provenance.receipt_id).not.toBe(retained.accepted.provenance.receipt_id);
  expect(app.external.calls.filter((item) => item.body["operation"] === "jobs.role_analysis")).toHaveLength(5);
  await testInfo.attach("role-analysis-failure-evidence", { contentType: "application/json",
    body: Buffer.from(JSON.stringify({ runId: refused.runId, jobId: second.job_id, failure: attempt.data,
      retainedReceiptId: retained.accepted.provenance.receipt_id,
      priorReceiptId: priorAnalysis.accepted.provenance.receipt_id, acceptedV3ReceiptId: acceptedV3.accepted.provenance.receipt_id }, null, 2)) });
});
});
