import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildApp } from "../src/server.js";
import { initializeExactDatabase } from "./exact-schema.js";

const profile = (locations: string, workModels: string, name = "Owned candidate") => ({
  personal: { full_name: name },
  experience: {
    target_role: "Synthetic role",
    target_locations: locations,
    target_work_models: workModels,
  },
  resume: {
    executive_profile: { baseline_text: "Owned synthetic profile." },
    experience_entries: [{ id: "owned-role", title: "Synthetic role", company: "Synthetic employer", bullets: [] }],
    education_entries: [], skill_categories: [], tailoring_rules: {},
  },
});

describe("location-free Remote save boundaries", () => {
  it("rejects newly incompatible edits and preserves profile, settings, and events", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-remote-owned-"));
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactDatabase(dbPath);
    const db = new Database(dbPath);
    const raw = '{ "boards": ["linkedin", "indeed"], "defaults": {"hours_old": 48} }';
    db.prepare("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')").run(raw);
    const app = buildApp({ dbPath, configPath: path.join(dir, "config.json"), placeValidator: async () => true });
    const savedState = () => ({
      profile: db.prepare("SELECT * FROM candidate_profiles WHERE tenant_id='local' AND profile_id='default'").get(),
      settings: db.prepare("SELECT * FROM discovery_settings WHERE tenant_id='local'").get(),
      events: db.prepare("SELECT * FROM job_events WHERE event_type='ProfileUpdated'").all(),
    });
    try {
      const initial = await app.inject({
        method: "PATCH", url: "/v1/profile", payload: { profile: profile("Synthetic City", "hybrid") },
      });
      expect(initial.statusCode, initial.body).toBe(200);
      const before = savedState();
      for (const [locations, models] of [
        ["Synthetic City; ", "hybrid; remote"],
        ["Synthetic City; ", "hybrid; Remote"],
        ["Synthetic City; \u0085", "hybrid; \u0085remote\u0085"],
        ["", "Target locat\u0131on\u017f: remote"],
      ] as const) {
        const rejected = await app.inject({
          method: "PATCH", url: "/v1/profile", payload: { profile: profile(locations, models) },
        });
        expect(rejected.statusCode, rejected.body).toBe(400);
        expect(rejected.json()).toMatchObject({ ok: false, error: "unsupported_remote_search" });
        expect(rejected.json().message).toContain("Indeed");
        expect(rejected.json().message).toContain("lookback");
        expect(rejected.json().message).toContain("Deselect Indeed");
        expect(savedState()).toEqual(before);
      }

      const selectSupported = await app.inject({
        method: "PATCH", url: "/v1/discovery/settings", payload: { boards: ["linkedin"] },
      });
      expect(selectSupported.statusCode, selectSupported.body).toBe(200);
      const mixedWithoutLocation = await app.inject({
        method: "PATCH", url: "/v1/profile",
        payload: { profile: profile("Synthetic City; ", "hybrid; remote, onsite") },
      });
      expect(mixedWithoutLocation.statusCode, mixedWithoutLocation.body).toBe(400);
      expect(mixedWithoutLocation.json()).toMatchObject({ ok: false, error: "unsupported_remote_search" });
      expect(mixedWithoutLocation.json().message).toContain("needs a location");
      const accepted = await app.inject({
        method: "PATCH", url: "/v1/profile",
        payload: { profile: profile("Synthetic City; ", "hybrid; remote") },
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json().profile.experience).toMatchObject({
        target_locations: "Synthetic City; ", target_work_models: "hybrid; remote",
      });
      const supportedState = savedState();
      const rejectedBoard = await app.inject({
        method: "PATCH", url: "/v1/discovery/settings", payload: { boards: ["linkedin", "indeed"] },
      });
      expect(rejectedBoard.statusCode, rejectedBoard.body).toBe(400);
      expect(rejectedBoard.json()).toMatchObject({ ok: false, error: "unsupported_remote_search" });
      expect(savedState()).toEqual(supportedState);

      // Simulate a legacy combination predating this guard. Unrelated edits
      // remain possible, while changing the lookback or Remote row is refused.
      db.prepare("UPDATE discovery_settings SET search_config_json=? WHERE tenant_id='local'").run(raw);
      const legacy = await app.inject({
        method: "PATCH", url: "/v1/profile",
        payload: { profile: profile("Synthetic City; ", "hybrid; remote", "Updated owned candidate") },
      });
      expect(legacy.statusCode, legacy.body).toBe(200);
      const legacySettings = await app.inject({
        method: "PATCH", url: "/v1/discovery/settings", payload: { resultsPerSite: 20 },
      });
      expect(legacySettings.statusCode, legacySettings.body).toBe(200);
      const legacyState = savedState();
      const ageEdit = await app.inject({
        method: "PATCH", url: "/v1/discovery/settings", payload: { hoursOld: 24 },
      });
      expect(ageEdit.statusCode, ageEdit.body).toBe(400);
      expect(ageEdit.json().error).toBe("unsupported_remote_search");
      const rowEdit = await app.inject({
        method: "PATCH", url: "/v1/profile",
        payload: { profile: profile("Synthetic City; ", "hybrid; remote, onsite", "Updated owned candidate") },
      });
      expect(rowEdit.statusCode, rowEdit.body).toBe(400);
      expect(rowEdit.json().error).toBe("unsupported_remote_search");
      expect(savedState()).toEqual(legacyState);
    } finally {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not read damaged Discovery settings for unrelated profile edits", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-remote-owned-"));
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactDatabase(dbPath);
    const db = new Database(dbPath);
    const raw = '{ "private": "synthetic secret",';
    db.prepare("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')").run(raw);
    const app = buildApp({ dbPath, configPath: path.join(dir, "config.json"), placeValidator: async () => true });
    try {
      const unrelated = await app.inject({
        method: "PATCH", url: "/v1/profile", payload: { profile: profile("Synthetic City", "hybrid") },
      });
      expect(unrelated.statusCode, unrelated.body).toBe(200);
      const before = db.prepare("SELECT * FROM candidate_profiles").get();
      const rejected = await app.inject({
        method: "PATCH", url: "/v1/profile", payload: { profile: profile("Synthetic City; ", "hybrid; remote") },
      });
      expect(rejected.statusCode, rejected.body).toBe(409);
      expect(rejected.json().error).toBe("invalid_saved_search");
      expect(rejected.body).not.toContain("synthetic secret");
      expect(db.prepare("SELECT * FROM candidate_profiles").get()).toEqual(before);
      expect(db.prepare("SELECT search_config_json FROM discovery_settings").get()).toEqual({ search_config_json: raw });
    } finally {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { boards: ["linkedin"], hours: 48, location: "Synthetic City", nextBoards: ["linkedin", "glassdoor"], nextHours: undefined, reason: "Glassdoor" },
    { boards: ["linkedin"], hours: 25, location: "", nextBoards: ["linkedin", "zip_recruiter"], nextHours: undefined, reason: "whole days" },
    { boards: ["linkedin", "zip_recruiter"], hours: 48, location: "", nextBoards: undefined, nextHours: 25, reason: "whole days" },
  ])("rejects newly unsupported board or lookback edits without changing saved bytes", async ({
    boards, hours, location, nextBoards, nextHours, reason,
  }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-remote-owned-"));
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactDatabase(dbPath);
    const db = new Database(dbPath);
    const raw = JSON.stringify({ boards, defaults: { hours_old: hours } });
    db.prepare("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')").run(raw);
    const app = buildApp({ dbPath, configPath: path.join(dir, "config.json"), placeValidator: async () => true });
    try {
      const initial = await app.inject({ method: "PATCH", url: "/v1/profile", payload: { profile: profile(location, "remote") } });
      expect(initial.statusCode, initial.body).toBe(200);
      const beforeProfile = db.prepare("SELECT * FROM candidate_profiles").get();
      const beforeSettings = db.prepare("SELECT * FROM discovery_settings").get();
      const rejected = await app.inject({
        method: "PATCH", url: "/v1/discovery/settings", payload: { boards: nextBoards, hoursOld: nextHours },
      });
      expect(rejected.statusCode, rejected.body).toBe(400);
      expect(rejected.json().error).toBe("unsupported_remote_search");
      expect(rejected.json().message).toContain(reason);
      expect(db.prepare("SELECT * FROM candidate_profiles").get()).toEqual(beforeProfile);
      expect(db.prepare("SELECT * FROM discovery_settings").get()).toEqual(beforeSettings);
    } finally {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a newly added separate location-free Hybrid row while retaining a Remote row", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-remote-owned-"));
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactDatabase(dbPath);
    const db = new Database(dbPath);
    db.prepare("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')")
      .run('{"boards":["linkedin"],"defaults":{"hours_old":48}}');
    const app = buildApp({ dbPath, configPath: path.join(dir, "config.json"), placeValidator: async () => true });
    try {
      const initial = await app.inject({ method: "PATCH", url: "/v1/profile", payload: { profile: profile("", "remote") } });
      expect(initial.statusCode, initial.body).toBe(200);
      const before = db.prepare("SELECT * FROM candidate_profiles").get();
      const rejected = await app.inject({
        method: "PATCH", url: "/v1/profile", payload: { profile: profile("; ", "remote; hybrid") },
      });
      expect(rejected.statusCode, rejected.body).toBe(400);
      expect(rejected.json()).toMatchObject({ ok: false, error: "unsupported_remote_search" });
      expect(rejected.json().message).toContain("needs a location");
      expect(db.prepare("SELECT * FROM candidate_profiles").get()).toEqual(before);

      // An existing legacy row may be kept during unrelated profile changes.
      db.prepare("UPDATE candidate_profiles SET experience_target_locations=?, experience_target_work_models=?")
        .run("; ", "remote; hybrid");
      const unchanged = await app.inject({
        method: "PATCH", url: "/v1/profile", payload: { profile: profile("; ", "remote; hybrid", "Updated candidate") },
      });
      expect(unchanged.statusCode, unchanged.body).toBe(200);
      const corrected = await app.inject({ method: "PATCH", url: "/v1/profile", payload: { profile: profile("", "remote") } });
      expect(corrected.statusCode, corrected.body).toBe(200);
    } finally {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks legacy locations on settings edits and before clearing a Profile override", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-remote-owned-"));
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactDatabase(dbPath);
    const db = new Database(dbPath);
    const raw = '{ "boards": ["linkedin"], "defaults": {"hours_old": 48}, "locations": [{"label":"Remote","location":"","remote":true}] }';
    db.prepare("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')").run(raw);
    const app = buildApp({ dbPath, configPath: path.join(dir, "config.json"), placeValidator: async () => true });
    try {
      const invalidBoard = await app.inject({
        method: "PATCH", url: "/v1/discovery/settings", payload: { boards: ["linkedin", "indeed"] },
      });
      expect(invalidBoard.statusCode, invalidBoard.body).toBe(400);
      expect(invalidBoard.json().error).toBe("unsupported_remote_search");
      expect(db.prepare("SELECT search_config_json FROM discovery_settings").get()).toEqual({ search_config_json: raw });

      const override = await app.inject({ method: "PATCH", url: "/v1/profile", payload: { profile: profile("Synthetic City", "hybrid") } });
      expect(override.statusCode, override.body).toBe(200);
      const boardWithOverride = await app.inject({
        method: "PATCH", url: "/v1/discovery/settings", payload: { boards: ["linkedin", "indeed"] },
      });
      expect(boardWithOverride.statusCode, boardWithOverride.body).toBe(200);
      const savedProfile = db.prepare("SELECT * FROM candidate_profiles").get();
      const savedSettings = db.prepare("SELECT * FROM discovery_settings").get();
      const clear = await app.inject({ method: "PATCH", url: "/v1/profile", payload: { profile: profile("", "") } });
      expect(clear.statusCode, clear.body).toBe(400);
      expect(clear.json().error).toBe("unsupported_remote_search");
      expect(db.prepare("SELECT * FROM candidate_profiles").get()).toEqual(savedProfile);
      expect(db.prepare("SELECT * FROM discovery_settings").get()).toEqual(savedSettings);
    } finally {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves an explicitly empty legacy location list on unrelated settings edits", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-remote-owned-"));
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactDatabase(dbPath);
    const db = new Database(dbPath);
    db.prepare("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')")
      .run('{"boards":["linkedin"],"locations":[],"queries":[],"location_accept":[]}');
    const app = buildApp({ dbPath, configPath: path.join(dir, "config.json"), placeValidator: async () => true });
    try {
      const result = await app.inject({ method: "PATCH", url: "/v1/discovery/settings", payload: { resultsPerSite: 20 } });
      expect(result.statusCode, result.body).toBe(200);
      const row = db.prepare("SELECT search_config_json FROM discovery_settings").get() as { search_config_json: string };
      expect(JSON.parse(row.search_config_json)).toMatchObject({ locations: [], queries: [], location_accept: [] });
    } finally {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates only rows selected by literal saved location labels", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-remote-owned-"));
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactDatabase(dbPath);
    const db = new Database(dbPath);
    const raw = JSON.stringify({
      boards: ["linkedin"], defaults: { hours_old: 48 }, location_labels: ["City"],
      locations: [{ label: "Remote", location: "", remote: true }, { label: "City", location: "Synthetic City", remote: false }],
    });
    db.prepare("INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated')").run(raw);
    const app = buildApp({ dbPath, configPath: path.join(dir, "config.json"), placeValidator: async () => true });
    try {
      const result = await app.inject({ method: "PATCH", url: "/v1/discovery/settings", payload: { boards: ["linkedin", "indeed"] } });
      expect(result.statusCode, result.body).toBe(200);
      const row = db.prepare("SELECT search_config_json FROM discovery_settings").get() as { search_config_json: string };
      const saved = JSON.parse(row.search_config_json);
      expect(saved.location_labels).toEqual(["City"]);
      expect(saved.locations).toEqual(JSON.parse(raw).locations);
    } finally {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
