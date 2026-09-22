import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertAscending,
  assertHash,
  DATASET_SIZES,
  distribution,
  offlineEnvironment,
  parseCliArgs,
  seedSyntheticDataset,
  withOwnedWorkspace,
} from "./local-scale.js";

const uvAvailable = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;

describe("local scale benchmark support", () => {
  it("reports nearest-rank p50, p95, and max while retaining raw samples", () => {
    expect(distribution([10, 1, 9, 2, 8, 3, 7, 4, 6, 5])).toEqual({
      samples: [10, 1, 9, 2, 8, 3, 7, 4, 6, 5], p50: 5, p95: 10, max: 10,
    });
    expect(() => distribution([])).toThrow("at least one sample");
    expect(() => distribution([1, Number.NaN])).toThrow("finite non-negative");
  });

  it("rejects input workspace flags and refuses existing report outputs", () => {
    expect(() => parseCliArgs(["--db", "/tmp/private.db"])).toThrow("unsupported argument");
    expect(() => parseCliArgs(["--app-dir", "/tmp/existing"])).toThrow("unsupported argument");
    expect(() => parseCliArgs(["--json-out", "report.txt"])).toThrow("must end in .json");
    expect(() => parseCliArgs(["--json-out", path.resolve(import.meta.dirname, "../package.json")]))
      .toThrow("refuses to overwrite");
    expect(() => parseCliArgs(["--dirty-exclusion-path", "../private"])).toThrow("stay within the repository");
    expect(() => parseCliArgs(["--dirty-exclusion-path", "workers/automation/uv.lock"]))
      .toThrow("requires path, content SHA-256, and note together");
  });

  it("removes the owned workspace after a failing run", async () => {
    let directory = "";
    await expect(withOwnedWorkspace((workspace) => {
      directory = workspace.directory;
      throw new Error("injected failure");
    }, () => undefined)).rejects.toThrow("injected failure");
    expect(directory).not.toBe("");
    expect(fs.existsSync(directory)).toBe(false);
  });

  it.runIf(uvAvailable)("seeds the smallest declared exact-v10 dataset with fixed totals", async () => {
    await withOwnedWorkspace((workspace) => {
      const result = seedSyntheticDataset(workspace, DATASET_SIZES[0]);
      expect(result).toMatchObject({ jobs: 100, events: 300, eventsPerJob: 3 });
      expect(result.artifacts.pdfBytes).toBe(256 * 1_024);
      expect(result.artifacts.htmlBytes).toBe(128 * 1_024);
    });
  }, 30_000);

  it.runIf(uvAvailable)("exercises the real HTTP, timer SSE, preview, projection, and production RPC paths", async () => {
    const { runDataset } = await import("./run-local-scale.js");
    await withOwnedWorkspace(async (workspace) => {
      const result = await runDataset(workspace, DATASET_SIZES[0]);
      expect(result.projection.projectionRows).toBe(100);
      expect(result.http.searchObserved).toBe(result.http.searchExpected);
      expect(result.sse).toMatchObject({ orderingVerified: true, countVerified: true, eventsPerBurst: 1_000 });
      expect(result.preview.pdfSha256).toBe(result.seed.artifacts.pdfSha256);
      expect(result.preview.htmlSha256).toBe(result.seed.artifacts.htmlSha256);
      expect(result.rpc).toMatchObject({ method: "provider_models", responseHasResult: true, providerModelCalls: 0 });
      expect(result.rpc.providers).toEqual([
        { provider: "codex", configured: false, ready: false, modelCount: 0 },
        { provider: "claude", configured: false, ready: false, modelCount: 0 },
        { provider: "google", configured: false, ready: false, modelCount: 0 },
      ]);
    });
  }, 120_000);

  it.runIf(uvAvailable)("keeps production RPC offline with ambient Bedrock, AWS, and provider credentials", async () => {
    const ambientHome = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-hostile-home-"));
    const awsDirectory = path.join(ambientHome, ".aws");
    fs.mkdirSync(awsDirectory, { recursive: true });
    const credentialsPath = path.join(awsDirectory, "credentials");
    fs.writeFileSync(credentialsPath, "[ambient]\naws_access_key_id = ambient\naws_secret_access_key = ambient\n");
    const hostile = {
      HOME: ambientHome,
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_PROFILE: "ambient",
      AWS_ACCESS_KEY_ID: "ambient",
      AWS_SECRET_ACCESS_KEY: "ambient",
      AWS_SESSION_TOKEN: "ambient",
      AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
      CODEX_API_KEY: "ambient",
      OPENAI_API_KEY: "ambient",
      ANTHROPIC_API_KEY: "ambient",
      GEMINI_API_KEY: "ambient",
      GOOGLE_API_KEY: "ambient",
      GOOGLE_APPLICATION_CREDENTIALS: path.join(ambientHome, "google.json"),
    } as const;
    const previous = new Map(Object.keys(hostile).map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, hostile);
      await withOwnedWorkspace(async (workspace) => {
        const isolated = offlineEnvironment(workspace.directory);
        expect(isolated.HOME).toBe(path.join(workspace.directory, ".benchmark-home"));
        expect(isolated.AWS_SHARED_CREDENTIALS_FILE).toBe(
          path.join(workspace.directory, ".benchmark-home", "aws", "credentials"),
        );
        for (const key of Object.keys(hostile)) {
          if (key !== "HOME" && key !== "AWS_SHARED_CREDENTIALS_FILE") expect(isolated[key]).toBeUndefined();
        }
        const { measureRpc } = await import("./run-local-scale.js");
        const result = await measureRpc(workspace);
        expect(result).toMatchObject({
          preflightMethod: "provider_status",
          providerStatusesNonReady: true,
          catalogEnvelopeVerified: true,
          providerModelCalls: 0,
        });
        expect(result.providers.every((provider) => !provider.configured && !provider.ready && provider.modelCount === 0))
          .toBe(true);
      });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(ambientHome, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails correctness oracles when ordering or bytes are perturbed", () => {
    expect(() => assertAscending(["a", "b"], "test")).not.toThrow();
    expect(() => assertAscending(["b", "a"], "test")).toThrow("ordering oracle failed");
    expect(() => assertHash(Buffer.from("changed"), "0".repeat(64), "preview")).toThrow("hash oracle failed");
  });
});
