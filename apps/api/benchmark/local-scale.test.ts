import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertAscending,
  assertHash,
  DATASET_SIZES,
  distribution,
  parseCliArgs,
  seedSyntheticDataset,
  withOwnedWorkspace,
} from "./local-scale.js";

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
  });

  it("removes the owned workspace after a failing run", async () => {
    let directory = "";
    await expect(withOwnedWorkspace((workspace) => {
      directory = workspace.directory;
      throw new Error("injected failure");
    })).rejects.toThrow("injected failure");
    expect(directory).not.toBe("");
    expect(fs.existsSync(directory)).toBe(false);
  });

  it("seeds the smallest declared exact-v10 dataset with fixed totals", async () => {
    await withOwnedWorkspace((workspace) => {
      const result = seedSyntheticDataset(workspace, DATASET_SIZES[0]);
      expect(result).toMatchObject({ jobs: 100, events: 300, eventsPerJob: 3 });
      expect(result.artifacts.pdfBytes).toBe(256 * 1_024);
      expect(result.artifacts.htmlBytes).toBe(128 * 1_024);
    });
  }, 30_000);

  it("fails correctness oracles when ordering or bytes are perturbed", () => {
    expect(() => assertAscending(["a", "b"], "test")).not.toThrow();
    expect(() => assertAscending(["b", "a"], "test")).toThrow("ordering oracle failed");
    expect(() => assertHash(Buffer.from("changed"), "0".repeat(64), "preview")).toThrow("hash oracle failed");
  });
});
