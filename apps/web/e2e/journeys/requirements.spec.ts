import {
  test,
  expect,
  json,
  modelCall,
  type ApplicationStack,
  type ExternalCall,
} from "../harness/fixtures.js";
import {
  catalogContext,
  catalogMatching,
  catalogSource,
  citationSelections,
  EXTRACTION_PROMPT_VERSION,
  memberRoots,
  modelSources,
  REFRESH_NORMALIZATION_PROMPT_VERSION,
  typedExtraction,
} from "./requirements-data.js";
import { acceptBaseline, createBaseline } from "./core-data.js";
import { acceptReuseRequirements, captureReusePosting } from "./reuse-data.js";

type Source = { source_id: string; text: string };
type Posting = { job_id: string; revision: number };
type Requirements = {
  revision: number;
  stale: boolean;
  requirements: {
    requirement_id: string;
    spans: { start: number; end: number; quote: string }[];
    provenance: {
      extraction: { provider: string; receipt_id: string };
      resolution: {
        receipt_id: string;
        provider: string;
        model: string;
        lane: string;
      }[];
      catalog_matching: { candidate_count: number; catalog_revision: number };
    };
  }[];
  latest_attempt: { state: string };
};
const sources = (call: ExternalCall) => call.body["sources"] as Source[];

function extraction(call: ExternalCall, definition: string, support = "supported") {
  return typedExtraction(call, {
    requirements: [{ localId: "leadership", text: sources(call)[0]!.text, definition }],
    ...(support === "unsupported" ? { status: "needs_review" as const, classification: "uncertain" as const } : {}),
  });
}

async function novel(app: ApplicationStack) {
  const call = await modelCall(app, "requirements.match_catalog");
  call.reply(catalogMatching(call, { leadership: { verdict: "new" } }));
}

