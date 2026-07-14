import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONFIG_LOCK_DIRECTORY,
  ConfigFileInputError,
  readConfigObject,
  updateConfigObject,
  writeConfigObject,
} from "../src/config-file.js";

const temporaryDirectories: string[] = [];

function configPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-config-file-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "config.json");
}

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-config-file-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("config.json transactions", () => {
  it("merges a fresh update without discarding unrelated settings", () => {
    const file = configPath();
    writeConfigObject(file, { daily_budget_usd: 25 });

    updateConfigObject(file, (config) => {
      config.analysis_legs = ["codex"];
    });

    expect(readConfigObject(file)).toEqual({
      daily_budget_usd: 25,
      analysis_legs: ["codex"],
    });
    expect(fs.existsSync(path.join(path.dirname(file), CONFIG_LOCK_DIRECTORY))).toBe(false);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("rejects an untrusted non-directory lock path", () => {
    const file = configPath();
    fs.writeFileSync(path.join(path.dirname(file), CONFIG_LOCK_DIRECTORY), "not a lock directory");

    expect(() => updateConfigObject(file, (config) => {
      config.daily_budget_usd = 10;
    })).toThrow(ConfigFileInputError);
  });

  it("preserves an existing custom config parent while keeping the config private", () => {
    const sharedDirectory = temporaryDirectory();
    fs.chmodSync(sharedDirectory, 0o750);
    const file = path.join(sharedDirectory, "config.json");

    writeConfigObject(file, { daily_budget_usd: 25 });

    expect(fs.statSync(sharedDirectory).mode & 0o777).toBe(0o750);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("makes a newly created config parent private", () => {
    const root = temporaryDirectory();
    const parent = path.join(root, "jobctrl", "settings");
    const file = path.join(parent, "config.json");

    writeConfigObject(file, { daily_budget_usd: 25 });

    expect(fs.statSync(path.dirname(parent)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(parent).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
