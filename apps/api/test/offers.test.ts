import { OutreachGenerationError } from "../src/outreach-generation-errors.js";
import type { OutreachDraftGenerator } from "../src/local-actions.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobCtrlApiClient } from "@jobctrl/api-client";
import { SaveOfferTermsSchema } from "@jobctrl/contracts";
import { buildApp } from "../src/server.js";
import { offerEventReferences } from "../src/offers.js";
import { initializeExactDatabase } from "./exact-schema.js";

const JOB = "00000000-0000-4000-8000-000000000003";
const OTHER = "00000000-0000-4000-8000-000000000004";
const source = {
  reference: "Synthetic offer letter",
  quote: "Base EUR 90000 per year. All other terms unconfirmed.",
  capturedAt: "2026-10-18T10:00:00.000Z",
  userConfirmed: true,
};
const terms = {
  source,
  cash: [
    {
      component: "base_salary",
      amount: 90000,
      currency: "EUR",
      period: "year",
      source,
    },
  ],
  equity: null,
  benefits: null,
  decisionDeadline: null,
};
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-offer-"));
  const dbPath = path.join(dir, "jobctrl.db");
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  for (const job of [JOB, OTHER])
    db.prepare(
      "INSERT INTO jobs(tenant_id,job_id,url) VALUES ('local',?,?)",
    ).run(job, `https://synthetic.example/${job}`);
  db.close();
  const generator = vi.fn<OutreachDraftGenerator>(async () => ({
    threadId: "offer-thread",
    contactId: "contact",
    jobId: JOB,
    draftId: "draft",
    generation: 1,
    kind: "offer_negotiation",
    status: "candidate",
    gatePassed: true,
  }));
  const app = buildApp({
    dbPath,
    configPath: path.join(dir, "config.json"),
    requireHealthyWorkerForActions: false,
    outreachDraftGenerator: generator,
  });
  cleanups.push(
    () => fs.rmSync(dir, { recursive: true, force: true }),
    () => app.close(),
  );
  const post = (suffix: string, payload: Record<string, unknown>, job = JOB) =>
    app.inject({
      method: "POST",
      url: `/v1/jobs/${job}/offer/${suffix}`,
      payload,
    });
  return { app, dbPath, post, generator };
}