test("requirement meanings reuse recorded IDs and reject invalid or stale refreshes", async ({
  api,
  app,
}) => {
  async function capture(slug: string, description: string) {
    return json<Posting>(api, "post", "/v1/jobs/capture", {
      url: `https://example.com/jobs/${slug}`,
      title: "Synthetic Engineering Leader",
      company: `Synthetic ${slug}`,
      description,
    });
  }
  const first = await capture(
    "five",
    "Lead engineering teams through service incidents.",
  );
  const pendingFirst = api.post(`/v1/jobs/${first.job_id}/requirements`, {
    data: { expected_posting_revision: first.revision, expected_revision: 0 },
  });
  const initial = await modelCall(app, "requirements.extract");
  initial.reply(extraction(initial, "Lead engineering incident response"));
  await novel(app);
  const firstResponse = await pendingFirst;
  expect(firstResponse.status(), await firstResponse.text()).toBe(200);
  const accepted: Requirements = await firstResponse.json();
  const originalId = accepted.requirements[0]!.requirement_id;
  expect(accepted.revision).toBe(1);
  expect(accepted.stale).toBe(false);
  expect(accepted.requirements[0]!.provenance.extraction.provider).toBe(
    "codex",
  );

  const paraphrase = await capture(
    "five-paraphrase",
    "Lead engineering teams during operational incidents.",
  );
  const beforeReuse = app.external.calls.length;
  const pendingReuse = api.post(`/v1/jobs/${paraphrase.job_id}/requirements`, {
    data: {
      expected_posting_revision: paraphrase.revision,
      expected_revision: 0,
    },
  });
  const same = await modelCall(app, "requirements.extract");
  same.reply(extraction(same, "Lead engineering incident response"));
  const compare = await modelCall(app, "requirements.match_catalog");
  compare.reply(
    catalogMatching(compare, {
      leadership: { verdict: "equivalent", requirementId: originalId },
    }),
  );
  const reused = await pendingReuse;
  expect(reused.status(), await reused.text()).toBe(200);
  expect(
    ((await reused.json()) as Requirements).requirements[0]!.requirement_id,
  ).toBe(originalId);
  expect(
    app.external.calls.slice(beforeReuse).map((call) => call.body["operation"]),
  ).toEqual(["requirements.extract", "requirements.match_catalog"]);

  const qualified = await capture(
    "ten",
    "Design a multi-region service architecture.",
  );
  const pendingQualified = api.post(
    `/v1/jobs/${qualified.job_id}/requirements`,
    {
      data: {
        expected_posting_revision: qualified.revision,
        expected_revision: 0,
      },
    },
  );
  const ten = await modelCall(app, "requirements.extract");
  ten.reply(extraction(ten, "Design multi-region service architecture"));
  await novel(app);
  const qualifiedResponse = await pendingQualified;
  expect(qualifiedResponse.status(), await qualifiedResponse.text()).toBe(200);
  expect(
    ((await qualifiedResponse.json()) as Requirements).requirements[0]!
      .requirement_id,
  ).not.toBe(originalId);
  expect(
    (await json<{ total: number }>(api, "get", "/v1/requirements")).total,
  ).toBe(2);

  // Identical canonical source, opposing explicit support verdict. The model
  // controls admission; there is no lexical substitute on refusal.
  const pendingUnsupported = api.post(`/v1/jobs/${first.job_id}/requirements`, {
    data: {
      expected_posting_revision: first.revision,
      expected_revision: 1,
      force: true,
    },
  });
  const unsupported = await modelCall(app, "requirements.extract");
  unsupported.reply(
    extraction(unsupported, "Lead engineering incident response", "unsupported"),
  );
  expect((await pendingUnsupported).status()).toBe(422);
  let retained = await json<Requirements>(
    api,
    "get",
    `/v1/jobs/${first.job_id}/requirements`,
  );
  expect(retained.requirements).toEqual(accepted.requirements);
  expect(retained.revision).toBe(1);

  const pendingInvalid = api.post(`/v1/jobs/${first.job_id}/requirements`, {
    data: {
      expected_posting_revision: first.revision,
      expected_revision: 1,
      force: true,
    },
  });
  const invalid = await modelCall(app, "requirements.extract");
  invalid.reply({
    ...extraction(invalid, "Lead engineering incident response"),
    unauthorizedExtraField: true,
  });
  expect((await pendingInvalid).status()).toBe(502);
  retained = await json<Requirements>(
    api,
    "get",
    `/v1/jobs/${first.job_id}/requirements`,
  );
  expect(retained.requirements).toEqual(accepted.requirements);
  expect(retained.revision).toBe(1);

  const pendingStale = api.post(`/v1/jobs/${first.job_id}/requirements`, {
    data: {
      expected_posting_revision: first.revision,
      expected_revision: 1,
      force: true,
    },
  });
  const stale = await modelCall(app, "requirements.extract");
  await json(api, "patch", `/v1/jobs/${first.job_id}`, {
    expectedRevision: first.revision,
    description: "Lead engineering teams through incident follow-up reviews.",
  });
  stale.reply(extraction(stale, "Lead engineering incident response"));
  expect((await pendingStale).status()).toBe(409);
  retained = await json<Requirements>(
    api,
    "get",
    `/v1/jobs/${first.job_id}/requirements`,
  );
  expect(retained.requirements).toEqual(accepted.requirements);
  expect(retained.stale).toBe(true);
});

