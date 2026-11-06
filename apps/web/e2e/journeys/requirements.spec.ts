import {
  test,
  expect,
  json,
  modelCall,
  type ApplicationStack,
  type ExternalCall,
} from "../harness/fixtures.js";

type Source = { source_id: string; text: string };
type Candidate = { requirement_id: string; revision: number };
type Posting = { job_id: string; revision: number };
type Requirements = {
  revision: number;
  stale: boolean;
  requirements: {
    requirement_id: string;
    provenance: { extraction: { provider: string; determination_id: string } };
  }[];
  latest_attempt: { state: string };
};
const sources = (call: ExternalCall) => call.body["sources"] as Source[];

function extraction(
  call: ExternalCall,
  duration: string,
  support = "supported",
) {
  const source = sources(call)[0]!;
  return {
    status: "complete",
    requirements: [
      {
        local_id: "leadership",
        text: source.text,
        definition: "Lead engineering teams",
        qualifiers: [{ dimension: "duration", value: duration }],
        scope: "resume",
        tier: "must_have",
        weight: 1,
        support,
        spans: [{ start: 0, end: source.text.length, quote: source.text }],
      },
    ],
    reason: "Explicit source-bound determination for this controlled journey.",
    citations: [{ source_id: source.source_id, quote: source.text }],
  };
}

function comparisons(call: ExternalCall, equivalentId?: string) {
  const context = call.body["context"] as { candidates: Candidate[] };
  return {
    decisions: context.candidates.map((candidate) => ({
      requirement_id: candidate.requirement_id,
      requirement_revision: candidate.revision,
      relation:
        candidate.requirement_id === equivalentId ? "equivalent" : "distinct",
      reason:
        "Explicit qualified-meaning decision, bound to the recorded canonical ID.",
      citations: sources(call)
        .filter(
          (row, index) =>
            index === 0 ||
            row.source_id ===
              `requirement:${candidate.requirement_id}:${candidate.revision}`,
        )
        .map((row) => ({ source_id: row.source_id, quote: row.text })),
    })),
  };
}

async function novel(app: ApplicationStack) {
  const call = await modelCall(app, "requirements.novelty");
  call.reply({
    verdict: "new",
    reason:
      "The explicit complete catalog sweep supports a new qualified meaning.",
    citations: sources(call).map((row) => ({
      source_id: row.source_id,
      quote: row.text,
    })),
  });
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
    "At least five years leading engineering teams.",
  );
  const pendingFirst = api.post(`/v1/jobs/${first.job_id}/requirements`, {
    data: { expected_posting_revision: first.revision, expected_revision: 0 },
  });
  const initial = await modelCall(app, "requirements.extract");
  initial.reply(extraction(initial, "at least five years"));
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
    "A minimum of five years managing engineering teams.",
  );
  const beforeReuse = app.external.calls.length;
  const pendingReuse = api.post(`/v1/jobs/${paraphrase.job_id}/requirements`, {
    data: {
      expected_posting_revision: paraphrase.revision,
      expected_revision: 0,
    },
  });
  const same = await modelCall(app, "requirements.extract");
  same.reply(extraction(same, "at least five years"));
  const compare = await modelCall(app, "requirements.compare");
  compare.reply(comparisons(compare, originalId));
  const reused = await pendingReuse;
  expect(reused.status(), await reused.text()).toBe(200);
  expect(
    ((await reused.json()) as Requirements).requirements[0]!.requirement_id,
  ).toBe(originalId);
  expect(
    app.external.calls.slice(beforeReuse).map((call) => call.body["operation"]),
  ).toEqual(["requirements.extract", "requirements.compare"]);

  const qualified = await capture(
    "ten",
    "At least ten years leading engineering teams.",
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
  ten.reply(extraction(ten, "at least ten years"));
  const distinct = await modelCall(app, "requirements.compare");
  distinct.reply(comparisons(distinct));
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
    extraction(unsupported, "at least five years", "unsupported"),
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
    ...extraction(invalid, "at least five years"),
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
    description: "At least six years leading engineering teams.",
  });
  stale.reply(extraction(stale, "at least five years"));
  expect((await pendingStale).status()).toBe(409);
  retained = await json<Requirements>(
    api,
    "get",
    `/v1/jobs/${first.job_id}/requirements`,
  );
  expect(retained.requirements).toEqual(accepted.requirements);
  expect(retained.stale).toBe(true);
});
