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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-schema-version-"));
  const dbPath = path.join(dir, "jobs.db");
  const db = new Database(dbPath);
  db.pragma(`user_version = ${userVersion}`);
  db.close();
  return { dbPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function legacyTokens(): string[] {
  return ["job" + "ctl", "job" + "hunter"];
}

function tableColumns(db: Database.Database, tableName: string): string[] {
  const quotedTable = `"${tableName.replaceAll('"', '""')}"`;
  return db.prepare(`PRAGMA table_info(${quotedTable})`).all().map((row) => String((row as { name: unknown }).name));
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

  it("opens the worker-owned schema-v14 artifact registry", () => {
    expect(SUPPORTED_SCHEMA_VERSION).toBe(22);
    const { dbPath, cleanup } = makeDbWithUserVersion(14);
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
  it.each(legacyTokens())("renames old %s deleted and hidden tables on writable open", (token) => {
    const { dbPath, cleanup } = makeDbWithUserVersion(SUPPORTED_SCHEMA_VERSION);
    try {
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE ${token}_deleted_jobs (
          job_url TEXT PRIMARY KEY,
          deleted_at TEXT NOT NULL,
          reason TEXT
        );
        INSERT INTO ${token}_deleted_jobs
          (job_url, deleted_at, reason)
        VALUES ('https://example.test/deleted', '2026-07-07T00:00:00Z', 'test');
        CREATE TABLE ${token}_hidden_jobs (
          job_url TEXT PRIMARY KEY,
          hidden_at TEXT NOT NULL,
          reason TEXT
        );
        INSERT INTO ${token}_hidden_jobs
          (job_url, hidden_at, reason)
        VALUES ('https://example.test/hidden', '2026-07-07T00:00:00Z', 'test');
      `);
      seed.close();

      const db = openDatabase(dbPath);
      try {
        expect(tableExists(db, "jobctrl_deleted_jobs")).toBe(true);
        expect(tableExists(db, "jobctrl_hidden_jobs")).toBe(true);
        expect(tableExists(db, `${token}_deleted_jobs`)).toBe(false);
        expect(tableExists(db, `${token}_hidden_jobs`)).toBe(false);
        expect(db.prepare("SELECT COUNT(*) AS count FROM jobctrl_deleted_jobs").get()).toMatchObject({ count: 1 });
        expect(db.prepare("SELECT COUNT(*) AS count FROM jobctrl_hidden_jobs").get()).toMatchObject({ count: 1 });
        expect(db.prepare("SELECT restored_at FROM jobctrl_deleted_jobs").get()).toMatchObject({ restored_at: null });
        expect(db.prepare("SELECT unhidden_at FROM jobctrl_hidden_jobs").get()).toMatchObject({ unhidden_at: null });
        expect(tableColumns(db, "jobctrl_deleted_jobs")).toEqual(expect.arrayContaining(["job_url", "deleted_at", "reason", "restored_at"]));
        expect(tableColumns(db, "jobctrl_hidden_jobs")).toEqual(expect.arrayContaining(["job_url", "hidden_at", "reason", "unhidden_at"]));
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  it.each(legacyTokens())("merges old %s rows into existing new tables by common columns", (token) => {
    const { dbPath, cleanup } = makeDbWithUserVersion(SUPPORTED_SCHEMA_VERSION);
    try {
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE jobctrl_hidden_jobs (
          job_url TEXT PRIMARY KEY,
          hidden_at TEXT NOT NULL,
          reason TEXT,
          unhidden_at TEXT
        );
        INSERT INTO jobctrl_hidden_jobs
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
      expect(migrated).toEqual(["jobctrl_hidden_jobs"]);
      expect(tableExists(seed, `${token}_hidden_jobs`)).toBe(false);
      expect(seed.prepare("SELECT COUNT(*) AS count FROM jobctrl_hidden_jobs").get()).toMatchObject({ count: 2 });
      seed.close();
    } finally {
      cleanup();
    }
  });

  it("normalizes tables left behind by an earlier rename-only migration", () => {
    const { dbPath, cleanup } = makeDbWithUserVersion(SUPPORTED_SCHEMA_VERSION);
    try {
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE jobctrl_deleted_jobs (
          job_url TEXT PRIMARY KEY,
          deleted_at TEXT NOT NULL,
          reason TEXT
        );
        INSERT INTO jobctrl_deleted_jobs
          (job_url, deleted_at, reason)
        VALUES ('https://example.test/deleted', '2026-07-07T00:00:00Z', 'test');
        CREATE TABLE jobctrl_hidden_jobs (
          job_url TEXT PRIMARY KEY,
          hidden_at TEXT NOT NULL,
          reason TEXT
        );
        INSERT INTO jobctrl_hidden_jobs
          (job_url, hidden_at, reason)
        VALUES ('https://example.test/hidden', '2026-07-07T00:00:00Z', 'test');
      `);

      expect(migrateLegacyJobTables(seed)).toEqual([]);
      expect(seed.prepare("SELECT restored_at FROM jobctrl_deleted_jobs").get()).toMatchObject({ restored_at: null });
      expect(seed.prepare("SELECT unhidden_at FROM jobctrl_hidden_jobs").get()).toMatchObject({ unhidden_at: null });
      expect(tableColumns(seed, "jobctrl_deleted_jobs")).toEqual(expect.arrayContaining(["restored_at"]));
      expect(tableColumns(seed, "jobctrl_hidden_jobs")).toEqual(expect.arrayContaining(["unhidden_at"]));
      seed.close();
    } finally {
      cleanup();
    }
  });

  it("refuses duplicate lifecycle job URLs without dropping legacy tables", () => {
    const { dbPath, cleanup } = makeDbWithUserVersion(SUPPORTED_SCHEMA_VERSION);
    try {
      const token = "job" + "ctl";
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE jobctrl_hidden_jobs (
          job_url TEXT PRIMARY KEY,
          hidden_at TEXT NOT NULL,
          reason TEXT,
          unhidden_at TEXT
        );
        INSERT INTO jobctrl_hidden_jobs
          (job_url, hidden_at, reason, unhidden_at)
        VALUES ('https://example.test/duplicate', '2026-07-07T00:00:00Z', 'current', NULL);
        CREATE TABLE ${token}_hidden_jobs (
          job_url TEXT PRIMARY KEY,
          hidden_at TEXT NOT NULL,
          reason TEXT
        );
        INSERT INTO ${token}_hidden_jobs
          (job_url, hidden_at, reason)
        VALUES ('https://example.test/duplicate', '2026-07-07T00:01:00Z', 'legacy');
      `);

      expect(() => migrateLegacyJobTables(seed)).toThrow(/duplicate job_url/);
      expect(tableExists(seed, "jobctrl_hidden_jobs")).toBe(true);
      expect(tableExists(seed, `${token}_hidden_jobs`)).toBe(true);
      expect(seed.prepare("SELECT COUNT(*) AS count FROM jobctrl_hidden_jobs").get()).toMatchObject({ count: 1 });
      expect(seed.prepare(`SELECT COUNT(*) AS count FROM ${token}_hidden_jobs`).get()).toMatchObject({ count: 1 });
      seed.close();
    } finally {
      cleanup();
    }
  });
});