test("quote selections derive canonical Unicode ranges and reuse the exact raw extraction receipt", async ({ api, app }) => {
  const quote = "Implement durable workflow recovery.";
  const prefix = "🧭 Authored source context.\n";
  const description = `${prefix}${quote}\nRetain this final source context.`;
  const posting = await json<Posting>(api, "post", "/v1/jobs/capture", {
    url: "https://example.com/jobs/unique-quote-binding",
    title: "Synthetic Quote Binding Engineer", company: "Synthetic Source Company", description,
  });
  const request = { expected_posting_revision: posting.revision, expected_revision: 0 };
  const first = api.post(`/v1/jobs/${posting.job_id}/requirements`, { data: request });
  const extractionCall = await modelCall(app, "requirements.extract");
  expect(extractionCall.body["prompt_version"]).toBe(EXTRACTION_PROMPT_VERSION);
  expect(extractionCall.body["instructions"]).toContain("A topic mentioned only as something an interviewer will ask about does not establish a separate role demand");
  expect(extractionCall.body["instructions"]).toContain("Extract an independently stated responsibility or candidate qualification wherever it appears");
  const schema = extractionCall.body["response_schema"] as { properties: Record<string, unknown> };
  expect(schema.properties).toHaveProperty("quotes");
  expect(schema.properties).toHaveProperty("language");
  const rationale = "The stated implementation work requires the capability to build recovery into workflows.";
  const selected = typedExtraction(extractionCall, { requirements: [{ localId: "leadership", text: quote, basis: "explicit_and_inferred", rationale }] });
  extractionCall.reply(selected);
  const uncertain = await modelCall(app, "requirements.match_catalog");
  uncertain.reply(catalogMatching(uncertain, { leadership: { verdict: "uncertain" } }));
  expect((await first).status()).toBe(422);

  // Repeat the exact public command after the explicit refusal. The accepted
  // extraction is reused through its raw gateway receipt; matching is fresh.
  const retried = api.post(`/v1/jobs/${posting.job_id}/requirements`, { data: request });
  const matching = await modelCall(app, "requirements.match_catalog");
  matching.reply(catalogMatching(matching, { leadership: { verdict: "new" } }));
  const response = await retried;
  expect(response.status(), await response.text()).toBe(200);
  const accepted = await response.json() as Requirements;
  expect(accepted.requirements[0]).toMatchObject({ basis: "explicit_and_inferred", rationale });
  expect(accepted.requirements[0]!.spans).toEqual([{ start: Array.from(prefix).length, end: Array.from(prefix).length + quote.length, quote }]);
  expect(app.external.calls.filter((call) => call.path === "/model").map((call) => call.body["operation"])).toEqual([
    "requirements.extract", "requirements.match_catalog", "requirements.match_catalog",
  ]);

  // Each explicitly forced refresh receives the same source and its own receipt.
  // The gateway must refuse both missing rationales before they reach normalization.
  for (const basis of ["inferred", "explicit_and_inferred"] as const) {
    const before = app.external.calls.length;
    const refresh = api.post(`/v1/jobs/${posting.job_id}/requirements`, { data: { ...request, expected_revision: accepted.revision, force: true } });
    const call = await modelCall(app, "requirements.extract");
    call.reply(typedExtraction(call, { requirements: [{ localId: "leadership", text: quote, basis, rationale: null }] }));
    const refused = await refresh;
    expect(refused.status()).toBe(502);
    expect(await refused.json()).toMatchObject({ error: { code: "model_schema_violation" } });
    const preserved = await json<Requirements>(api, "get", `/v1/jobs/${posting.job_id}/requirements`);
    expect(preserved.requirements).toEqual(accepted.requirements);
    expect(app.external.calls.slice(before).map((entry) => entry.body["operation"])).toEqual(["requirements.extract"]);
  }
});

test("foreign missing ambiguous and legacy numeric quote selections preserve accepted requirements without fallback", async ({ api, app }) => {
  const quote = "Maintain exact workflow recovery.";
  const posting = await json<Posting>(api, "post", "/v1/jobs/capture", {
    url: "https://example.com/jobs/quote-selection-refusal",
    title: "Synthetic Quote Refusal Engineer", company: "Synthetic Source Company",
    description: `${quote}\nRepeated marker.\nRepeated marker.\naaaa`,
  });
  const initial = api.post(`/v1/jobs/${posting.job_id}/requirements`, { data: { expected_posting_revision: posting.revision, expected_revision: 0 } });
  const initialCall = await modelCall(app, "requirements.extract");
  const initialChoice = typedExtraction(initialCall, { requirements: [{ localId: "leadership", text: quote }] });
  initialCall.reply(initialChoice);
  await novel(app);
  const initialResponse = await initial;
  expect(initialResponse.status(), await initialResponse.text()).toBe(200);
  const accepted = await initialResponse.json() as Requirements;
  const failures = [
    { quote, source_id: "foreign-unowned-source", status: 422, code: "foreign_source_id" },
    { quote: "This quote is absent from the authored source.", status: 422, code: "non_verbatim_quote" },
    { quote: "Repeated marker.", status: 422, code: "source_quote_ambiguous" },
    { quote: "aaa", status: 422, code: "source_quote_ambiguous" },
    { quote, start: 0, end: quote.length + 1, status: 502, code: "model_schema_violation" },
  ];
  for (const failure of failures) {
    const before = app.external.calls.length;
    const refreshing = api.post(`/v1/jobs/${posting.job_id}/requirements`, {
      data: { expected_posting_revision: posting.revision, expected_revision: accepted.revision, force: true },
    });
    const call = await modelCall(app, "requirements.extract");
    const choice = typedExtraction(call, { requirements: [{ localId: "leadership", text: quote }] });
    const { status, code, ...selection } = failure;
    call.reply({ ...choice, quotes: [{ ...choice.quotes[0], ...selection }] });
    const response = await refreshing;
    expect(response.status(), await response.text()).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    const retained = await json<Requirements>(api, "get", `/v1/jobs/${posting.job_id}/requirements`);
    expect(retained.revision).toBe(accepted.revision);
    expect(retained.requirements).toEqual(accepted.requirements);
    expect(app.external.calls.slice(before).map((entry) => entry.body["operation"])).toEqual(["requirements.extract"]);
  }
});

