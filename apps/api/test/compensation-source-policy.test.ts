import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listCompensationSources } from "../src/compensation-source-policy.js";
import type { CompensationSourceRegistryResponse } from "../src/contracts.js";
import { buildApp } from "../src/server.js";

function withTempApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-compensation-sources-"));
  const configPath = path.join(dir, "config.json");
  const app = buildApp({
    dbPath: path.join(dir, "jobs.db"),
    configPath,
  });
  return {
    app,
    configPath,
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
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("compensation source policy", () => {
  it("serves a registry of safe compensation source policy fields", async () => {
    const { app, cleanup } = withTempApp();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/compensation/sources" });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as CompensationSourceRegistryResponse;
      expect(body.ok).toBe(true);
      expect(body.sources.map((entry) => entry.sourceId)).toEqual([
        "posted_salary_text",
        "levels_fyi",
        "glassdoor",
        "manual_reported_compensation",
        "euro_top_tech",
      ]);
      expect(source(body, "manual_reported_compensation")).toMatchObject({
        sourceType: "reported_compensation",
        accessMode: "manual_import",
        availability: "available",
        licenseStatus: "not_required",
        configured: true,
        coverage: { geography: "import_file" },
      });
      expect(source(body, "posted_salary_text")).toMatchObject({
        sourceType: "posted_salary",
        accessMode: "local_posting_text",
        availability: "available",
      });
      expect(source(body, "euro_top_tech")).toMatchObject({
        sourceType: "reported_compensation",
        accessMode: "public_dataset",
        availability: "available",
        licenseStatus: "not_required",
        sourceUrl: "https://www.eurotoptech.com/data",
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

  it("defaults Levels.fyi to disabled tokenless public access", () => {
    const response = listCompensationSources({});

    expect(source(response, "levels_fyi")).toMatchObject({
      availability: "unavailable",
      accessMode: "public_markdown",
      licenseStatus: "permitted",
      configured: false,
      supportedFields: [],
      disabledReason: "Disabled in Compensation sources settings.",
      sourceUrl: "https://www.levels.fyi/llms.txt",
      control: {
        accessMode: "public_markdown",
        europeCoverageRequired: false,
      },
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

  it("ignores legacy compensation environment settings", () => {
    vi.stubEnv("JOBCTRL_LEVELS_FYI_ACCESS_MODE", "public_markdown");
    vi.stubEnv("JOBCTRL_LEVELS_FYI_EUROPE_COVERAGE", "true");

    expect(source(listCompensationSources({}), "levels_fyi")).toMatchObject({
      accessMode: "public_markdown",
      availability: "unavailable",
      configured: false,
      disabledReason: "Disabled in Compensation sources settings.",
      control: { enabled: false },
    });
  });

  it("enables public Levels.fyi pages without credentials or coverage confirmation", async () => {
    const { app, cleanup } = withTempApp();
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/v1/compensation/sources",
        payload: {
          sourceId: "levels_fyi",
          enabled: true,
          accessMode: "public_markdown",
          europeCoverageConfirmed: false,
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(source(response.json(), "levels_fyi")).toMatchObject({
        availability: "available",
        accessMode: "public_markdown",
        configured: true,
        licenseStatus: "permitted",
        disabledReason: null,
        attributionRequirement:
          "Display Data source: Levels.fyi (https://www.levels.fyi) and preserve the canonical page URL.",
        control: {
          enabled: true,
          accessMode: "public_markdown",
          europeCoverageRequired: false,
          europeCoverageConfirmed: false,
        },
      });
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("still requires explicit Europe coverage for licensed Levels.fyi modes", () => {
    const missingCoverage = listCompensationSources({
      levels_fyi: {
        enabled: true,
        accessMode: "licensed_api",
        europeCoverageConfirmed: false,
      },
    });
    expect(source(missingCoverage, "levels_fyi")).toMatchObject({
      availability: "unavailable",
      accessMode: "licensed_api",
      configured: false,
      disabledReason: "Requires explicit Levels.fyi Europe coverage confirmation.",
    });

    const configured = listCompensationSources({
      levels_fyi: {
        enabled: true,
        accessMode: "enterprise_mcp",
        europeCoverageConfirmed: true,
      },
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
      glassdoor: {
        enabled: true,
        accessMode: "public_dataset",
        europeCoverageConfirmed: false,
      },
    });
    expect(source(invalid, "glassdoor")).toMatchObject({
      availability: "unavailable",
      accessMode: "unavailable_until_permitted",
      configured: false,
      disabledReason: "Configured Glassdoor access mode is not permitted for compensation import.",
    });

    const configured = listCompensationSources({
      glassdoor: {
        enabled: true,
        accessMode: "written_permission",
        europeCoverageConfirmed: false,
      },
    });
    expect(source(configured, "glassdoor")).toMatchObject({
      availability: "available",
      accessMode: "written_permission",
      licenseStatus: "permitted",
      configured: true,
      disabledReason: null,
    });
  });

  it("persists user-owned Levels.fyi and Glassdoor source settings", async () => {
    const { app, configPath, cleanup } = withTempApp();
    try {
      const levelsResponse = await app.inject({
        method: "PATCH",
        url: "/v1/compensation/sources",
        payload: {
          sourceId: "levels_fyi",
          enabled: true,
          accessMode: "licensed_data_feed",
          europeCoverageConfirmed: true,
        },
      });
      expect(levelsResponse.statusCode, levelsResponse.body).toBe(200);
      expect(source(levelsResponse.json(), "levels_fyi")).toMatchObject({
        availability: "available",
        configured: true,
        control: {
          kind: "user_preference",
          enabled: true,
          accessMode: "licensed_data_feed",
          europeCoverageConfirmed: true,
        },
      });

      const glassdoorResponse = await app.inject({
        method: "PATCH",
        url: "/v1/compensation/sources",
        payload: {
          sourceId: "glassdoor",
          enabled: true,
          accessMode: "written_permission",
        },
      });
      expect(glassdoorResponse.statusCode, glassdoorResponse.body).toBe(200);
      expect(source(glassdoorResponse.json(), "glassdoor")).toMatchObject({
        availability: "available",
        configured: true,
        control: {
          kind: "user_preference",
          enabled: true,
          accessMode: "written_permission",
        },
      });

      const readbackResponse = await app.inject({
        method: "GET",
        url: "/v1/compensation/sources",
      });
      expect(readbackResponse.statusCode, readbackResponse.body).toBe(200);
      expect(source(readbackResponse.json(), "levels_fyi")).toMatchObject({
        configured: true,
        control: {
          enabled: true,
          accessMode: "licensed_data_feed",
          europeCoverageConfirmed: true,
        },
      });
      expect(source(readbackResponse.json(), "glassdoor")).toMatchObject({
        configured: true,
        control: {
          enabled: true,
          accessMode: "written_permission",
        },
      });

      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toMatchObject({
        compensation_sources: {
          levels_fyi: {
            enabled: true,
            access_mode: "licensed_data_feed",
            europe_coverage_confirmed: true,
          },
          glassdoor: {
            enabled: true,
            access_mode: "written_permission",
          },
        },
      });
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("rejects enabling a licensed source without its access prerequisites", async () => {
    const { app, cleanup } = withTempApp();
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/v1/compensation/sources",
        payload: {
          sourceId: "levels_fyi",
          enabled: true,
          accessMode: null,
          europeCoverageConfirmed: false,
        },
      });

      expect(response.statusCode, response.body).toBe(400);
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("keeps an explicit user disable authoritative over legacy environment access", async () => {
    vi.stubEnv("JOBCTRL_GLASSDOOR_ACCESS_MODE", "partner_api");
    const { app, cleanup } = withTempApp();
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/v1/compensation/sources",
        payload: {
          sourceId: "glassdoor",
          enabled: false,
          accessMode: null,
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(source(response.json(), "glassdoor")).toMatchObject({
        accessMode: "unavailable_until_permitted",
        availability: "unavailable",
        configured: false,
        licenseStatus: "requires_permission",
        control: {
          enabled: false,
          accessMode: null,
        },
      });
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("does not expose credentials, raw provider payloads, local paths, or salary observations", () => {
    vi.stubEnv("JOBCTRL_LEVELS_FYI_API_KEY", "levels-secret");
    vi.stubEnv("JOBCTRL_GLASSDOOR_TOKEN", "glassdoor-token");
    const response = listCompensationSources({
      levels_fyi: {
        enabled: true,
        accessMode: "licensed_data_feed",
        europeCoverageConfirmed: true,
      },
      glassdoor: {
        enabled: true,
        accessMode: "partner_api",
        europeCoverageConfirmed: false,
      },
    });

    expect(JSON.stringify(response)).not.toContain("levels-secret");
    expect(JSON.stringify(response)).not.toContain("glassdoor-token");
    const keys = collectKeys(response);
    for (const forbiddenKey of [
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
    ]) {
      expect(keys).not.toContain(forbiddenKey);
    }
  });

  it("is deterministic and does not call network APIs", () => {
    const fetch = vi.fn(async () => {
      throw new Error("network must not be called");
    });
    vi.stubGlobal("fetch", fetch);

    const preferences = {
      levels_fyi: {
        enabled: true,
        accessMode: "licensed_api" as const,
        europeCoverageConfirmed: true,
      },
    };
    const first = listCompensationSources(preferences);
    const second = listCompensationSources(preferences);

    expect(second).toEqual(first);
    expect(fetch).not.toHaveBeenCalled();
  });
});
