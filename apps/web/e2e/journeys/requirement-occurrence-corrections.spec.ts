import type { APIRequestContext } from "@playwright/test";
import { test, expect, json, modelCall, completed, terminal, type ApplicationStack, type ExternalCall } from "../harness/fixtures.js";
import { catalogMatching, typedExtraction, modelSources, type CatalogContext, type CatalogChoice } from "./requirements-data.js";
import { captureReusePosting, acceptReuseRequirements, type CapturedPosting } from "./reuse-data.js";

const ACTION = "requirements.correct_occurrences";
const PROMPT = "requirements-v2-occurrence-correction-v1";
type Occurrence = Record<string, unknown> & {
  occurrence_id: string; previous_occurrence_id?: string; local_id: string; requirement_id: string; requirement_revision: number;
  extraction_determination_id: string; evidence_refs: string[]; definition: string;
  provenance: Record<string, unknown> & { extraction: { receipt_id: string }; resolution: { receipt_id: string }[] };
};
type Quote = { evidence_id: string; source_id: string; quote: string; start: number; end: number };
type Snapshot = Record<string, unknown> & {
  revision: number; posting_revision: number; stale: boolean; requirements: Occurrence[]; quotes: Quote[];
  education: unknown[]; languages: unknown[]; extraction_determination_id: string;
  extraction_provenance: Record<string, unknown>; correction_history?: { corrections: unknown[] }[];
};
type Catalog = { total: number; requirements: { requirement_id: string }[] };
type Corrections = { occurrence_id: string; reason: string }[];
type CorrectionContext = { selected: Occurrence[]; corrections: Corrections; expected_snapshot: { revision: number; fingerprint: string } };
const corrected = [
  { category: "professional_experience" as const, name: "Organizational transformation", definition: "Lead organizational transformation programs from planning through delivery." },
  { category: "skill" as const, name: "Resilient multi-region architecture", definition: "Design and operate resilient multi-region service architecture." },
];
const clauses = [
  "Lead end-to-end transformation programs across distributed teams.",
  "Design and operate resilient multi-region service architecture.",
  "Build accessible web interfaces using React.",
  "Coordinate incident response across product teams.",
  "Hold an engineering degree or equivalent professional experience.",
  "Use English at professional working proficiency.",
];
const snapshotPath = (posting: CapturedPosting) => `/v1/jobs/${posting.job_id}/requirements`;
const operations = (app: ApplicationStack, since: number) => app.external.calls.slice(since).filter((row) => row.path === "/model").map((row) => row.body["operation"]);

async function seed(api: APIRequestContext, app: ApplicationStack, slug: string) {
  const peer = await captureReusePosting(api, `${slug}-peer`, clauses[0]!);
  const peerResult = await acceptReuseRequirements(api, app, peer,
    [{ localId: "complete-transformation", text: clauses[0]!, definition: corrected[0]!.definition }],
    { "complete-transformation": { verdict: "new" } });
  const existingId = peerResult.snapshot.requirements[0]!.requirement_id;
  const existingAuthority = await json(api, "get", `/v1/requirements/${existingId}`);
  const posting = await captureReusePosting(api, slug, clauses.join("\n"));
  const extracting = api.post(snapshotPath(posting), { data: { expected_posting_revision: posting.revision, expected_revision: 0 } });
  const extraction = await modelCall(app, "requirements.extract");
  extraction.reply(typedExtraction(extraction, {
    requirements: [
      { localId: "transformation", text: clauses[0]!, definition: "Participate in team projects." },
      { localId: "architecture", text: clauses[1]!, category: "skill", definition: "Operate existing service runbooks." },
      { localId: "interfaces", text: clauses[2]!, category: "skill" },
      { localId: "incidents", text: clauses[3]! },
    ],
    education: [{ text: clauses[4]!, qualification: "Engineering degree", alternative: "Equivalent professional experience" }],
    languages: [{ text: clauses[5]!, language: "English", proficiency: "Professional working proficiency" }],
  }));
  const matching = await modelCall(app, "requirements.match_catalog");
  matching.reply(catalogMatching(matching, Object.fromEntries(["transformation", "architecture", "interfaces", "incidents"].map((id) => [id, { verdict: "new" as const }]))));
  const response = await extracting;
  expect(response.status(), await response.text()).toBe(200);
  return { posting, peer, existingId, existingAuthority, snapshot: await response.json() as Snapshot,
    catalog: await json<Catalog>(api, "get", "/v1/requirements?limit=200") };
}