test("one catalog determination resolves the full posting batch and more than twelve canonical meanings", async ({
  api,
  app,
}) => {
  const clauses = [
    "Design network routing.", "Manage database recovery.", "Operate container clusters.",
    "Build deployment pipelines.", "Implement access controls.", "Lead incident response.",
    "Review service architecture.", "Manage cloud capacity.", "Build data ingestion.",
    "Implement payment processing.", "Develop mobile applications.", "Design API contracts.",
    "Operate search infrastructure.", "Lead engineering hiring.", "Maintain workflow recovery.",
  ];
  const localIds = clauses.map((_, index) => index === 0 ? "x".repeat(120) : `capability-${index + 1}`);
  const seed = await json<Posting>(api, "post", "/v1/jobs/capture", {
    url: "https://example.com/jobs/full-catalog",
    title: "Synthetic Engineering Leader",
    company: "Synthetic Catalog Company",
    description: clauses.join("\n"),
  });
  const pending = api.post(`/v1/jobs/${seed.job_id}/requirements`, {
    data: { expected_posting_revision: seed.revision, expected_revision: 0 },
  });
  const extracting = await modelCall(app, "requirements.extract");
  extracting.reply(typedExtraction(extracting, { requirements: clauses.map((text, index) => ({
    localId: localIds[index]!, text,
  })) }));
  const seedMatching = await modelCall(app, "requirements.match_catalog");
  expect(
    catalogContext(seedMatching).incoming,
  ).toHaveLength(15);
  expect(catalogContext(seedMatching).members.some((row) => row.member_id === "incoming:" + localIds[0]!)).toBe(true);
  seedMatching.reply(
    catalogMatching(
      seedMatching,
      Object.fromEntries(
        clauses.map((_, index) => [
          localIds[index]!,
          { verdict: "new" as const },
        ]),
      ),
    ),
  );
  const seedResponse = await pending;
  expect(seedResponse.status(), await seedResponse.text()).toBe(200);
  const initial: Requirements = await seedResponse.json();
  expect(initial.requirements).toHaveLength(15);
  const targetId = initial.requirements[14]!.requirement_id;
  const catalog = await json<{ total: number; requirements: unknown[] }>(
    api,
    "get",
    "/v1/requirements?limit=5&offset=10",
  );
  expect(catalog.total).toBe(15);
  expect(catalog.requirements).toHaveLength(5);

  const descriptions = [
    "Maintain durable workflow recovery.",
    "Own the incident recovery program for a global service.",
    "Be accountable for the same global service incident recovery program.",
  ];
  const posting = await json<Posting>(api, "post", "/v1/jobs/capture", {
    url: "https://example.com/jobs/full-batch-reuse",
    title: "Synthetic Engineering Leader",
    company: "Synthetic Batch Company",
    description: descriptions.join("\n"),
  });
  const before = app.external.calls.length;
  const updating = api.post(`/v1/jobs/${posting.job_id}/requirements`, {
    data: { expected_posting_revision: posting.revision, expected_revision: 0 },
  });
  const batch = await modelCall(app, "requirements.extract");
  batch.reply(typedExtraction(batch, { requirements: descriptions.map((text, index) => ({
    localId: ["existing", "new-primary", "new-paraphrase"][index]!, text,
    definition: index === 0 ? "Maintain workflow recovery" : "Own global service incident recovery",
  })) }));
  const matching = await modelCall(app, "requirements.match_catalog");
  const context = catalogContext(matching);
  expect(context.candidates).toHaveLength(15);
  expect(context.incoming).toHaveLength(3);
  for (const candidate of context.candidates) {
    const member = context.members.find((row) => row.requirement_id === candidate.requirement_id && row.revision === candidate.revision);
    expect(member).toBeTruthy();
    expect(
      sources(matching).find(
        (row) => row.source_id === member!.source_id,
      ),
    ).toBeTruthy();
  }
  matching.reply(
    catalogMatching(matching, {
      existing: { verdict: "equivalent", requirementId: targetId },
      "new-primary": { verdict: "new" },
      "new-paraphrase": {
        verdict: "equivalent",
        incomingLocalId: "new-primary",
      },
    }),
  );
  const response = await updating;
  expect(response.status(), await response.text()).toBe(200);
  const accepted: Requirements = await response.json();
  expect(accepted.requirements.map((row) => row.requirement_id)).toEqual([
    targetId,
    accepted.requirements[1]!.requirement_id,
    accepted.requirements[1]!.requirement_id,
  ]);
  expect(accepted.requirements[1]!.requirement_id).not.toBe(targetId);
  const receiptIds = accepted.requirements.flatMap((row) =>
    row.provenance.resolution.map((receipt) => receipt.receipt_id),
  );
  expect(receiptIds).toHaveLength(3);
  expect(new Set(receiptIds).size).toBe(1);
  expect(receiptIds[0]).toBeTruthy();
  for (const row of accepted.requirements) {
    expect(row.provenance.catalog_matching).toMatchObject({
      candidate_count: 15,
      catalog_revision: context.catalog_revision,
    });
    expect(row.provenance.resolution[0]).toMatchObject({
      provider: matching.body["provider"],
      model: matching.body["model"],
      lane: matching.body["lane"],
    });
  }
  expect(
    (await json<{ total: number }>(api, "get", "/v1/requirements")).total,
  ).toBe(16);
  expect(
    app.external.calls.slice(before).map((call) => call.body["operation"]),
  ).toEqual(["requirements.extract", "requirements.match_catalog"]);
  const beforeRetry = app.external.calls.length;
  const unchanged = await json<Requirements>(
    api,
    "post",
    `/v1/jobs/${posting.job_id}/requirements`,
    {
      expected_posting_revision: posting.revision,
      expected_revision: accepted.revision,
    },
  );
  expect(unchanged.requirements).toEqual(accepted.requirements);
  expect(app.external.calls).toHaveLength(beforeRetry);
});

