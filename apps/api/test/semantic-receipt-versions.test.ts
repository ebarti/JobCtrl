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
  previous: "resume-adversarial-v1",
  current: "resume-adversarial-v2",
  result: {
    verdict: "pass", score: 0.8, rationale: "Owned model verdict",
    personas: ["ats_parser", "skeptical_recruiter", "hiring_manager_domain_expert", "evidence_auditor", "anti_ai_voice_critic", "interview_defensibility_critic"].map((persona) => ({
      persona, verdict: "pass", score: 0.8, rationale: "Owned persona verdict", findings: [],
      citations: [{ source_id: "line:owned", quote: "Owned source", exact_values: [] }],
    })),
  },
};

it.each([quality, adversarial])("keeps known $kind history readable while current-only reads remain strict", (contract) => {
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
