import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildApp } from "../src/server.js";
import { initializeExactDatabase } from "./exact-schema.js";

describe("saved Discovery settings read protection", () => {
  it("preserves corrupt settings when a first-party HTTP mutation reaches recovery", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-saved-search-http-"));
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactDatabase(dbPath);
    const db = new Database(dbPath);
    const raw = '{ "boards": ["linkedin"], "defaults": {"results_per_site": null}, "synthetic_note": "private marker" }';
    db.prepare("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')").run(raw);
    const read = db.prepare("SELECT search_config_json, created_at, updated_at FROM discovery_settings");
    const unavailable = async () => { throw new Error("Operation is outside the synthetic API fixture"); };
    const call = vi.fn(unavailable);
    const app = buildApp({
      appDir: dir,
      dbPath,
      configPath: path.join(dir, "config.json"),
      providerDispatcher: { call, close: async () => {} },
      credentialStore: { list: unavailable, set: unavailable, delete: unavailable, applyBatch: unavailable },
      actionDispatcher: unavailable,
      pythonRuntime: { id: "saved-search-http-deny-python", resolve: () => { throw new Error("Python is outside the synthetic API fixture"); } },
    });
    try {
      const api = await app.listen({ host: "127.0.0.1", port: 0 });
      const patch = (headers: Record<string, string>) => fetch(`${api}/v1/discovery/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ schedulingEnabled: true }),
      });
      // A real HTTP request avoids app.inject's automatic test-only Origin.
      const headerless = await patch({});
      expect(headerless.status).toBe(403);
      expect(await headerless.json()).toMatchObject({ ok: false, error: "cross_site_request" });
      expect(read.get()).toEqual({ search_config_json: raw, created_at: "created", updated_at: "updated" });

      const trusted = await patch({ origin: "http://127.0.0.1:5174", "sec-fetch-site": "same-origin" });
      expect(trusted.status).toBe(409);
      const body = await trusted.text();
      expect(JSON.parse(body)).toMatchObject({ ok: false, error: "invalid_saved_search" });
      expect(body).toContain("restore a verified backup");
      expect(body).not.toContain("private marker");
      expect(read.get()).toEqual({ search_config_json: raw, created_at: "created", updated_at: "updated" });
      expect(call).not.toHaveBeenCalled();
    } finally {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses defaults only for a genuinely absent settings row", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-saved-search-"));
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactDatabase(dbPath);
    const app = buildApp({ dbPath, configPath: path.join(dir, "config.json") });
    try {
      const read = await app.inject({ method: "GET", url: "/v1/discovery/settings" });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().settings.boards).toEqual(["indeed", "linkedin", "zip_recruiter"]);
      const update = await app.inject({
        method: "PATCH", url: "/v1/discovery/settings", payload: { boards: ["linkedin"] },
      });
      expect(update.statusCode, update.body).toBe(200);
      expect(update.json().settings.boards).toEqual(["linkedin"]);
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    '{"private":"synthetic secret",', "", "null", "[]", '{"boards":null}',
    '{"boards":"synthetic secret"}', '{"queries":[null]}', '{"queries":[{}]}',
    '{"queries":[{"query":"Synthetic role","tier":"synthetic secret"}]}',
    '{"locations":[{"location":"Synthetic city","remote":"false"}]}', '{"defaults":1}',
    '{"boards":["linkedin"],"defaults":{"results_per_site":null}}',
    '{"defaults":{"results_per_site":"synthetic secret"}}', '{"defaults":{"hours_old":0}}',
    '{"max_parallel_families":"synthetic secret"}', '{"automation":{"min_fit_score":"synthetic secret"}}',
    '{"automation":{"apply_approval_required":"synthetic secret"}}',
    '{"crawl_user_agent":{"use_browser_headers":"synthetic secret"}}',
    '{"exact_title_exclusions":"synthetic secret"}', '{"boards":["linkedin","synthetic secret"]}',
    Buffer.from("synthetic secret"),
  ])("refuses corrupt saved inputs without disclosing or replacing them", async (raw) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-saved-search-"));
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactDatabase(dbPath);
    const db = new Database(dbPath);
    db.prepare("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')").run(raw);
    const app = buildApp({ dbPath, configPath: path.join(dir, "config.json") });
    try {
      for (const request of [
        { method: "GET" as const, url: "/v1/discovery/settings" },
        { method: "PATCH" as const, url: "/v1/discovery/settings", payload: { schedulingEnabled: true } },
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json()).toMatchObject({ ok: false, error: "invalid_saved_search" });
        expect(response.json().message).toContain("restore a verified backup");
        expect(response.body).not.toContain("synthetic secret");
        const row = db.prepare("SELECT search_config_json, created_at, updated_at FROM discovery_settings").get() as {
          search_config_json: string | Buffer; created_at: string; updated_at: string;
        };
        expect(row).toEqual({ search_config_json: raw, created_at: "created", updated_at: "updated" });
      }

      // Recovery is explicit: restore a verified synthetic row, then retry.
      const restored = '{ "boards": ["linkedin"], "queries": [{"query":"Synthetic role","tier":1}] }';
      db.prepare("UPDATE discovery_settings SET search_config_json=?").run(restored);
      const read = await app.inject({ method: "GET", url: "/v1/discovery/settings" });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().settings.boards).toEqual(["linkedin"]);
      expect((db.prepare("SELECT search_config_json FROM discovery_settings").get() as { search_config_json: string }).search_config_json).toBe(restored);
      const update = await app.inject({
        method: "PATCH", url: "/v1/discovery/settings", payload: { resultsPerSite: 25 },
      });
      expect(update.statusCode, update.body).toBe(200);
      const saved = JSON.parse((db.prepare("SELECT search_config_json FROM discovery_settings").get() as { search_config_json: string }).search_config_json);
      expect(saved.boards).toEqual(["linkedin"]);
      expect(saved.queries).toEqual([{ query: "Synthetic role", tier: 1 }]);
    } finally {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['{ "sites": ["glassdoor"], "queries": [{"query":"Synthetic role","tier":1}] }', ["glassdoor"]],
    ['{ "boards": [], "sites": ["glassdoor"], "queries": [{"query":"Synthetic role","tier":1}] }', ["glassdoor"]],
    ['{ "boards": ["glassdoor"], "sites": [], "queries": [{"query":"Synthetic role","tier":1}] }', []],
  ])("retains supported legacy sites as boards on an unrelated settings update", async (raw, legacySites) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-saved-search-"));
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactDatabase(dbPath);
    const db = new Database(dbPath);
    db.prepare("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')").run(raw);
    const app = buildApp({ dbPath, configPath: path.join(dir, "config.json") });
    try {
      const read = await app.inject({ method: "GET", url: "/v1/discovery/settings" });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().settings.boards).toEqual(["glassdoor"]);
      expect((db.prepare("SELECT search_config_json FROM discovery_settings").get() as { search_config_json: string }).search_config_json).toBe(raw);
      const update = await app.inject({
        method: "PATCH", url: "/v1/discovery/settings", payload: { resultsPerSite: 25 },
      });
      expect(update.statusCode, update.body).toBe(200);
      const saved = JSON.parse((db.prepare("SELECT search_config_json FROM discovery_settings").get() as { search_config_json: string }).search_config_json);
      expect(saved.boards).toEqual(["glassdoor"]);
      expect(saved.sites).toEqual(legacySites);
      expect(saved.queries).toEqual([{ query: "Synthetic role", tier: 1 }]);
    } finally {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