for (const defect of [
  "unknown field",
  "unknown category",
  "incoming reuse ID",
  "foreign source",
  "foreign segment",
  "uncertain",
  "stale revision",
  "provider unavailable",
] as const) {
  test(`catalog ${defect} preserves the accepted requirement IDs without fallback`, async ({
    api,
    app,
  }) => {
    const posting = await json<Posting>(api, "post", "/v1/jobs/capture", {
      url: `https://example.com/jobs/catalog-${defect.replaceAll(" ", "-")}`,
      title: "Synthetic Engineering Leader",
      company: "Synthetic Validation Company",
      description: "Lead engineering teams through service incidents.",
    });
    const first = api.post(`/v1/jobs/${posting.job_id}/requirements`, {
      data: {
        expected_posting_revision: posting.revision,
        expected_revision: 0,
      },
    });
    const initial = await modelCall(app, "requirements.extract");
    initial.reply(extraction(initial, "Lead engineering incident response"));
    await novel(app);
    const initialResponse = await first;
    expect(initialResponse.status(), await initialResponse.text()).toBe(200);
    const accepted: Requirements = await initialResponse.json();
    const before = app.external.calls.length;
    const refresh = api.post(`/v1/jobs/${posting.job_id}/requirements`, {
      data: {
        expected_posting_revision: posting.revision,
        expected_revision: accepted.revision,
        force: true,
      },
    });
    const refreshed = await modelCall(app, "requirements.extract");
    refreshed.reply(extraction(refreshed, "Lead engineering incident response"));
    const matching = await modelCall(app, "requirements.match_catalog");
    const value = catalogMatching(matching, {
      leadership: {
        verdict: "equivalent",
        requirementId: accepted.requirements[0]!.requirement_id,
      },
    });
    const { groupId, slot: capability } = memberRoots(value)[0]!;
    if (defect === "incoming reuse ID") {
      const input = catalogContext(matching);
      matching.reply({ ...value, capability_groups: { ...value.capability_groups,
        [groupId]: { ...capability, reuse_requirement_id: input.incoming[0]!.member_id } } });
    }
    if (defect === "unknown field")
      matching.reply({ ...value, unrequested: true });
    if (defect === "unknown category")
      matching.reply({
        ...value,
        capability_groups: { ...value.capability_groups, [groupId]: { ...capability, category: "approximately_skill" } },
      });
    if (defect === "foreign source")
      matching.reply({
        ...value,
        capability_groups: { ...value.capability_groups, [groupId]: {
            ...capability,
            citations: [
              { ...capability.citations[0]!, source_id: "unrecorded:foreign" },
              ...capability.citations.slice(1),
            ],
          } },
      });
    if (defect === "foreign segment")
      matching.reply({
        ...value,
        capability_groups: { ...value.capability_groups, [groupId]: {
            ...capability,
            citations: [
              {
                ...capability.citations[0]!,
                segment_id: "unrecorded:foreign-segment",
              },
              ...capability.citations.slice(1),
            ],
          } },
      });
    if (defect === "uncertain") {
      const context = catalogContext(matching);
      matching.reply({
        ...value,
        status: "needs_review",
        member_slots: Object.fromEntries(context.members.map((member) => [member.member_id, { kind: "unresolved",
          reason: "Explicit source-bound uncertainty; no partial publication.", citations: citationSelections(matching, [
            { sourceId: context.catalog_inventory_source_id }, { sourceId: member.source_id,
              valuePath: member.requirement_id === null ? ["definition"] : ["canonical", "definition"] },
          ]) }])),
        occurrence_slots: Object.fromEntries(context.occurrences.map((occurrence) => [occurrence.occurrence_id, { kind: "unresolved",
          reason: "Explicit source-bound demand uncertainty; no partial publication.", citations: citationSelections(matching, [
            { sourceId: context.catalog_inventory_source_id }, { sourceId: occurrence.source_id, valuePath: ["original", "spans", 0, "quote"] },
          ]) }])),
      });
    }
    if (defect === "stale revision")
      matching.reply({
        ...value,
        catalog_revision: value.catalog_revision - 1,
      });
    if (defect === "provider unavailable")
      matching.respond({ error: "synthetic_provider_unavailable" }, 503);
    const result = await refresh;
    expect(result.status(), await result.text()).toBe(
      defect === "unknown field" ||
        defect === "unknown category" ||
        defect === "incoming reuse ID" ||
        defect === "foreign source" ||
        defect === "provider unavailable"
        ? 502
        : defect === "stale revision"
          ? 409
          : 422,
    );
    if (defect === "provider unavailable") {
      const error = (await result.json()).error;
      expect(error).toMatchObject({ code: "model_provider_failed", details: { receiptId: expect.any(String) } });
      expect(await json(api, "get", `/v1/jobs/${posting.job_id}/requirements/attempts/latest`)).toMatchObject({
        state: "blocked", failure_code: error.code, failure_details: { receiptId: error.details.receiptId },
      });
    }
    if (defect === "incoming reuse ID") {
      const schema = matching.body["response_schema"] as { $defs: { RetainedCapabilityId: { enum: string[] } } };
      expect(schema.$defs.RetainedCapabilityId.enum).toEqual([accepted.requirements[0]!.requirement_id]);
      expect(await result.json()).toMatchObject({ error: { code: "model_schema_violation" } });
    }
    const retained = await json<Requirements>(
      api,
      "get",
      `/v1/jobs/${posting.job_id}/requirements`,
    );
    expect(retained.requirements).toEqual(accepted.requirements);
    expect(retained.revision).toBe(accepted.revision);
    expect(
      (await json<{ total: number }>(api, "get", "/v1/requirements")).total,
    ).toBe(1);
    expect(
      app.external.calls.slice(before).map((call) => call.body["operation"]),
    ).toEqual(["requirements.extract", "requirements.match_catalog"]);
  });
}

