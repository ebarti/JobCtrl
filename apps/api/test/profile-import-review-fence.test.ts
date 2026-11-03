import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { buildApp } from "../src/server.js";
import { initializeExactDatabase } from "./exact-schema.js";
import { recordImportAttempt, recordResumeExtraction } from "./profile-import-fixtures.js";
import { recordModelDecision } from "./semantic-fixtures.js";

const profile = (name: string) => ({
  personal: { full_name: name },
  resume: {
    experience_entries: [
      {
        id: "synthetic-role",
        title: "Synthetic role",
        company: "Synthetic company",
      },
    ],
  },
});

it("fences first-profile creation and preserves a newer profile after a stale import review", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "jobctrl-import-review-fence-"),
  );
  const dbPath = path.join(directory, "synthetic.db");
  initializeExactDatabase(dbPath);
  const fixtureDb = new Database(dbPath);
  const determinationId = recordResumeExtraction(fixtureDb, { full_name: "Synthetic imported" });
  fixtureDb.close();
  const importer = vi.fn(async (input) => {
    const db = new Database(dbPath);
    try { return { profile: profile("Synthetic imported"), source: recordImportAttempt(db, input, determinationId) }; }
    finally { db.close(); }
  });
  const app = buildApp({
    dbPath,
    configPath: path.join(directory, "config.json"),
    profileImporter: importer,
    actionDispatcher: vi.fn(async () => ({
      status: "queued",
      runId: "synthetic",
    })),
  });
  try {
    const initial = await app.inject({ method: "GET", url: "/v1/profile" });
    expect(initial.json().profileVersion).toBeNull();
    const extraction = await app.inject({
      method: "POST",
      url: "/v1/profile/import-resume",
      payload: {
        filename: "synthetic.pdf",
        pdfBase64: Buffer.from("%PDF synthetic").toString("base64"),
        importProfile: true,
        importStyle: false,
      },
    });
    expect(extraction.statusCode, extraction.body).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/v1/profile" })).json()
        .profileVersion,
    ).toBeNull();
    const newer = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: {
        profile: profile("Synthetic newer"),
        expectedProfileVersion: null,
      },
    });
    expect(newer.statusCode, newer.body).toBe(200);
    const stale = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: {
        // The source-only draft is partial; a reviewed Profile must also be
        // valid before this test can reach the version fence.
        profile: { ...profile("Synthetic imported"), personal: extraction.json().profile.personal },
        expectedProfileVersion: null,
      },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({
      error: "stale_profile_version",
      expectedProfileVersion: null,
      actualProfileVersion: newer.json().profileVersion,
    });
    expect(
      (await app.inject({ method: "GET", url: "/v1/profile" })).json().profile
        .personal.full_name,
    ).toBe("Synthetic newer");
    expect((await app.inject({ method: "GET", url: "/v1/profile" })).json()).toEqual(newer.json());
  } finally {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("accepts an explicitly reviewed first profile against the empty version", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "jobctrl-import-first-save-"),
  );
  const dbPath = path.join(directory, "synthetic.db");
  initializeExactDatabase(dbPath);
  const app = buildApp({
    dbPath,
    configPath: path.join(directory, "config.json"),
    actionDispatcher: vi.fn(async () => ({
      status: "queued",
      runId: "synthetic",
    })),
  });
  try {
    const saved = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: {
        profile: profile("Synthetic reviewed"),
        expectedProfileVersion: null,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().profileVersion).toBe(1);
    expect(saved.json().profile.personal.full_name).toBe("Synthetic reviewed");
  } finally {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("saves selected imported experience without replacing accepted evidence", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "jobctrl-import-evidence-"),
  );
  const dbPath = path.join(directory, "synthetic.db");
  initializeExactDatabase(dbPath);
  const imported = {
    resume: {
      experience_entries: [
        {
          id: "imported",
          title: "Synthetic new role",
          company: "Synthetic new company",
          bullets: ["Synthetic imported bullet"],
          achievement_evidence: [{ user_confirmed: true }],
        },
      ],
    },
  };
  const fixtureDb = new Database(dbPath);
  const field = (value: string) => ({ value, citations: [{ source_id: "resume", quote: value, exact_values: [] }] });
  const determinationId = recordModelDecision(fixtureDb, "resume_extraction", "resume-import", {
    personal: Object.fromEntries(["full_name", "email", "phone", "linkedin", "github", "website", "city", "country"].map((name) => [name, null])),
    executive_profile: null, experience: [{ title: field("Synthetic new role"), company: field("Synthetic new company"),
      date_range: null, location: null, summary: null, bullets: [field("Synthetic imported bullet")] }], education: [], skills: [],
  });
  fixtureDb.close();
  const app = buildApp({
    dbPath,
    configPath: path.join(directory, "config.json"),
    profileImporter: async (input) => {
      const db = new Database(dbPath);
      try { return { profile: imported, source: recordImportAttempt(db, input, determinationId) }; }
      finally { db.close(); }
    },
    actionDispatcher: vi.fn(async () => ({
      status: "queued",
      runId: "synthetic",
    })),
  });
  try {
    const original = profile("Synthetic original");
    const resume = original.resume as {
      experience_entries: Array<Record<string, unknown>>;
    };
    resume.experience_entries[0]!.achievement_evidence = [
      {
        id: "synthetic-evidence",
        source_text: "Synthetic accepted evidence",
        user_confirmed: true,
        evidence_strength: "verified",
        claim_confidence: 1,
      },
    ];
    const first = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: { profile: original, expectedProfileVersion: null },
    });
    expect(first.statusCode, first.body).toBe(200);
    const base = first.json();
    const extraction = await app.inject({
      method: "POST",
      url: "/v1/profile/import-resume",
      payload: {
        filename: "synthetic.pdf",
        pdfBase64: Buffer.from("%PDF synthetic").toString("base64"),
        importProfile: true,
        importStyle: false,
      },
    });
    expect(extraction.statusCode, extraction.body).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/v1/profile" })).json(),
    ).toEqual(base);
    const reviewed = structuredClone(base.profile);
    const draftId = extraction.json().source.attemptId;
    reviewed.resume.experience_entries.push({
      id: `import:experience:${draftId}:0`,
      title: "Synthetic new role",
      company: "Synthetic new company",
      date_range: "", location: "", summary: "",
      bullets: ["Synthetic imported bullet"],
      achievement_evidence: [],
    });
    const saved = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: { profile: reviewed, expectedProfileVersion: base.profileVersion,
        importReview: { attemptId: extraction.json().source.attemptId, determinationId, draftId, sections: ["experience"], personalFields: [] } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const entries = saved.json().profile.resume.experience_entries;
    expect(entries[0].achievement_evidence).toEqual(
      base.profile.resume.experience_entries[0].achievement_evidence,
    );
    expect(entries[1]).toMatchObject({
      title: "Synthetic new role",
      bullets: ["Synthetic imported bullet"],
      achievement_evidence: [],
    });
  } finally {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("returns only personal fields from the persisted extraction, never the worker's inherited Profile", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-import-source-"));
  const dbPath = path.join(directory, "jobctrl.db");
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  const determinationId = recordResumeExtraction(db, { email: "synthetic-import@example.invalid" });
  db.close();
  const app = buildApp({ dbPath, configPath: path.join(directory, "config.json"),
    profileImporter: async (input) => {
      const db = new Database(dbPath);
      try { return { profile: { personal: { full_name: "Synthetic inherited B", email: "synthetic-import@example.invalid" } },
        source: recordImportAttempt(db, input, determinationId) }; }
      finally { db.close(); }
    },
  });
  try {
    const before = (await app.inject({ method: "GET", url: "/v1/profile" })).json();
    const response = await app.inject({ method: "POST", url: "/v1/profile/import-resume", payload: {
      filename: "synthetic.pdf", pdfBase64: Buffer.from("%PDF synthetic").toString("base64"),
      importProfile: true, importStyle: false,
    } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().profile.personal).toEqual({ email: "synthetic-import@example.invalid" });
    expect(response.json().source).toMatchObject({ determinationId, extractedPersonal: { email: "synthetic-import@example.invalid" } });
    expect((await app.inject({ method: "GET", url: "/v1/profile" })).json()).toEqual(before);
  } finally {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.each(["missing", "foreign", "wrong entity", "malformed"]) (
  "rejects an import without a matching readable source receipt: %s", async (kind) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-import-receipt-"));
    const dbPath = path.join(directory, "jobctrl.db");
    initializeExactDatabase(dbPath);
    const db = new Database(dbPath);
    let determinationId = "f".repeat(64);
    if (kind !== "missing") {
      determinationId = recordResumeExtraction(db, { email: "synthetic-import@example.invalid" }, {
        ...(kind === "foreign" ? { tenantId: "foreign" } : {}),
        ...(kind === "wrong entity" ? { entityId: "different-entity" } : {}),
      });
      if (kind === "malformed") {
        const row = db.prepare("SELECT envelope_json FROM semantic_determinations WHERE determination_id = ?").get(determinationId) as { envelope_json: string };
        const envelope = JSON.parse(row.envelope_json);
        envelope.result.personal.email = { value: "synthetic-import@example.invalid", citations: [] };
        db.prepare("UPDATE semantic_determinations SET envelope_json = ? WHERE determination_id = ?").run(JSON.stringify(envelope), determinationId);
      }
    }
    db.close();
    const app = buildApp({ dbPath, configPath: path.join(directory, "config.json"),
      profileImporter: async (input) => {
        const db = new Database(dbPath);
        db.pragma("foreign_keys = OFF");
        try { return { profile: profile("Synthetic inherited"), source: recordImportAttempt(db, input, determinationId) }; }
        finally { db.close(); }
      },
    });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/profile/import-resume", payload: {
        filename: "synthetic.pdf", pdfBase64: Buffer.from("%PDF synthetic").toString("base64"),
        importProfile: true, importStyle: false,
      } });
      expect(response.statusCode, response.body).toBe(502);
      expect(response.json().error).toBe("resume_extraction_receipt_unavailable");
      expect((await app.inject({ method: "GET", url: "/v1/profile" })).json().profileVersion).toBeNull();
    } finally {
      await app.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("binds whole worker responses and both save paths to the same PDF attempt", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-import-attempt-source-"));
  const dbPath = path.join(directory, "jobctrl.db");
  initializeExactDatabase(dbPath);
  const fixtureDb = new Database(dbPath);
  // Both PDFs may share an extraction determination when their text is the same.
  const determinationId = recordResumeExtraction(fixtureDb, { email: "synthetic-import@example.invalid" });
  const otherDeterminationId = recordResumeExtraction(fixtureDb, { full_name: "Other synthetic import" });
  const foreignDeterminationId = recordResumeExtraction(fixtureDb, {}, { tenantId: "foreign" });
  fixtureDb.close();
  const recorded: Array<Record<string, unknown>> = [];
  let replacementSource: Record<string, unknown> | null = null;
  let responseMutation: ((source: Record<string, unknown>) => Record<string, unknown>) | null = null;
  let swapSiblings = false;
  const app = buildApp({ appDir: directory, dbPath, configPath: path.join(directory, "config.json"),
    profileImporter: async (input) => {
      const db = new Database(dbPath);
      try {
        const inferredStyle = input.pdfBytes.toString().endsWith(" B") ? { paper_size: "a4paper" } : { paper_size: "letterpaper" };
        const source = recordImportAttempt(db, input,
          input.pdfBytes.toString().endsWith(" C") ? otherDeterminationId : determinationId, inferredStyle);
        recorded.push(source);
        return { profile: { personal: { full_name: "Synthetic inherited B" } },
          style: swapSiblings ? { paper_size: "a4paper" } : inferredStyle,
          source: replacementSource ?? (responseMutation ? responseMutation(source) : source) };
      } finally { db.close(); }
    },
  });
  const upload = (suffix: string, importProfile = true, importStyle = true) => app.inject({
    method: "POST", url: "/v1/profile/import-resume", payload: {
      filename: "synthetic.pdf", pdfBase64: Buffer.from(`%PDF synthetic ${suffix}`).toString("base64"), importProfile, importStyle,
    },
  });
  try {
    const initial = await app.inject({ method: "PATCH", url: "/v1/profile", payload: {
      profile: profile("Synthetic profile"), expectedProfileVersion: null,
    } });
    const a = await app.inject({ method: "PATCH", url: "/v1/profile", payload: {
      style: { moderncv_color: "red" }, expectedProfileVersion: initial.json().profileVersion,
    } });
    const b = await app.inject({ method: "PATCH", url: "/v1/profile", payload: {
      style: { moderncv_color: "blue" }, expectedProfileVersion: a.json().profileVersion,
    } });
    const first = await upload("A");
    const second = await upload("B");
    const third = await upload("C");
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(third.statusCode, third.body).toBe(200);
    const firstSource = first.json().source;
    const secondSource = second.json().source;
    const thirdSource = third.json().source;
    expect(firstSource.attemptId).not.toBe(secondSource.attemptId);
    expect(firstSource.determinationId).toBe(secondSource.determinationId);
    expect(first.json().profile.personal).toEqual({ email: "synthetic-import@example.invalid" });
    expect(first.json().style).toEqual({ paper_size: "letterpaper" });
    expect(second.json().style).toEqual({ paper_size: "a4paper" });
    // Unbound response siblings are ignored in favor of the worker's stored
    // attempt and extraction, even when they are otherwise well-formed.
    swapSiblings = true;
    const siblings = await upload("A");
    expect(siblings.statusCode, siblings.body).toBe(200);
    expect(siblings.json().profile.personal).toEqual({ email: "synthetic-import@example.invalid" });
    expect(siblings.json().style).toEqual({ paper_size: "letterpaper" });
    swapSiblings = false;
    // A whole valid response from a different attempt cannot be blessed as this request.
    replacementSource = recorded[1]!;
    expect((await upload("A", true, false)).statusCode).toBe(502);
    expect((await upload("A", false, true)).statusCode).toBe(502);
    replacementSource = null;
    for (const mutation of [
      (source: Record<string, unknown>) => ({ ...source, determinationId: otherDeterminationId }),
      (source: Record<string, unknown>) => ({ ...source, pdfSha256: "0".repeat(64) }),
      (source: Record<string, unknown>) => ({ ...source, inferredStyle: { paper_size: "a4paper" } }),
      (source: Record<string, unknown>) => ({ ...source, warnings: ["synthetic swapped warning"] }),
    ]) {
      responseMutation = mutation;
      expect((await upload("A")).statusCode).toBe(502);
    }
    responseMutation = null;
    const c = await app.inject({ method: "PATCH", url: "/v1/profile", payload: {
      style: { moderncv_color: "green" }, expectedProfileVersion: b.json().profileVersion,
    } });
    const stylePatch = (style: unknown, id: string, version = c.json().profileVersion, draftId = id) => app.inject({ method: "PATCH", url: "/v1/profile", payload: {
      style, importStyleReceiptId: id, expectedProfileVersion: version,
      importReview: { attemptId: id, determinationId, draftId, sections: ["style"], personalFields: [] },
    } });
    const missingDraftProof = await app.inject({ method: "PATCH", url: "/v1/profile", payload: {
      style: first.json().style, importStyleReceiptId: firstSource.attemptId, expectedProfileVersion: c.json().profileVersion,
    } });
    expect(missingDraftProof.statusCode, missingDraftProof.body).toBe(400);
    expect((await stylePatch(second.json().style, firstSource.attemptId)).statusCode).toBe(400);
    expect((await stylePatch({ ...first.json().style, moderncv_color: "blue" }, firstSource.attemptId)).statusCode).toBe(400);
    expect((await stylePatch(first.json().style, firstSource.attemptId, a.json().profileVersion)).statusCode).toBe(409);
    const draft = structuredClone(c.json().profile);
    draft.personal.email = "synthetic-import@example.invalid";
    const proof = { attemptId: firstSource.attemptId, determinationId, draftId: firstSource.attemptId, sections: ["personal"], personalFields: ["email"] };
    const wrongDetermination = await app.inject({ method: "PATCH", url: "/v1/profile", payload: {
      profile: draft, expectedProfileVersion: c.json().profileVersion, importReview: { ...proof, determinationId: otherDeterminationId },
    } });
    expect(wrongDetermination.statusCode, wrongDetermination.body).toBe(400);
    const wrongStyleAttempt = await app.inject({ method: "PATCH", url: "/v1/profile", payload: {
      profile: draft, style: second.json().style, expectedProfileVersion: c.json().profileVersion,
      importReview: { ...proof, sections: ["personal", "style"] }, importStyleReceiptId: secondSource.attemptId,
    } });
    expect(wrongStyleAttempt.statusCode, wrongStyleAttempt.body).toBe(400);
    // Replacing the complete valid B tuple cannot authorize a save under A's
    // retained draft identity, even when A and B share the same text receipt.
    const swappedProof = { ...proof, attemptId: secondSource.attemptId, draftId: firstSource.attemptId };
    const swappedProfile = await app.inject({ method: "PATCH", url: "/v1/profile", payload: {
      profile: draft, expectedProfileVersion: c.json().profileVersion, importReview: swappedProof,
    } });
    expect(swappedProfile.statusCode, swappedProfile.body).toBe(400);
    expect((await stylePatch(second.json().style, secondSource.attemptId, c.json().profileVersion, firstSource.attemptId)).statusCode).toBe(400);
    const swappedCombined = await app.inject({ method: "PATCH", url: "/v1/profile", payload: {
      profile: draft, style: second.json().style, expectedProfileVersion: c.json().profileVersion,
      importReview: { ...swappedProof, sections: ["personal", "style"] }, importStyleReceiptId: secondSource.attemptId,
    } });
    expect(swappedCombined.statusCode, swappedCombined.body).toBe(400);
    const thirdDraft = structuredClone(c.json().profile);
    thirdDraft.personal.full_name = "Other synthetic import";
    const swappedDetermination = await app.inject({ method: "PATCH", url: "/v1/profile", payload: {
      profile: thirdDraft, expectedProfileVersion: c.json().profileVersion,
      importReview: { attemptId: thirdSource.attemptId, determinationId: otherDeterminationId,
        draftId: firstSource.attemptId, sections: ["personal"], personalFields: ["full_name"] },
    } });
    expect(swappedDetermination.statusCode, swappedDetermination.body).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/profile" })).json()).toEqual(c.json());
    const db = new Database(dbPath);
    const binding = db.prepare("SELECT * FROM semantic_entity_bindings WHERE tenant_id=? AND entity_kind=? AND entity_id=?")
      .get("local", "resume_import_attempt", firstSource.attemptId) as {
        tenant_id: string; entity_kind: string; entity_id: string; entity_version: string;
        determination_kind: string; determination_id: string;
      } | undefined;
    expect(binding).toBeDefined();
    if (!binding) throw new Error("Synthetic attempt binding was not persisted");
    expect(binding.determination_id).toBe(determinationId);
    const metadata = JSON.parse(binding.entity_version);
    expect(metadata).toMatchObject({ version: 1, inferredStyle: { paper_size: "letterpaper" } });
    expect(metadata).not.toHaveProperty("pdfBytes");
    db.prepare("INSERT INTO semantic_entity_bindings VALUES (?, ?, ?, ?, ?, ?)").run(
      "local", "resume_import_attempt", firstSource.attemptId, "{}", "resume_extraction", determinationId,
    );
    db.close();
    expect((await stylePatch(first.json().style, firstSource.attemptId)).statusCode).toBe(400);
    const foreign = new Database(dbPath);
    foreign.prepare("DELETE FROM semantic_entity_bindings WHERE tenant_id=? AND entity_kind=? AND entity_id=?")
      .run("local", "resume_import_attempt", firstSource.attemptId);
    foreign.prepare("INSERT INTO semantic_entity_bindings VALUES (?, ?, ?, ?, ?, ?)").run(
      "foreign", "resume_import_attempt", firstSource.attemptId, binding.entity_version, "resume_extraction", foreignDeterminationId,
    );
    foreign.close();
    expect((await stylePatch(first.json().style, firstSource.attemptId)).statusCode).toBe(400);
    const restore = new Database(dbPath);
    restore.prepare("DELETE FROM semantic_entity_bindings WHERE tenant_id=? AND entity_kind=? AND entity_id=?")
      .run("foreign", "resume_import_attempt", firstSource.attemptId);
    restore.prepare("INSERT INTO semantic_entity_bindings VALUES (?, ?, ?, ?, ?, ?)").run(
      binding.tenant_id, binding.entity_kind, binding.entity_id, binding.entity_version, binding.determination_kind, binding.determination_id,
    );
    restore.close();
    const accepted = await stylePatch(first.json().style, firstSource.attemptId);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().style).toMatchObject({ moderncv_color: "green", paper_size: "letterpaper" });
  } finally {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("rejoins selected Profile changes to the extraction receipt inside the version-fenced write", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-import-save-source-"));
  const dbPath = path.join(directory, "jobctrl.db");
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  const determinationId = recordResumeExtraction(db, { email: "synthetic-import@example.invalid" });
  const attemptId = "00000000-0000-4000-8000-000000000001";
  recordImportAttempt(db, { attemptId, pdfBytes: Buffer.from("%PDF synthetic") }, determinationId);
  db.close();
  const app = buildApp({ dbPath, configPath: path.join(directory, "config.json") });
  try {
    const created = await app.inject({ method: "PATCH", url: "/v1/profile", payload: {
      profile: profile("Synthetic name A"), expectedProfileVersion: null,
    } });
    expect(created.statusCode, created.body).toBe(200);
    const b = structuredClone(created.json().profile);
    b.personal.full_name = "Synthetic name B";
    const updated = await app.inject({ method: "PATCH", url: "/v1/profile", payload: {
      profile: b, expectedProfileVersion: created.json().profileVersion,
    } });
    expect(updated.statusCode, updated.body).toBe(200);
    const c = structuredClone(updated.json().profile);
    c.personal.full_name = "Synthetic name C";
    const current = await app.inject({ method: "PATCH", url: "/v1/profile", payload: {
      profile: c, expectedProfileVersion: updated.json().profileVersion,
    } });
    expect(current.statusCode, current.body).toBe(200);
    const proof = { attemptId, determinationId, draftId: attemptId, sections: ["personal"], personalFields: ["email"] };
    const bad = structuredClone(current.json().profile);
    bad.personal.email = "synthetic-import@example.invalid";
    bad.personal.full_name = "Synthetic name B";
    const refused = await app.inject({ method: "PATCH", url: "/v1/profile", payload: {
      profile: bad, expectedProfileVersion: current.json().profileVersion, importReview: proof,
    } });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().message).toMatch(/extraction receipt/i);
    expect((await app.inject({ method: "GET", url: "/v1/profile" })).json()).toEqual(current.json());
    const saved = structuredClone(current.json().profile);
    saved.personal.email = "synthetic-import@example.invalid";
    const accepted = await app.inject({ method: "PATCH", url: "/v1/profile", payload: {
      profile: saved, expectedProfileVersion: current.json().profileVersion, importReview: proof,
    } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().profile.personal).toMatchObject({
      full_name: "Synthetic name C", email: "synthetic-import@example.invalid",
    });
  } finally {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("refuses to turn an extracted bullet into confirmed evidence during reviewed acceptance", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-import-evidence-source-"));
  const dbPath = path.join(directory, "jobctrl.db");
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  const field = (value: string) => ({ value, citations: [{ source_id: "resume", quote: value, exact_values: [] }] });
  const determinationId = recordModelDecision(db, "resume_extraction", "resume-import", {
    personal: Object.fromEntries(["full_name", "email", "phone", "linkedin", "github", "website", "city", "country"].map((name) => [name, null])),
    executive_profile: null,
    experience: [{ title: field("Synthetic extracted role"), company: field("Synthetic extracted company"),
      date_range: null, location: null, summary: null, bullets: [field("Synthetic extracted bullet")] }],
    education: [], skills: [],
  });
  const attemptId = "00000000-0000-4000-8000-000000000002";
  recordImportAttempt(db, { attemptId, pdfBytes: Buffer.from("%PDF synthetic") }, determinationId);
  db.close();
  const app = buildApp({ dbPath, configPath: path.join(directory, "config.json") });
  try {
    const original = profile("Synthetic saved");
    (original.resume.experience_entries[0] as Record<string, unknown>).achievement_evidence = [{
      id: "synthetic-accepted", source_text: "Synthetic accepted evidence", user_confirmed: true,
      evidence_strength: "verified", claim_confidence: 1,
    }];
    const before = await app.inject({ method: "PATCH", url: "/v1/profile", payload: { profile: original, expectedProfileVersion: null } });
    expect(before.statusCode, before.body).toBe(200);
    const draftId = attemptId;
    const incoming = { id: `import:experience:${draftId}:0`, title: "Synthetic extracted role", company: "Synthetic extracted company",
      date_range: "", location: "", summary: "", bullets: ["Synthetic extracted bullet"], achievement_evidence: [] as unknown[] };
    const proposed = structuredClone(before.json().profile);
    proposed.resume.experience_entries.push(incoming);
    const proof = { attemptId, determinationId, draftId, sections: ["experience"], personalFields: [] };
    const forged = structuredClone(proposed);
    forged.resume.experience_entries.at(-1).achievement_evidence = [{ id: "synthetic-forged", source_text: "Synthetic extracted bullet", user_confirmed: true }];
    const denied = await app.inject({ method: "PATCH", url: "/v1/profile", payload: {
      profile: forged, expectedProfileVersion: before.json().profileVersion, importReview: proof,
    } });
    expect(denied.statusCode, denied.body).toBe(400);
    expect(denied.json().message).toMatch(/extraction receipt/i);
    expect((await app.inject({ method: "GET", url: "/v1/profile" })).json()).toEqual(before.json());
    const accepted = await app.inject({ method: "PATCH", url: "/v1/profile", payload: {
      profile: proposed, expectedProfileVersion: before.json().profileVersion, importReview: proof,
    } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().profile.resume.experience_entries[0].achievement_evidence).toEqual(
      before.json().profile.resume.experience_entries[0].achievement_evidence,
    );
    expect(accepted.json().profile.resume.experience_entries.at(-1)).toMatchObject({
      title: "Synthetic extracted role", bullets: ["Synthetic extracted bullet"], achievement_evidence: [],
    });
  } finally {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
