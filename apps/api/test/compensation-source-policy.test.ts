import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listCompensationSources } from "../src/compensation-source-policy.js";
import type { CompensationSourceRegistryResponse } from "../src/contracts.js";
import { buildApp } from "../src/server.js";

function withTempApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-api-compensation-sources-"));
  const app = buildApp({
    dbPath: path.join(dir, "jobs.db"),
    settingsPath: path.join(dir, "dashboard.json"),
  });
  return {
    app,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function source(response: CompensationSourceRegistryResponse, sourceId: string) {
  const match = response.sources.find((entry) => entry.sourceId === sourceId);
  expect(match).toBeDefined();
  return match!;
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectKeys(entry, keys);
    }
    return keys;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("compensation source policy", () => {
  it("serves a read-only registry of safe compensation source policy fields", async () => {
    const { app, cleanup } = withTempApp();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/compensation/sources" });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as CompensationSourceRegistryResponse;
      expect(body.ok).toBe(true);
      expect(body.sources.map((entry) => entry.sourceId)).toEqual([
        "posted_salary_text",
        "eurostat_structure_of_earnings",
        "esco_occupation_taxonomy",
        "spain_ine_salary_structure",
        "levels_fyi",
        "glassdoor",
      ]);
      expect(source(body, "eurostat_structure_of_earnings")).toMatchObject({
        sourceType: "public_wage_baseline",
        accessMode: "public_dataset",
        availability: "available",
        licenseStatus: "not_required",
        configured: true,
        coverage: { geography: "europe" },
      });
      expect(source(body, "posted_salary_text")).toMatchObject({
        sourceType: "posted_salary",
        accessMode: "local_posting_text",
        availability: "available",
      });
      for (const entry of body.sources) {
        expect(entry.displayName).toBeTruthy();
        expect(entry.freshnessPolicy).toBeTruthy();
        expect(entry.attributionRequirement).toBeTruthy();
        expect(entry.coverage.notes).toBeTruthy();
        expect(Array.isArray(entry.supportedFields)).toBe(true);
        expect(Array.isArray(entry.notes)).toBe(true);
      }
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("keeps licensed sources unavailable by default with explicit disabled reasons", () => {
    const response = listCompensationSources({});

    expect(source(response, "levels_fyi")).toMatchObject({
      availability: "unavailable",
      accessMode: "unavailable_until_permitted",
      licenseStatus: "requires_license",
      configured: false,
      supportedFields: [],
      disabledReason: "Requires licensed Levels.fyi access mode and explicit Europe coverage confirmation.",
    });
    expect(source(response, "glassdoor")).toMatchObject({
      availability: "unavailable",
      accessMode: "unavailable_until_permitted",
      licenseStatus: "requires_permission",
      configured: false,
      supportedFields: [],
      disabledReason: "Requires Glassdoor partner API access or written permission.",
    });
  });

  it("requires both permitted Levels.fyi access and explicit Europe coverage", () => {
    const missingCoverage = listCompensationSources({
      JOBHUNTER_LEVELS_FYI_ACCESS_MODE: "licensed_api",
    });
    expect(source(missingCoverage, "levels_fyi")).toMatchObject({
      availability: "unavailable",
      accessMode: "licensed_api",
      configured: false,
      disabledReason: "Requires explicit Levels.fyi Europe coverage confirmation.",
    });

    const configured = listCompensationSources({
      JOBHUNTER_LEVELS_FYI_ACCESS_MODE: "enterprise_mcp",
      JOBHUNTER_LEVELS_FYI_EUROPE_COVERAGE: "true",
    });
    expect(source(configured, "levels_fyi")).toMatchObject({
      availability: "available",
      accessMode: "enterprise_mcp",
      licenseStatus: "permitted",
      configured: true,
      disabledReason: null,
      coverage: { regions: ["Europe"] },
    });
  });

  it("requires permitted Glassdoor partner or written-permission access", () => {
    const invalid = listCompensationSources({
      JOBHUNTER_GLASSDOOR_ACCESS_MODE: "public_dataset",
    });
    expect(source(invalid, "glassdoor")).toMatchObject({
      availability: "unavailable",
      accessMode: "unavailable_until_permitted",
      configured: false,
      disabledReason: "Configured Glassdoor access mode is not permitted for compensation import.",
    });

    const configured = listCompensationSources({
      JOBHUNTER_GLASSDOOR_ACCESS_MODE: "written_permission",
    });
    expect(source(configured, "glassdoor")).toMatchObject({
      availability: "available",
      accessMode: "written_permission",
      licenseStatus: "permitted",
      configured: true,
      disabledReason: null,
    });
  });

  it("does not expose credentials, raw provider payloads, local paths, or scraped salary data", () => {
    const response = listCompensationSources({
      JOBHUNTER_LEVELS_FYI_ACCESS_MODE: "licensed_data_feed",
      JOBHUNTER_LEVELS_FYI_EUROPE_COVERAGE: "1",
      JOBHUNTER_GLASSDOOR_ACCESS_MODE: "partner_api",
      JOBHUNTER_LEVELS_FYI_API_KEY: "levels-secret",
      JOBHUNTER_GLASSDOOR_TOKEN: "glassdoor-token",
    });

    expect(JSON.stringify(response)).not.toContain("levels-secret");
    expect(JSON.stringify(response)).not.toContain("glassdoor-token");
    expect([...collectKeys(response)].sort()).not.toEqual(
      expect.arrayContaining([
        "apiKey",
        "credential",
        "credentials",
        "localPath",
        "rawPayload",
        "rawProviderPayload",
        "rawSalaryData",
        "scrapedContent",
        "secret",
        "token",
      ]),
    );
  });

  it("is deterministic and does not call network APIs", () => {
    const fetch = vi.fn(async () => {
      throw new Error("network must not be called");
    });
    vi.stubGlobal("fetch", fetch);

    const first = listCompensationSources({
      JOBHUNTER_LEVELS_FYI_ACCESS_MODE: "licensed_api",
      JOBHUNTER_LEVELS_FYI_EUROPE_COVERAGE: "yes",
    });
    const second = listCompensationSources({
      JOBHUNTER_LEVELS_FYI_ACCESS_MODE: "licensed_api",
      JOBHUNTER_LEVELS_FYI_EUROPE_COVERAGE: "yes",
    });

    expect(second).toEqual(first);
    expect(fetch).not.toHaveBeenCalled();
  });
});