type Seed = Awaited<ReturnType<typeof seed>>;
const body = (value: Seed, label: string) => ({
  job_id: value.posting.job_id, expected_posting_revision: value.posting.revision, expected_revision: value.snapshot.revision,
  corrections: value.snapshot.requirements.slice(0, 2).map((row, index) => ({ occurrence_id: row.occurrence_id,
    reason: `${label}: restore the complete source-established ${index === 0 ? "transformation" : "architecture"} demand.` })),
});

async function start(api: APIRequestContext, payload: ReturnType<typeof body>, key: string) {
  const response = await api.post(`/v1/actions/${ACTION}`, { headers: { "idempotency-key": key }, data: payload });
  expect(response.status(), await response.text()).toBe(202);
  return response.json() as Promise<{ runId: string }>;
}

async function allowOwnedOverlap(api: APIRequestContext) {
  const settings = await json<{ revision: number; laneConcurrency: Record<string, number> }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision,
    dailyBudgetUsd: 0, laneConcurrency: { ...settings.laneConcurrency, requirements: 2 } });
}

function revision(call: ExternalCall, value: Seed) {
  expect(call.body["operation"]).toBe(ACTION);
  expect(call.body["prompt_version"]).toBe(PROMPT);
  const sources = modelSources(call);
  expect(sources).toHaveLength(1);
  expect(sources[0]!.text).toBe(value.posting.description);
  const context = call.body["context"] as CorrectionContext;
  expect(context.selected).toEqual(value.snapshot.requirements.slice(0, 2));
  expect(context.expected_snapshot.revision).toBe(value.snapshot.revision);
  expect(context.expected_snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  const quotes = corrected.map((_, index) => ({ evidence_id: `corrected-quote-${index}`, source_id: sources[0]!.source_id, quote: clauses[index]! }));
  return { status: "complete" as "complete" | "needs_review", quotes,
    requirements: context.selected.map((row, index) => ({ local_id: row.occurrence_id, ...corrected[index]!,
      basis: "explicit", rationale: null, source_note: null, evidence_refs: [quotes[index]!.evidence_id] })) };
}

function resolution(call: ExternalCall, value: Seed, uncertain = false) {
  const context = call.body["context"] as CatalogContext & { correction_guidance: {
    authority: string; selected_bindings: { occurrence_id: string; requirement_id: string; requirement_revision: number; canonical: unknown; reason: string }[];
  }; refresh_binding: { corrections: Corrections } };
  expect(context.incoming.map((row) => row.local_id)).toEqual(value.snapshot.requirements.slice(0, 2).map((row) => row.occurrence_id));
  expect(new Set(context.candidates.map((row) => row.requirement_id))).toEqual(new Set(value.catalog.requirements.map((row) => row.requirement_id)));
  expect(context.correction_guidance.authority.trim()).not.toBe("");
  expect(context.correction_guidance.selected_bindings).toEqual(value.snapshot.requirements.slice(0, 2).map((row) => ({
    occurrence_id: row.occurrence_id, requirement_id: row.requirement_id, requirement_revision: row.requirement_revision,
    canonical: row["canonical"], reason: context.refresh_binding.corrections.find((selected) => selected.occurrence_id === row.occurrence_id)!.reason,
  })));
  expect(modelSources(call).map((row) => row.text)).not.toContain(context.correction_guidance.authority);
  return catalogMatching(call, {
    [context.incoming[0]!.local_id]: uncertain ? { verdict: "uncertain" } : { verdict: "equivalent", requirementId: value.existingId },
    [context.incoming[1]!.local_id]: { verdict: "new" },
  });
}

function occurrenceAuthority(row: Occurrence) {
  const { occurrence_id: _id, previous_occurrence_id: _previous, ...authority } = row;
  return authority;
}

function meaningAuthority(row: Record<string, unknown>) {
  const { occurrences: _occurrences, current_revision: _head, stale: _stale, stale_reasons: _reasons, ...authority } = row;
  return authority;
}

async function retained(api: APIRequestContext, value: Seed, stale = false) {
  const current = await json<Snapshot>(api, "get", snapshotPath(value.posting));
  expect(current.revision).toBe(value.snapshot.revision);
  expect(current.stale).toBe(stale);
  for (const key of ["requirements", "education", "languages", "quotes", "language", "extraction_determination_id", "extraction_provenance"])
    expect(current[key]).toEqual(value.snapshot[key]);
  return current;
}

test("scoped occurrence corrections resolve two selected meanings and retain every unselected source authority", async ({ api, app }) => {
  const value = await seed(api, app, "occurrence-positive");
  const payload = body(value, "Complete the selected meanings");
  const before = app.external.calls.length;
  const run = await start(api, payload, "occurrence-positive-original");
  const correcting = await modelCall(app, ACTION);
  expect((correcting.body["context"] as CorrectionContext).corrections).toEqual(payload.corrections);
  const correctedResponse = revision(correcting, value);
  correcting.reply(correctedResponse);
  const matching = await modelCall(app, "requirements.match_catalog");
  matching.reply(resolution(matching, value));
  await completed(api, run.runId);
  const accepted = await json<Snapshot>(api, "get", snapshotPath(value.posting));
  expect(accepted).toMatchObject({ revision: value.snapshot.revision + 1, stale: false });
  expect(accepted.requirements).toHaveLength(value.snapshot.requirements.length);
  for (const [index, original] of value.snapshot.requirements.entries()) {
    const row = accepted.requirements[index]!;
    expect(row.occurrence_id).not.toBe(original.occurrence_id);
    expect(row.previous_occurrence_id).toBe(original.occurrence_id);
    if (index >= 2) {
      expect(occurrenceAuthority(row)).toEqual(occurrenceAuthority(original));
      continue;
    }
    expect(row.local_id).toBe(original.local_id);
    expect(row.definition).toBe(corrected[index]!.definition);
    const correction = row.provenance["correction"] as { reason: string; previous_occurrence_id: string;
      receipt: { receipt_id: string; provider: string; model: string; lane: string }; evidence_ids: Record<string, string>; result_fingerprint: string };
    expect(row.provenance["semantic_stage"]).toBe("occurrence_correction");
    expect(row.provenance["origin"]).toEqual(original.provenance);
    expect(correction.reason).toBe(payload.corrections[index]!.reason);
    expect(correction.previous_occurrence_id).toBe(original.occurrence_id);
    expect(correction.receipt).toMatchObject({ provider: correcting.body["provider"], model: correcting.body["model"], lane: correcting.body["lane"] });
    expect(correction.result_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(row.extraction_determination_id).toBe(correction.receipt.receipt_id);
    expect(row.extraction_determination_id).not.toBe(original.extraction_determination_id);
    expect(row.evidence_refs).toEqual(correctedResponse.requirements[index]!.evidence_refs.map((id) => correction.evidence_ids[id]));
    const quoted = accepted.quotes.filter((quote) => row.evidence_refs.includes(quote.evidence_id));
    expect(quoted).toHaveLength(1);
    expect(quoted[0]).toMatchObject({ source_id: modelSources(correcting)[0]!.source_id, quote: clauses[index] });
  }
  expect(accepted.requirements[0]!.requirement_id).toBe(value.existingId);
  const newId = accepted.requirements[1]!.requirement_id;
  expect(value.catalog.requirements.map((row) => row.requirement_id)).not.toContain(newId);
  for (const key of ["education", "languages", "language", "unresolved", "extraction_determination_id", "extraction_provenance"])
    expect(accepted[key]).toEqual(value.snapshot[key]);
  expect(accepted.quotes.slice(0, value.snapshot.quotes.length)).toEqual(value.snapshot.quotes);
  expect(accepted.correction_history).toHaveLength(1);
  expect(accepted.correction_history![0]!.corrections).toEqual(payload.corrections);
  expect(meaningAuthority(await json(api, "get", `/v1/requirements/${value.existingId}`))).toEqual(meaningAuthority(value.existingAuthority));
  const newMeaning = await json<{ provenance: { semantic_stage: string; correction: { receipt_id: string }; resolution: { receipt_id: string }[] } }>(api, "get", `/v1/requirements/${newId}`);
  expect(newMeaning.provenance.semantic_stage).toBe("occurrence_correction");
  expect(newMeaning.provenance.correction.receipt_id).toBe(accepted.requirements[1]!.extraction_determination_id);
  expect((await json<Catalog>(api, "get", "/v1/requirements?limit=200")).total).toBe(value.catalog.total + 1);
  for (const original of value.snapshot.requirements) {
    const history = await json<{ rows: Record<string, unknown>[] }>(api, "get", `/v1/requirements/${original.requirement_id}/history?kind=occurrences`);
    const old = history.rows.find((row) => row["occurrence_id"] === original.occurrence_id)!;
    expect(old).toBeTruthy();
    for (const [key, expected] of Object.entries(original)) expect(old[key]).toEqual(expected);
  }
  expect(operations(app, before)).toEqual([ACTION, "requirements.match_catalog"]);
  const beforeReplay = app.external.calls.length;
  expect((await start(api, payload, "occurrence-positive-original")).runId).toBe(run.runId);
  expect(await json<Snapshot>(api, "get", snapshotPath(value.posting))).toEqual(accepted);
  expect(app.external.calls).toHaveLength(beforeReplay);
});

test("scoped occurrence corrections refuse invalid selected IDs evidence and uncertainty atomically", async ({ api, app }) => {
  const value = await seed(api, app, "occurrence-response-guards");
  const failures = ["foreign selected", "missing selected", "duplicate selected", "foreign source", "non-verbatim quote", "foreign evidence", "uncertain"] as const;
  const before = app.external.calls.length;
  for (const defect of failures) {
    const run = await start(api, body(value, defect), `occurrence-response-${defect}`);
    const call = await modelCall(app, ACTION);
    const response = revision(call, value);
    if (defect === "foreign selected") response.requirements[0]!.local_id = value.snapshot.requirements[2]!.occurrence_id;
    if (defect === "missing selected") response.requirements.pop();
    if (defect === "duplicate selected") response.requirements[1]!.local_id = response.requirements[0]!.local_id;
    if (defect === "foreign source") response.quotes[0]!.source_id = "unowned:posting-source";
    if (defect === "non-verbatim quote") response.quotes[0]!.quote = "This exact evidence span does not occur in the saved posting.";
    if (defect === "foreign evidence") response.requirements[0]!.evidence_refs = ["unowned-evidence-id"];
    if (defect === "uncertain") response.status = "needs_review";
    call.reply(response);
    const expectedCode = defect.includes("selected") ? "foreign_or_missing_occurrence_id"
      : defect === "foreign source" ? "foreign_source_id" : defect === "non-verbatim quote" ? "non_verbatim_quote"
        : defect === "foreign evidence" ? "foreign_or_duplicate_evidence_id" : "requirements_correction_uncertain";
    expect(await terminal(api, run.runId)).toMatchObject({ status: "failed", errorCode: expectedCode });
    await retained(api, value);
    expect((await json<Catalog>(api, "get", "/v1/requirements?limit=200")).requirements).toEqual(value.catalog.requirements);
  }
  expect(operations(app, before)).toEqual(failures.map(() => ACTION));
});

test("scoped occurrence corrections reject foreign duplicate oversized and stale input before model work", async ({ api, app }) => {
  const value = await seed(api, app, "occurrence-input-guards");
  const payload = body(value, "Input guard");
  const foreign = (await json<Snapshot>(api, "get", snapshotPath(value.peer))).requirements[0]!.occurrence_id;
  const before = app.external.calls.length;
  const { job_id: _job, ...direct } = payload;
  const cases = [
    { data: { ...direct, corrections: [{ occurrence_id: foreign, reason: "A different job owns this occurrence." }] }, status: 404, code: "not_found" },
    { data: { ...direct, corrections: [payload.corrections[0], payload.corrections[0]] }, status: 422, code: "invalid_correction_selection" },
    { data: { ...direct, corrections: Array.from({ length: 21 }, (_, index) => ({ occurrence_id: `unselected-${index}`, reason: "Oversized selection." })) }, status: 400, code: "invalid_request" },
    { data: { ...direct, expected_revision: value.snapshot.revision + 1 }, status: 409, code: "revision_conflict" },
  ];
  for (const row of cases) {
    const response = await api.post(snapshotPath(value.posting) + "/corrections", { data: row.data });
    expect(response.status(), await response.text()).toBe(row.status);
    expect(await response.json()).toMatchObject({ error: { code: row.code } });
    await retained(api, value);
  }
  expect(app.external.calls).toHaveLength(before);
});

test("scoped occurrence corrections preserve a concurrent snapshot winner and refuse the stale revision batch", async ({ api, app }) => {
  const value = await seed(api, app, "occurrence-snapshot-race");
  await allowOwnedOverlap(api);
  const before = app.external.calls.length;
  const first = await start(api, body(value, "First complete correction"), "occurrence-race-first");
  const firstRevision = await modelCall(app, ACTION);
  const second = await start(api, body(value, "Independent correction"), "occurrence-race-second");
  const secondRevision = await modelCall(app, ACTION);
  firstRevision.reply(revision(firstRevision, value));
  const matching = await modelCall(app, "requirements.match_catalog");
  matching.reply(resolution(matching, value));
  await completed(api, first.runId);
  const winner = await json<Snapshot>(api, "get", snapshotPath(value.posting));
  const catalog = await json<Catalog>(api, "get", "/v1/requirements?limit=200");
  secondRevision.reply(revision(secondRevision, value));
  expect(await terminal(api, second.runId)).toMatchObject({ status: "failed", errorCode: "revision_conflict" });
  const after = await json<Snapshot>(api, "get", snapshotPath(value.posting));
  for (const key of ["revision", "requirements", "education", "languages", "quotes", "correction_history"]) expect(after[key]).toEqual(winner[key]);
  expect((await json<Catalog>(api, "get", "/v1/requirements?limit=200")).requirements).toEqual(catalog.requirements);
  expect(operations(app, before)).toEqual([ACTION, ACTION, "requirements.match_catalog"]);
});

test("scoped occurrence corrections refuse a posting edit during catalog resolution without partial publication", async ({ api, app }) => {
  const value = await seed(api, app, "occurrence-posting-race");
  const before = app.external.calls.length;
  const run = await start(api, body(value, "Source-bound correction"), "occurrence-posting-race");
  const call = await modelCall(app, ACTION);
  call.reply(revision(call, value));
  const held = await modelCall(app, "requirements.match_catalog");
  await json(api, "patch", `/v1/jobs/${value.posting.job_id}`, { expectedRevision: value.posting.revision,
    description: value.posting.description + "\nThe posting source has now changed." });
  held.reply(resolution(held, value));
  expect(await terminal(api, run.runId)).toMatchObject({ status: "failed", errorCode: "revision_conflict" });
  await retained(api, value, true);
  expect((await json<Catalog>(api, "get", "/v1/requirements?limit=200")).requirements).toEqual(value.catalog.requirements);
  expect(operations(app, before)).toEqual([ACTION, "requirements.match_catalog"]);
});

test("scoped occurrence corrections keep the five-call bound through repeated catalog races and exact replay", async ({ api, app }) => {
  const value = await seed(api, app, "occurrence-call-bound");
  await allowOwnedOverlap(api);
  const payload = body(value, "Bounded complete correction");
  const before = app.external.calls.length;
  const run = await start(api, payload, "occurrence-call-bound");
  const call = await modelCall(app, ACTION);
  call.reply(revision(call, value));
  for (let index = 0; index < 4; index += 1) {
    const held = await modelCall(app, "requirements.match_catalog");
    const added = await captureReusePosting(api, `occurrence-catalog-race-${index}`, `Maintain owned operational record ${index + 1}.`);
    await acceptReuseRequirements(api, app, added,
      [{ localId: `record-${index}`, text: added.description }], { [`record-${index}`]: { verdict: "new" } });
    const context = held.body["context"] as CatalogContext;
    const choices: Record<string, CatalogChoice> = {
      [context.incoming[0]!.local_id]: { verdict: "equivalent", requirementId: value.existingId },
      [context.incoming[1]!.local_id]: { verdict: "new" },
    };
    held.reply(catalogMatching(held, choices));
  }
  expect(await terminal(api, run.runId)).toMatchObject({ status: "failed", errorCode: "catalog_changed" });
  await retained(api, value);
  const correctionIds = value.snapshot.requirements.slice(0, 2).map((row) => row.occurrence_id).toSorted();
  const ownCalls = app.external.calls.slice(before).filter((row) => row.body["operation"] === ACTION ||
    row.body["operation"] === "requirements.match_catalog" && JSON.stringify((row.body["context"] as CatalogContext).incoming.map((item) => item.local_id).toSorted()) === JSON.stringify(correctionIds));
  expect(ownCalls.map((row) => row.body["operation"])).toEqual([ACTION, ...Array.from({ length: 4 }, () => "requirements.match_catalog")]);
  const beforeReplay = app.external.calls.length;
  expect((await start(api, payload, "occurrence-call-bound")).runId).toBe(run.runId);
  expect(app.external.calls).toHaveLength(beforeReplay);
});

test("scoped occurrence corrections retain settled revision authority and refuse an interrupted matching call after worker replacement", async ({ api, app }) => {
  const value = await seed(api, app, "occurrence-worker-recovery");
  const payload = body(value, "Bounded recovery");
  const before = app.external.calls.length;
  const run = await start(api, payload, "occurrence-worker-recovery");
  const call = await modelCall(app, ACTION);
  call.reply(revision(call, value));
  const held = await modelCall(app, "requirements.match_catalog");
  const replacement = await app.restartWorker();
  expect(replacement.current).not.toBe(replacement.previous);
  await expect.poll(() => held.closed).toBe(true);
  expect(await terminal(api, run.runId)).toMatchObject({ status: "failed", errorCode: "requirements_correction_call_unsettled" });
  await retained(api, value);
  expect((await json<Catalog>(api, "get", "/v1/requirements?limit=200")).requirements).toEqual(value.catalog.requirements);
  expect(operations(app, before)).toEqual([ACTION, "requirements.match_catalog"]);
  const beforeReplay = app.external.calls.length;
  expect((await start(api, payload, "occurrence-worker-recovery")).runId).toBe(run.runId);
  expect(app.external.calls).toHaveLength(beforeReplay);
});
