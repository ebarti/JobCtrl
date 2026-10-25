import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { isCurrentDeterminationVersion } from "@jobctrl/contracts";

import { readDetermination } from "../src/semantic-determinations.js";
import { initializeExactDatabase } from "./exact-schema.js";
import { recordModelDecision } from "./semantic-fixtures.js";

const quality = {
  kind: "artifact_quality" as const,
  previous: "artifact-quality-v2",
  current: "artifact-quality-v3",
  result: { verdict: "pass", score: 0.8, findings: [], evidence_corrections: [], rationale: "Owned model verdict" },
};
const adversarial = {
  kind: "resume_adversarial" as const,
  previous: "resume-adversarial-v2",
  current: "resume-adversarial-v3",
  result: {
    verdict: "pass", score: 0.8, rationale: "Owned model verdict",
    personas: ["ats_parser", "skeptical_recruiter", "hiring_manager_domain_expert", "evidence_auditor", "anti_ai_voice_critic", "interview_defensibility_critic"].map((persona) => ({
      persona, verdict: "pass", score: 0.8, rationale: "Owned persona verdict", findings: [],
      citations: [{ source_id: "line:owned", quote: "Owned source", exact_values: [] }],
    })),
  },
};

const claims = {
  kind: "claim_verification" as const,
  previous: "claim-verification-v2",
  current: "claim-verification-v3",
  result: {
    verdict: "pass", rationale: "Owned model verdict",
    lines: [{ line_id: "owned", verdict: "pass", served_requirements: [],
      source_evidence: [{ source_id: "profile:owned", quote: "Owned source", exact_values: [] }],
      claims: [{ kind: "candidate_fact", support: "supported", rationale: "Owned model support",
        text: { source_id: "line:owned", quote: "Owned source", exact_values: [] },
        evidence: [{ source_id: "profile:owned", quote: "Owned source", exact_values: [] }],
      }], findings: [] }],
  },
};

const scoring = {
  kind: "scoring" as const,
  previous: "score-fit-assessment-v10-binding-repair",
  current: "score-fit-assessment-v11-single-evidence-source",
  result: {
    score: 7, technical_fit: 7, experience_fit: 7, role_fit: 7,
    fit_band: "strong", confidence: "medium",
    eligibility: { status: "eligible", blockers: [], warnings: [] },
    matched_signals: [], missing_signals: [], transferable_signals: [],
    requirement_assessments: [], keywords: ["Owned keyword"],
    discovery_feedback: {
      verdict: "none", reason: "Owned model verdict",
      citations: [{ source_id: "profile:owned", quote: "Owned source", exact_values: [] }],
    },
    reasoning: "Owned model verdict",
    citations: [{ source_id: "profile:owned", quote: "Owned source", exact_values: [] }],
  },
};

it.each([quality, adversarial, scoring, claims])("keeps known $kind history readable while current-only reads remain strict", (contract) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-receipt-versions-"));
  const filename = path.join(directory, "owned.db");
  initializeExactDatabase(filename);
  const db = new Database(filename);
  try {
    const record = (prompt: string, schema?: string, result: object = contract.result) => {
      const id = recordModelDecision(db, contract.kind, "owned", result, "local", `${prompt}:${schema ?? "current"}`);
      const row = db.prepare("SELECT envelope_json FROM semantic_determinations WHERE determination_id=?").get(id) as { envelope_json: string };
      const envelope = JSON.parse(row.envelope_json);
      envelope.prompt_version = prompt;
      if (schema) envelope.schema_version = schema;
      db.prepare("UPDATE semantic_determinations SET prompt_version=?,schema_version=?,envelope_json=? WHERE determination_id=?")
        .run(prompt, envelope.schema_version, JSON.stringify(envelope), id);
      return id;
    };
    const current = record(contract.current);
    expect(readDetermination(db, "local", current, { currentOnly: true })?.prompt_version).toBe(contract.current);
    const previous = record(contract.previous);
    const receipt = readDetermination(db, "local", previous)!;
    expect(receipt.result).toEqual(contract.result);
    expect(isCurrentDeterminationVersion(receipt)).toBe(false);
    expect(readDetermination(db, "local", previous, { currentOnly: true })).toBeNull();
    expect(readDetermination(db, "foreign", previous)).toBeNull();
    for (const invalid of [
      record("unknown-future-version"),
      record(contract.previous, "999"),
      record(contract.previous, undefined, { ...contract.result, verdict: "unknown" }),
    ]) {
      expect(() => readDetermination(db, "local", invalid)).toThrow("determination_schema_violation");
    }
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


it.each([undefined, null, "a".repeat(64)])("reads the exact optional task profile without relabeling legacy receipts: %s", (profile) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-receipt-profile-"));
  const filename = path.join(directory, "owned.db");
  initializeExactDatabase(filename);
  const db = new Database(filename);
  try {
    const id = recordModelDecision(db, quality.kind, "owned", quality.result);
    const row = db.prepare("SELECT envelope_json FROM semantic_determinations WHERE determination_id=?").get(id) as { envelope_json: string };
    const envelope = JSON.parse(row.envelope_json);
    if (profile !== undefined) envelope.instruction_profile = profile;
    const write = () => db.prepare("UPDATE semantic_determinations SET envelope_json=? WHERE determination_id=?")
      .run(JSON.stringify(envelope), id);
    write();
    expect(readDetermination(db, "local", id)?.instruction_profile).toBe(profile);
    for (const invalid of ["unknown-profile", "A".repeat(64), "a".repeat(65), 1]) {
      envelope.instruction_profile = invalid;
      write();
      expect(() => readDetermination(db, "local", id)).toThrow("determination_binding_invalid");
    }
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


it.each(["resume-adversarial-v1", "resume-adversarial-v2"])("preserves complete historical persona diagnostics for %s", (prompt) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-persona-reader-"));
  const filename = path.join(directory, "owned.db");
  initializeExactDatabase(filename);
  const db = new Database(filename);
  try {
    const result = structuredClone(adversarial.result);
    for (const persona of result.personas) {
      persona.rationale = "Owned historical diagnostic. ".repeat(25);
      persona.citations = Array.from({ length: 4 }, () => ({
        source_id: "line:owned", quote: "Owned original quotation. ".repeat(12), exact_values: [],
      }));
    }
    const id = recordModelDecision(db, adversarial.kind, "owned", result, "local", prompt);
    const row = db.prepare("SELECT envelope_json FROM semantic_determinations WHERE determination_id=?").get(id) as { envelope_json: string };
    const envelope = JSON.parse(row.envelope_json);
    envelope.prompt_version = prompt;
    const original = JSON.stringify(envelope);
    db.prepare("UPDATE semantic_determinations SET prompt_version=?,envelope_json=? WHERE determination_id=?")
      .run(prompt, original, id);
    expect(readDetermination(db, "local", id)?.result).toEqual(result);
    expect(readDetermination(db, "local", id, { currentOnly: true })).toBeNull();
    expect((db.prepare("SELECT envelope_json FROM semantic_determinations WHERE determination_id=?").get(id) as { envelope_json: string }).envelope_json).toBe(original);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
