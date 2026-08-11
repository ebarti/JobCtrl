import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import {
  IncompatibleSchemaManifestError,
  IncompatibleSchemaVersionError,
  SUPPORTED_SCHEMA_VERSION,
  migrateLegacyJobTables,
  openDatabase,
  openReadOnlyDatabase,
  tableExists,
} from "../src/db.js";
import {
  EXACT_V7_SCHEMA_MANIFEST,
  EXACT_V8_SCHEMA_MANIFEST,
  hasExactV8SchemaManifest,
  schemaManifest,
} from "../src/schema-manifest.js";

function makeDbWithUserVersion(userVersion: number): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-schema-version-"));
  const dbPath = path.join(dir, "jobs.db");
  const db = new Database(dbPath);
  db.pragma(`user_version = ${userVersion}`);
  db.close();
  return { dbPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function makeExactV8Database(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-exact-v8-"));
  const dbPath = path.join(dir, "jobs.db");
  const migrations = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../workers/automation/src/jobctrl/infrastructure/migrations",
  );
  const db = new Database(dbPath);
  db.exec(fs.readFileSync(path.join(migrations, "schema_v7.sql"), "utf8"));
  db.exec(fs.readFileSync(path.join(migrations, "schema_v8.sql"), "utf8"));
  db.pragma(`user_version = ${SUPPORTED_SCHEMA_VERSION}`);
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
  it.each([0, 6, 7, 9])("refuses schema version %i before runtime writes", (userVersion) => {
    const { dbPath, cleanup } = makeDbWithUserVersion(userVersion);
    try {
      const token = "job" + "ctl";
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE ${token}_hidden_jobs (
          job_url TEXT PRIMARY KEY,
          hidden_at TEXT NOT NULL,
          reason TEXT
        )
      `);
      seed.close();

      expect(() => openDatabase(dbPath)).toThrow(IncompatibleSchemaVersionError);
      expect(() => openReadOnlyDatabase(dbPath)).toThrow(IncompatibleSchemaVersionError);
      const probe = new Database(dbPath, { readonly: true });
      try {
        expect(probe.pragma("user_version", { simple: true })).toBe(userVersion);
        expect(tableExists(probe, `${token}_hidden_jobs`)).toBe(true);
        expect(tableExists(probe, "jobctrl_hidden_jobs")).toBe(false);
      } finally {
        probe.close();
      }
    } finally {
      cleanup();
    }
  });

  it("opens the exact v8 schema", () => {
    const { dbPath, cleanup } = makeExactV8Database();
    try {
      openDatabase(dbPath).close();
      openReadOnlyDatabase(dbPath).close();
    } finally {
      cleanup();
    }
  });

  it("rejects a merely stamped v8 database before runtime writes", () => {
    const { dbPath, cleanup } = makeDbWithUserVersion(SUPPORTED_SCHEMA_VERSION);
    try {
      expect(() => openDatabase(dbPath)).toThrow(IncompatibleSchemaManifestError);
      expect(() => openReadOnlyDatabase(dbPath)).toThrow(IncompatibleSchemaManifestError);
      const probe = new Database(dbPath, { readonly: true });
      try {
        expect(probe.pragma("user_version", { simple: true })).toBe(SUPPORTED_SCHEMA_VERSION);
        expect(tableExists(probe, "jobs")).toBe(false);
      } finally {
        probe.close();
      }
    } finally {
      cleanup();
    }
  });

  it("rejects a malformed v8 database without running legacy tombstone migration", () => {
    const { dbPath, cleanup } = makeDbWithUserVersion(SUPPORTED_SCHEMA_VERSION);
    try {
      const token = "job" + "ctl";
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE ${token}_hidden_jobs (
          job_url TEXT PRIMARY KEY,
          hidden_at TEXT NOT NULL,
          reason TEXT
        )
      `);
      seed.close();

      expect(() => openDatabase(dbPath)).toThrow(IncompatibleSchemaManifestError);
      expect(() => openReadOnlyDatabase(dbPath)).toThrow(IncompatibleSchemaManifestError);
      const probe = new Database(dbPath, { readonly: true });
      try {
        expect(probe.pragma("user_version", { simple: true })).toBe(SUPPORTED_SCHEMA_VERSION);
        expect(tableExists(probe, `${token}_hidden_jobs`)).toBe(true);
        expect(tableExists(probe, "jobctrl_hidden_jobs")).toBe(false);
      } finally {
        probe.close();
      }
    } finally {
      cleanup();
    }
  });

  it("keeps the checked TypeScript manifest aligned with the Python owner", () => {
    const pythonManifestPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../workers/automation/src/jobctrl/infrastructure/migrations/schema_manifest.py",
    );
    const pythonManifest = fs.readFileSync(pythonManifestPath, "utf8");

    expect(pythonManifest).toContain("version=7,");
    expect(pythonManifest).toContain("object_count=242,");
    expect(pythonManifest).toContain("table_count=110,");
    expect(pythonManifest).toContain(`fingerprint=\"${EXACT_V7_SCHEMA_MANIFEST.fingerprint}\",`);
    expect(EXACT_V7_SCHEMA_MANIFEST).toEqual({
      version: 7,
      objectCount: 242,
      tableCount: 110,
      fingerprint: "775312f0ec2640a2a87889602886c90e21a49e06fffc53cf26c435856247da97",
    });
    expect(pythonManifest).toContain("version=8,");
    expect(pythonManifest).toContain("object_count=272,");
    expect(pythonManifest).toContain("table_count=117,");
    expect(pythonManifest).toContain(`fingerprint="${EXACT_V8_SCHEMA_MANIFEST.fingerprint}",`);
    expect(EXACT_V8_SCHEMA_MANIFEST).toEqual({
      version: SUPPORTED_SCHEMA_VERSION,
      objectCount: 272,
      tableCount: 117,
      fingerprint: "3705f7c7d90454bbeaa85227a9d4ce87c12efd14935e0d14afc830939e80ff31",
    });
  });

  it("computes the exact v8 manifest from the frozen v7 schema plus v8 additions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-exact-v8-"));
    const dbPath = path.join(dir, "jobs.db");
    const migrations = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../workers/automation/src/jobctrl/infrastructure/migrations",
    );
    const db = new Database(dbPath);
    try {
      db.exec(fs.readFileSync(path.join(migrations, "schema_v7.sql"), "utf8"));
      db.exec(fs.readFileSync(path.join(migrations, "schema_v8.sql"), "utf8"));
      expect(schemaManifest(db, EXACT_V8_SCHEMA_MANIFEST.version)).toEqual(EXACT_V8_SCHEMA_MANIFEST);
      expect(hasExactV8SchemaManifest(db)).toBe(true);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("legacy tombstone table migration helper", () => {
  it.each(legacyTokens())("renames old %s deleted and hidden tables only when explicitly invoked", (token) => {
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
      expect(migrateLegacyJobTables(seed)).toEqual([
        "jobctrl_deleted_jobs",
        "jobctrl_hidden_jobs",
      ]);
      expect(tableExists(seed, "jobctrl_deleted_jobs")).toBe(true);
      expect(tableExists(seed, "jobctrl_hidden_jobs")).toBe(true);
      expect(tableExists(seed, `${token}_deleted_jobs`)).toBe(false);
      expect(tableExists(seed, `${token}_hidden_jobs`)).toBe(false);
      expect(seed.prepare("SELECT COUNT(*) AS count FROM jobctrl_deleted_jobs").get()).toMatchObject({ count: 1 });
      expect(seed.prepare("SELECT COUNT(*) AS count FROM jobctrl_hidden_jobs").get()).toMatchObject({ count: 1 });
      expect(seed.prepare("SELECT restored_at FROM jobctrl_deleted_jobs").get()).toMatchObject({ restored_at: null });
      expect(seed.prepare("SELECT unhidden_at FROM jobctrl_hidden_jobs").get()).toMatchObject({ unhidden_at: null });
      expect(tableColumns(seed, "jobctrl_deleted_jobs")).toEqual(expect.arrayContaining(["job_url", "deleted_at", "reason", "restored_at"]));
      expect(tableColumns(seed, "jobctrl_hidden_jobs")).toEqual(expect.arrayContaining(["job_url", "hidden_at", "reason", "unhidden_at"]));
      seed.close();
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
