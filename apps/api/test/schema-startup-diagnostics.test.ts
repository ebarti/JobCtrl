import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/server.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("incompatible database startup", () => {
  it.each([
    [14, "database_migration_required"],
    [16, "database_schema_incompatible"],
    [15, "database_schema_incompatible"], // The marker alone does not make the schema valid.
    [0, "database_schema_incompatible"],
  ])("reports version %i while refusing all product operations", async (version, code) => {
    const root = mkdtempSync(path.join(tmpdir(), "jobctrl-schema-startup-"));
    roots.push(root);
    const dbPath = path.join(root, "jobctrl.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE synthetic_data (value TEXT); INSERT INTO synthetic_data VALUES ('preserve'); PRAGMA user_version = ${version};`);
    db.close();
    const before = readFileSync(dbPath);
    writeFileSync(path.join(root, "index.html"), "<!doctype html><title>JobCtrl</title>");
    const app = buildApp({ dbPath, configPath: path.join(root, "config.json"), webAssetsDir: root });
    try {
      const health = await app.inject({ method: "GET", url: "/v1/health" });
      expect(health.statusCode).toBe(503);
      expect(health.json()).toMatchObject({ ok: false, error: code, expectedVersion: 15 });
      expect(health.body).not.toContain(root);
      for (const request of [
        { method: "GET" as const, url: "/v1/dashboard/summary" },
        { method: "POST" as const, url: "/v1/pipeline/actions/run-stage" },
      ]) {
        expect((await app.inject(request)).statusCode).toBe(503);
      }
      expect((await app.inject({ method: "GET", url: "/v1/health", headers: { host: "example.com" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/dashboard", headers: { accept: "text/html" } })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
    expect(readFileSync(dbPath)).toEqual(before);
  });
});