test("an oversized complete catalog request refuses without truncation or automatic continuation and preserves acceptance", async ({
  api,
  app,
}, info) => {
  const { profile } = await createBaseline(api);
  const posting = await json<Posting>(api, "post", "/v1/jobs/capture", {
    url: "https://example.com/jobs/full-input-refusal",
    title: "Synthetic Engineering Leader",
    company: "Synthetic Payload Company",
    description: "Lead engineering teams through service incidents.",
  });
  const first = api.post(`/v1/jobs/${posting.job_id}/requirements`, {
    data: { expected_posting_revision: posting.revision, expected_revision: 0 },
  });
  const initial = await modelCall(app, "requirements.extract");
  initial.reply(extraction(initial, "Lead engineering incident response"));
  await novel(app);
  const initialResponse = await first;
  expect(initialResponse.status(), await initialResponse.text()).toBe(200);
  const accepted: Requirements = await initialResponse.json();

  const resume = await acceptBaseline(api, posting.job_id, profile.profileVersion);
  const pdfPath = `/v1/resumes/${resume.resume_id}/export?format=pdf&accepted=true`;
  const originalPdf = await api.get(pdfPath);
  expect(originalPdf.status(), await originalPdf.text()).toBe(200);
  const acceptedPdfBytes = await originalPdf.body();

  // A bounded valid extraction can still exceed the model's input boundary
  // once every incoming qualified meaning and the entire catalog are supplied.
  // All common qualifications are authored in this posting; no internal state
  // or model payload limit is replaced to create the refusal.
  const qualifiers = Array.from({ length: 24 }, (_, index) => ({
    dimension: `operating-condition-${index + 1}`,
    value: `Condition ${index + 1}: ${"Maintain documented ownership, reviewed recovery procedures, explicit source records and supervised operational changes. ".repeat(2)}`,
  }));
  const clauses = Array.from(
    { length: 100 },
    (_, index) =>
      `Own operational responsibility ${index + 1} under every stated operating condition.`,
  );
  const revisedDescription = [
    "Every responsibility below requires all of these conditions:",
    ...qualifiers.map((row) => row.value), ...clauses,
  ].join("\n");
  const revised = await json<Posting>(
    api,
    "patch",
    `/v1/jobs/${posting.job_id}`,
    {
      expectedRevision: posting.revision,
      description: revisedDescription,
    },
  );
  const refresh = () => api.post(`/v1/jobs/${posting.job_id}/requirements`, {
    data: {
      expected_posting_revision: revised.revision,
      expected_revision: accepted.revision,
      force: true,
    },
  });
  const conditions = qualifiers.map((row) => row.value).join(" ");
  const extracted = (call: ExternalCall, includeClause: boolean) => typedExtraction(call, { requirements: clauses.map((text, index) => ({
    localId: `responsibility-${index + 1}`, text,
    definition: `${text} ${conditions}`.slice(0, 2500),
    rationale: includeClause ? `${text} ${conditions}`.slice(0, 1990) : conditions.slice(0, 1900),
    sourceNote: includeClause ? `${text} ${conditions.slice(-1900)}` : conditions.slice(-1900),
  })) });
  const repeatedRequest = refresh();
  const repeated = await modelCall(app, "requirements.extract");
  repeated.reply(extracted(repeated, false));
  const packed = await modelCall(app, "requirements.match_catalog");
  expect(packed.body["prompt_version"]).toBe(REFRESH_NORMALIZATION_PROMPT_VERSION);
  const context = catalogContext(packed);
  expect(context.members).toHaveLength(101);
  expect(context.incoming).toHaveLength(100);
  const sentBytes = Buffer.byteLength(JSON.stringify(packed.body));
  const originalSourceBytes = modelSources(packed).reduce((total, source) =>
    total + Buffer.byteLength(JSON.stringify(catalogSource(packed, source.source_id))), 0);
  expect(sentBytes).toBeLessThan(1024 * 1024);
  expect(originalSourceBytes).toBeGreaterThan(1024 * 1024);
  await info.attach("complete-catalog-size", { contentType: "application/json", body: JSON.stringify({ sentBytes, originalSourceBytes }) });
  // A settled, incomplete partition cannot publish these requirements.
  packed.reply({ status: "needs_review", catalog_revision: context.catalog_revision });
  expect(await (await repeatedRequest).json()).toMatchObject({ error: { code: "model_schema_violation" } });

  const distinctRequest = refresh();
  const distinct = await modelCall(app, "requirements.extract");
  distinct.reply(extracted(distinct, true));
  const distinctComparison = await modelCall(app, "requirements.match_catalog");
  const distinctContext = catalogContext(distinctComparison);
  expect(distinctContext.incoming).toHaveLength(100);
  const distinctBytes = Buffer.byteLength(JSON.stringify(distinctComparison.body));
  expect(distinctBytes).toBeLessThan(1024 * 1024);
  await info.attach("distinct-complete-catalog-size", { contentType: "application/json", body: JSON.stringify({ distinctBytes }) });
  distinctComparison.reply({ status: "needs_review", catalog_revision: distinctContext.catalog_revision });
  expect(await (await distinctRequest).json()).toMatchObject({ error: { code: "model_schema_violation" } });

  // Retained posting bodies are also part of the real input, even when each
  // contributes a single occurrence of the same accepted requirement.
  for (let index = 1; index <= 6; index++) {
    const clause = "Lead engineering teams through service incidents.";
    const notes = Array.from({ length: 570 }, (_, n) =>
      `Synthetic posting ${index}, project ${n + 1}: verify the documented ownership and approved incident review schedule.`).join("\n");
    const retainedPosting = await captureReusePosting(api, `full-input-retained-${index}`, `${clause}\n${notes}`);
    await acceptReuseRequirements(api, app, retainedPosting, [{ localId: "leadership", text: clause }],
      { leadership: { verdict: "equivalent", requirementId: accepted.requirements[0]!.requirement_id } });
  }
  const before = app.external.calls.length;
  const uniqueRequest = refresh();
  const extracting = await modelCall(app, "requirements.extract");
  const result = extracted(extracting, true);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024 * 1024);
  extracting.reply(result);
  const response = await uniqueRequest;
  expect(response.status(), await response.text()).toBe(503);
  const error = (await response.json()).error;
  expect(error).toMatchObject({ code: "requirements_catalog_unavailable", details: {
    reason: "structural_payload_too_large", model_failure_code: "model_input_too_large",
    candidate_count: 1, incoming_count: 100, catalog_revision: expect.any(Number),
  } });
  const latest = (id: string) => json(api, "get", `/v1/jobs/${id}/requirements/attempts/latest`);
  expect(await latest(posting.job_id)).toMatchObject({ state: "blocked", failure_code: error.code, failure_details: error.details });
  const retained = await json<Requirements>(
    api,
    "get",
    `/v1/jobs/${posting.job_id}/requirements`,
  );
  expect(retained.requirements).toEqual(accepted.requirements);
  const retainedPdf = await api.get(pdfPath);
  expect(retainedPdf.status(), await retainedPdf.text()).toBe(200);
  expect(await retainedPdf.body()).toEqual(acceptedPdfBytes);
  expect(retained.revision).toBe(accepted.revision);
  expect(retained.stale).toBe(true);
  expect(
    (await json<{ total: number }>(api, "get", "/v1/requirements")).total,
  ).toBe(1);
  expect(
    app.external.calls.slice(before).map((call) => call.body["operation"]),
  ).toEqual(["requirements.extract"]);

  const fresh = await captureReusePosting(api, "full-input-first-attempt", revisedDescription);
  expect(await latest(fresh.job_id)).toBeNull();
  const beforeFirst = app.external.calls.length;
  const attempting = api.post(`/v1/jobs/${fresh.job_id}/requirements`, {
    data: { expected_posting_revision: fresh.revision, expected_revision: 0, force: true },
  });
  const firstExtraction = await modelCall(app, "requirements.extract");
  firstExtraction.reply(extracted(firstExtraction, true));
  const firstRefused = await attempting;
  expect(firstRefused.status()).toBe(503);
  expect((await firstRefused.json()).error).toEqual(error);
  expect(await json(api, "get", `/v1/jobs/${fresh.job_id}/requirements`)).toBeNull();
  expect(await latest(fresh.job_id)).toMatchObject({ job_id: fresh.job_id, state: "blocked", failure_code: error.code, failure_details: error.details });
  expect(app.external.calls.slice(beforeFirst).map(call => call.body["operation"])).toEqual(["requirements.extract"]);
});
