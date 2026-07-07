import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveApiConfig } from "../src/config.js";

function legacyToken(): string {
  return "job" + "hunter";
}

function makeHome(): { home: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jobctl-api-config-"));
  return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function seedLegacyWorkspace(home: string): string {
  const legacyDir = path.join(home, `.${legacyToken()}`);
  fs.mkdirSync(path.join(legacyDir, "gmail"), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, ".env"), "GEMINI_API_KEY=placeholder\n");
  fs.writeFileSync(path.join(legacyDir, `${legacyToken()}.db`), "db");
  fs.writeFileSync(path.join(legacyDir, `${legacyToken()}.db-wal`), "wal");
  fs.writeFileSync(path.join(legacyDir, `${legacyToken()}.db-shm`), "shm");
  fs.writeFileSync(path.join(legacyDir, "gmail", "token.json"), "{}");
  return legacyDir;
}

describe("API runtime config workspace migration", () => {
  it("moves the default legacy workspace before returning appDir/dbPath", () => {
    const { home, cleanup } = makeHome();
    try {
      const legacyDir = seedLegacyWorkspace(home);

      const config = resolveApiConfig({ HOME: home });
      const currentDir = path.join(home, ".jobctl");

      expect(config.appDir).toBe(currentDir);
      expect(config.dbPath).toBe(path.join(currentDir, "jobctl.db"));
      expect(fs.existsSync(legacyDir)).toBe(false);
      expect(fs.existsSync(path.join(currentDir, ".env"))).toBe(true);
      expect(fs.existsSync(path.join(currentDir, "gmail", "token.json"))).toBe(true);
      expect(fs.existsSync(path.join(currentDir, "jobctl.db"))).toBe(true);
      expect(fs.existsSync(path.join(currentDir, "jobctl.db-wal"))).toBe(true);
      expect(fs.existsSync(path.join(currentDir, "jobctl.db-shm"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("does not move the default workspace when JOBCTL_DIR is explicit", () => {
    const { home, cleanup } = makeHome();
    try {
      const legacyDir = seedLegacyWorkspace(home);
      const explicitDir = path.join(home, "custom");

      const config = resolveApiConfig({ HOME: home, JOBCTL_DIR: explicitDir });

      expect(config.appDir).toBe(explicitDir);
      expect(fs.existsSync(legacyDir)).toBe(true);
      expect(fs.existsSync(path.join(home, ".jobctl"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("refuses to overwrite an existing current workspace", () => {
    const { home, cleanup } = makeHome();
    try {
      seedLegacyWorkspace(home);
      const currentDir = path.join(home, ".jobctl");
      fs.mkdirSync(currentDir);
      fs.writeFileSync(path.join(currentDir, "sentinel"), "keep");

      expect(() => resolveApiConfig({ HOME: home })).toThrow(/refusing to move legacy workspace/);
      expect(fs.readFileSync(path.join(currentDir, "sentinel"), "utf8")).toBe("keep");
    } finally {
      cleanup();
    }
  });
});
