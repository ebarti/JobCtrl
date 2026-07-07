import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import Database from "better-sqlite3";

import {
  IncompatibleSchemaVersionError,
  SUPPORTED_SCHEMA_VERSION,
  migrateLegacyJobTables,
  openDatabase,
  openReadOnlyDatabase,
  tableExists,
} from "../src/db.js";

function makeDbWithUserVersion(userVersion: number): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctl-api-schema-version-"));
  const dbPath = path.join(dir, "jobs.db");
  const db = new Database(dbPath);
  db.pragma(`user_version = ${userVersion}`);
  db.close();
  return { dbPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function legacyToken(): string {
  return "job" + "hunter";
}

describe("schema version guard at DB open", () => {
  it("refuses a database whose user_version is newer than the API supports", () => {
    const { dbPath, cleanup } = makeDbWithUserVersion(SUPPORTED_SCHEMA_VERSION + 1);
    try {
      expect(() => openDatabase(dbPath)).toThrow(IncompatibleSchemaVersionError);
      expect(() => openReadOnlyDatabase(dbPath)).toThrow(IncompatibleSchemaVersionError);
    } finally {
      cleanup();
    }
  });

  it("opens a pre-guard database (user_version 0), mirroring the worker", () => {
    const { dbPath, cleanup } = makeDbWithUserVersion(0);
    try {
      openDatabase(dbPath).close();
      openReadOnlyDatabase(dbPath).close();
    } finally {
      cleanup();
    }
  });

  it("opens a database stamped at exactly the supported version", () => {
    const { dbPath, cleanup } = makeDbWithUserVersion(SUPPORTED_SCHEMA_VERSION);
    try {
      openDatabase(dbPath).close();
      openReadOnlyDatabase(dbPath).close();
    } finally {
      cleanup();
    }
  });

  it("never stamps user_version — stamping stays the worker's job", () => {
    const { dbPath, cleanup } = makeDbWithUserVersion(0);
    try {
      openDatabase(dbPath).close();
      const probe = new Database(dbPath, { readonly: true });
      const stamped = probe.pragma("user_version", { simple: true }) as number;
      probe.close();
      expect(stamped).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("legacy tombstone table migration", () => {
  it("renames old deleted and hidden tables on writable open", () => {
    const { dbPath, cleanup } = makeDbWithUserVersion(SUPPORTED_SCHEMA_VERSION);
    const token = legacyToken();
    try {
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE ${token}_deleted_jobs (
          job_url TEXT PRIMARY KEY,
          deleted_at TEXT NOT NULL,
          reason TEXT,
          restored_at TEXT
        );
        INSERT INTO ${token}_deleted_jobs
          (job_url, deleted_at, reason, restored_at)
        VALUES ('https://example.test/deleted', '2026-07-07T00:00:00Z', 'test', NULL);
        CREATE TABLE ${token}_hidden_jobs (
          tenant_id TEXT NOT NULL DEFAULT 'local',
          job_url TEXT NOT NULL,
          hidden_at TEXT NOT NULL,
          unhidden_at TEXT
        );
        INSERT INTO ${token}_hidden_jobs
          (tenant_id, job_url, hidden_at, unhidden_at)
        VALUES ('local', 'https://example.test/hidden', '2026-07-07T00:00:00Z', NULL);
      `);
      seed.close();

      const db = openDatabase(dbPath);
      try {
        expect(tableExists(db, "jobctl_deleted_jobs")).toBe(true);
        expect(tableExists(db, "jobctl_hidden_jobs")).toBe(true);
        expect(tableExists(db, `${token}_deleted_jobs`)).toBe(false);
        expect(tableExists(db, `${token}_hidden_jobs`)).toBe(false);
        expect(db.prepare("SELECT COUNT(*) AS count FROM jobctl_deleted_jobs").get()).toMatchObject({ count: 1 });
        expect(db.prepare("SELECT COUNT(*) AS count FROM jobctl_hidden_jobs").get()).toMatchObject({ count: 1 });
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  it("merges old rows into existing new tables by common columns", () => {
    const { dbPath, cleanup } = makeDbWithUserVersion(SUPPORTED_SCHEMA_VERSION);
    const token = legacyToken();
    try {
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE jobctl_hidden_jobs (
          job_url TEXT PRIMARY KEY,
          hidden_at TEXT NOT NULL,
          reason TEXT,
          unhidden_at TEXT
        );
        INSERT INTO jobctl_hidden_jobs
          (job_url, hidden_at, reason, unhidden_at)
        VALUES ('https://example.test/current', '2026-07-07T00:00:00Z', 'current', NULL);
        CREATE TABLE ${token}_hidden_jobs (
          tenant_id TEXT NOT NULL DEFAULT 'local',
          job_url TEXT NOT NULL,
          hidden_at TEXT NOT NULL,
          unhidden_at TEXT
        );
        INSERT INTO ${token}_hidden_jobs
          (tenant_id, job_url, hidden_at, unhidden_at)
        VALUES ('local', 'https://example.test/legacy', '2026-07-07T00:00:00Z', NULL);
      `);

      const migrated = migrateLegacyJobTables(seed);
      expect(migrated).toEqual(["jobctl_hidden_jobs"]);
      expect(tableExists(seed, `${token}_hidden_jobs`)).toBe(false);
      expect(seed.prepare("SELECT COUNT(*) AS count FROM jobctl_hidden_jobs").get()).toMatchObject({ count: 2 });
      seed.close();
    } finally {
      cleanup();
    }
  });
});