describe("actual offer HTTP lifecycle", () => {
  it("records sourced actual terms without inventing unknowns or requiring interview prep", async () => {
    const { app, dbPath, post } = setup();
    const response = await post("terms", { expectedRevisionId: null, terms });
    expect(response.statusCode).toBe(200);
    const value = response.json();
    expect(value.currentTerms.terms).toEqual(terms);
    expect(value.currentDecision).toBeNull();
    expect(value.termsHistory).toHaveLength(1);
    const db = new Database(dbPath);
    expect(
      db
        .prepare(
          "SELECT kind, interview_prep_generation FROM application_outcomes",
        )
        .all(),
    ).toEqual([{ kind: "offer", interview_prep_generation: null }]);
    expect(
      db.prepare("SELECT COUNT(*) n FROM application_review_decisions").get(),
    ).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM job_stage_states").get()).toEqual(
      { n: 0 },
    );
    db.close();
    expect(
      (await app.inject(`/v1/jobs/${OTHER}/offer`)).json().currentTerms,
    ).toBeNull();
  });

  it("retains the exact user-quoted whitespace", async () => {
    const { post } = setup();
    const quoted = "  Synthetic exact source\n\n";
    const response = await post("terms", {
      expectedRevisionId: null,
      terms: { ...terms, source: { ...source, quote: quoted } },
    });
    expect(response.json().currentTerms.terms.source.quote).toBe(quoted);
  });

  it("reuses an existing reviewed offer milestone", async () => {
    const { dbPath, post } = setup();
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO application_outcomes(tenant_id,outcome_id,job_id,kind,source,occurred_at,recorded_at) VALUES ('local','prior-offer',?,'offer','manual',?,?)",
    ).run(JOB, source.capturedAt, source.capturedAt);
    db.close();
    expect(
      (await post("terms", { expectedRevisionId: null, terms })).statusCode,
    ).toBe(200);
    const verify = new Database(dbPath);
    expect(
      verify
        .prepare(
          "SELECT outcome_id FROM application_outcomes WHERE tenant_id='local' AND job_id=?",
        )
        .all(JOB),
    ).toEqual([{ outcome_id: "prior-offer" }]);
    verify.close();
  });

  it("serializes concurrent terms writes and preserves corrected terms and conflicting decision history", async () => {
    const { app, dbPath, post } = setup();
    const responses = await Promise.all([
      post("terms", { expectedRevisionId: null, terms }),
      post("terms", { expectedRevisionId: null, terms }),
    ]);
    expect(responses.map((result) => result.statusCode).sort()).toEqual([
      200, 409,
    ]);
    const saved = responses
      .find((result) => result.statusCode === 200)!
      .json().currentTerms;
    const body = {
      expectedDecisionId: null,
      termsRevisionId: saved.revisionId,
      decision: "accepted",
      occurredAt: "2026-10-18T11:00:00Z",
      source,
    };
    const accepted = (await post("decisions", body)).json().currentDecision;
    expect(accepted.decision).toBe("accepted");
    expect(
      (await post("decisions", { ...body, decision: "declined" })).statusCode,
    ).toBe(409);
    expect(
      (
        await post("decisions", {
          ...body,
          expectedDecisionId: accepted.decisionId,
          decision: "declined",
        })
      ).statusCode,
    ).toBe(409);
    const corrected = (
      await post("decisions", {
        ...body,
        expectedDecisionId: accepted.decisionId,
        decision: "declined",
        correctionReason: "Corrected synthetic attestation",
      })
    ).json();
    expect(
      corrected.decisions.map((row: { decision: string }) => row.decision),
    ).toEqual(["accepted", "declined"]);
    expect(corrected.currentDecision.expectedDecisionId).toBe(
      accepted.decisionId,
    );
    const revised = (
      await post("terms", {
        expectedRevisionId: saved.revisionId,
        terms: {
          ...terms,
          decisionDeadline: { value: "2026-11-01T12:00:00Z", source },
        },
        correctionReason: "Employer extended deadline",
      })
    ).json();
    expect(revised.termsHistory).toHaveLength(2);
    expect(revised.currentDecision.termsRevisionId).toBe(saved.revisionId);
    expect(
      (
        await post("decisions", {
          ...body,
          expectedDecisionId: corrected.currentDecision.decisionId,
          correctionReason: "Reconfirmation",
        })
      ).statusCode,
    ).toBe(409);
    const db = new Database(dbPath);
    expect(
      db.prepare("SELECT COUNT(*) n FROM application_outcomes").get(),
    ).toEqual({ n: 1 });
    db.close();
    expect((await app.inject(`/v1/jobs/${JOB}/offer`)).json()).toEqual(revised);
  });

  it("rejects foreign revisions, malformed terms, unconfirmed sources and implicit units", async () => {
    const { post, app } = setup();
    expect(
      SaveOfferTermsSchema.safeParse({
        expectedRevisionId: null,
        terms: { ...terms, cash: [{ ...terms.cash[0], period: undefined }] },
      }).success,
    ).toBe(false);
    for (const invalid of [
      { ...terms, source: { ...source, userConfirmed: false } },
      { ...terms, cash: [{ ...terms.cash[0], currency: "euros" }] },
      { ...terms, benefits: "assumed" },
      { ...terms, decisionDeadline: { value: "tomorrow", source } },
      { ...terms, inventedRoi: 200 },
    ])
      expect(
        (await post("terms", { expectedRevisionId: null, terms: invalid }))
          .statusCode,
      ).toBe(400);
    const saved = (
      await post("terms", { expectedRevisionId: null, terms })
    ).json().currentTerms;
    expect(
      (
        await post(
          "decisions",
          {
            expectedDecisionId: null,
            termsRevisionId: saved.revisionId,
            decision: "accepted",
            occurredAt: source.capturedAt,
            source,
          },
          OTHER,
        )
      ).statusCode,
    ).toBe(409);
    expect((await app.inject("/v1/jobs/not-an-id/offer")).statusCode).toBe(400);
  });

  it("keeps private sources out of general activity and audit history, exposing only SSE references", async () => {
    const { app, post } = setup();
    const saved = (
      await post("terms", { expectedRevisionId: null, terms })
    ).json();
    expect(offerEventReferences({ termsRevision: saved.currentTerms })).toEqual(
      { revisionId: saved.currentTerms.revisionId, decisionId: null },
    );
    const activity = await app.inject("/v1/activity");
    const detail = await app.inject(`/v1/jobs/${JOB}`);
    for (const response of [activity, detail]) {
      expect(response.body).not.toContain(source.quote);
      expect(response.body).not.toContain(source.reference);
    }
  });

  it("routes stage-specific drafts and refuses stale reviewed offer source bindings", async () => {
    const { app, post, generator, dbPath } = setup();
    const saved = (
      await post("terms", { expectedRevisionId: null, terms })
    ).json().currentTerms;
    const generated = await app.inject({
      method: "POST",
      url: "/v1/contacts/contact/outreach/drafts",
      payload: {
        jobId: JOB,
        kind: "offer_negotiation",
        offerRevisionId: saved.revisionId,
      },
    });
    expect(generated.statusCode).toBe(200);
    expect(generator.mock.calls[0]?.[0]).toMatchObject({
      jobId: JOB,
      kind: "offer_negotiation",
      offerRevisionId: saved.revisionId,
    });
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO outreach_threads(tenant_id,thread_id,contact_id,job_id,created_at,updated_at) VALUES ('local','thread','contact',?,?,?)",
    ).run(JOB, source.capturedAt, source.capturedAt);
    const gate = {
      passed: true,
      computedAgainst: "rendered_draft",
      fabrications: [],
      validation: { passed: true, errors: [], warnings: [] },
      judge: { approved: true },
      sourceContext: {
        binding: {
          jobId: JOB,
          termsRevisionId: saved.revisionId,
          decisionId: null,
        },
        sources: [],
        fingerprint: "synthetic",
      },
    };
    db.prepare(
      "INSERT INTO outreach_drafts(tenant_id,draft_id,thread_id,generation,kind,status,body_text,gate_results_json,created_at) VALUES ('local','draft','thread',1,'offer_negotiation','candidate','Synthetic message',?,?)",
    ).run(JSON.stringify(gate), source.capturedAt);
    db.close();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/outreach/threads/thread/drafts/draft/approve",
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    await post("terms", {
      expectedRevisionId: saved.revisionId,
      terms,
      correctionReason: "Source correction",
    });
    const thread = (
      await app.inject(`/v1/contacts/contact/outreach?jobId=${JOB}`)
    ).json().thread;
    expect(thread.drafts[0].status).toBe("approved");
    expect(thread.drafts[0].offerSourcesCurrent).toBe(false);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/outreach/threads/thread/send-logs",
          payload: {
            draftId: "draft",
            channel: "email",
            sentAt: source.capturedAt,
          },
        })
      ).statusCode,
    ).toBe(409);
  });

  it.each([
    ["provider_unavailable", 503],
    ["budget_denied", 429],
    ["schema_violation", 502],
    ["offer_sources_changed", 409],
  ] as const)(
    "reports %s safely without accepting a replacement",
    async (code, status) => {
      const { app, generator } = setup();
      generator.mockRejectedValueOnce(new OutreachGenerationError(code));
      const response = await app.inject({
        method: "POST",
        url: "/v1/contacts/contact/outreach/drafts",
        payload: { jobId: JOB, kind: "offer_negotiation" },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().error).toBe(code);
      expect(response.body).not.toContain(source.quote);
    },
  );

  it("exercises offer methods through the production HTTP client", async () => {
    const { app } = setup();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) =>
        realFetch(input, {
          ...init,
          headers: { ...init?.headers, Origin: "http://127.0.0.1:5173" },
        }),
    );
    const client = new JobCtrlApiClient(app.listeningOrigin);
    expect((await client.jobOffer(JOB)).currentTerms).toBeNull();
    const saved = await client.saveOfferTerms(JOB, {
      expectedRevisionId: null,
      terms: SaveOfferTermsSchema.parse({ expectedRevisionId: null, terms })
        .terms,
    });
    const decision = await client.recordOfferDecision(JOB, {
      expectedDecisionId: null,
      termsRevisionId: saved.currentTerms!.revisionId,
      decision: "accepted",
      occurredAt: source.capturedAt,
      source: { ...source, userConfirmed: true },
    });
    expect(decision.currentDecision?.decision).toBe("accepted");
  });
});
