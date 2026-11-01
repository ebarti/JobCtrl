import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readCandidateInterpretationStatus,
  readTargetRoleProposal,
} from "../src/candidate-interpretations.js";
import { readProfileConfig, writeProfileConfig } from "../src/profile-store.js";
import { initializeExactDatabase } from "./exact-schema.js";
import { recordCandidateProposal } from "./semantic-fixtures.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
function database() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "jobctrl-candidate-confirmation-"),
  );
  const filename = path.join(directory, "jobs.db");
  initializeExactDatabase(filename);
  const db = new Database(filename);
  cleanups.push(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const saved = writeProfileConfig(db, {
    profile: {
      resume: {
        experience_entries: [
          { id: "owned", title: "Engineer", company: "Synthetic" },
        ],
      },
    },
  });
  return { db, saved };
}
describe("version-bound candidate confirmation", () => {
  it("commits confirmation without changing authored facts or advancing an unchanged profile", () => {
    const { db, saved } = database();
    const proposal = recordCandidateProposal(db, {
      expectedProfileVersion: saved.profileVersion,
    });
    const result = writeProfileConfig(db, {
      profile: saved.profile,
      expectedProfileVersion: saved.profileVersion!,
      acceptedCandidateInterpretationId: proposal.determinationId,
    });
    expect(result.profileVersion).toBe(saved.profileVersion);
    expect(result.profile).toEqual(saved.profile);
    expect(result.candidateInterpretation).toMatchObject({
      status: "confirmed",
      determination: { determination_id: proposal.determinationId },
    });
    expect(readProfileConfig(db).candidateInterpretation?.status).toBe(
      "confirmed",
    );
    expect(readTargetRoleProposal(db, result.profileVersion!, 5)?.status).toBe(
      "confirmed",
    );
  });
  it("does not expose a blocked interpretation attempt belonging to a different profile version", () => {
    const { db, saved } = database();
    db.prepare(
      "INSERT INTO semantic_stage_states VALUES ('local',?,'candidate_interpretation_request',?,'blocked','provider_unavailable',NULL,?)",
    ).run(
      `default:${saved.profileVersion! + 1}`,
      "a".repeat(64),
      new Date().toISOString(),
    );
    expect(
      readCandidateInterpretationStatus(db, saved.profileVersion!),
    ).toMatchObject({ status: "missing", failureCode: null });
    expect(
      readCandidateInterpretationStatus(db, saved.profileVersion! + 1),
    ).toMatchObject({
      status: "unavailable",
      failureCode: "provider_unavailable",
    });
  });
  it("rejects a stale confirmation and preserves the pending suggestion", () => {
    const { db, saved } = database();
    const proposal = recordCandidateProposal(db, {
      expectedProfileVersion: saved.profileVersion,
    });
    expect(() =>
      writeProfileConfig(db, {
        profile: saved.profile,
        expectedProfileVersion: saved.profileVersion! + 1,
        acceptedCandidateInterpretationId: proposal.determinationId,
      }),
    ).toThrow();
    expect(
      readCandidateInterpretationStatus(db, saved.profileVersion!),
    ).toMatchObject({ status: "pending_confirmation" });
  });
});
