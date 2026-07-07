import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveApiConfig } from "../src/config.js";

function legacyToken(): string {
  return "job" + "hunter";
}

function immediateLegacyToken(): string {
  return "job" + "ctl";
}

function makeHome(): { home: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-config-"));
  return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function seedLegacyWorkspace(home: string, token = legacyToken()): string {
  const legacyDir = path.join(home, `.${token}`);
  fs.mkdirSync(path.join(legacyDir, "gmail"), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, ".env"), "GEMINI_API_KEY=placeholder\n");
  fs.writeFileSync(path.join(legacyDir, `${token}.db`), "db");
  fs.writeFileSync(path.join(legacyDir, `${token}.db-wal`), "wal");
  fs.writeFileSync(path.join(legacyDir, `${token}.db-shm`), "shm");
  fs.writeFileSync(path.join(legacyDir, "gmail", "token.json"), "{}");
  return legacyDir;
}

describe("API runtime config workspace migration", () => {
  it.each([immediateLegacyToken(), legacyToken()])(
    "moves the default %s workspace before returning appDir/dbPath",
    (token) => {
      const { home, cleanup } = makeHome();
      try {
        const legacyDir = seedLegacyWorkspace(home, token);

        const config = resolveApiConfig({ HOME: home });
        const currentDir = path.join(home, ".jobctrl");

        expect(config.appDir).toBe(currentDir);
        expect(config.dbPath).toBe(path.join(currentDir, "jobctrl.db"));
        expect(fs.existsSync(legacyDir)).toBe(false);
        expect(fs.existsSync(path.join(currentDir, ".env"))).toBe(true);
        expect(fs.existsSync(path.join(currentDir, "gmail", "token.json"))).toBe(true);
        expect(fs.existsSync(path.join(currentDir, "jobctrl.db"))).toBe(true);
        expect(fs.existsSync(path.join(currentDir, "jobctrl.db-wal"))).toBe(true);
        expect(fs.existsSync(path.join(currentDir, "jobctrl.db-shm"))).toBe(true);
      } finally {
        cleanup();
      }
    },
  );

  it("does not move the default workspace when JOBCTRL_DIR is explicit", () => {
    const { home, cleanup } = makeHome();
    try {
      const legacyDir = seedLegacyWorkspace(home);
      const explicitDir = path.join(home, "custom");

      const config = resolveApiConfig({ HOME: home, JOBCTRL_DIR: explicitDir });

      expect(config.appDir).toBe(explicitDir);
      expect(fs.existsSync(legacyDir)).toBe(true);
      expect(fs.existsSync(path.join(home, ".jobctrl"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("refuses to overwrite an existing current workspace", () => {
    const { home, cleanup } = makeHome();
    try {
      seedLegacyWorkspace(home);
      const currentDir = path.join(home, ".jobctrl");
      fs.mkdirSync(currentDir);
      fs.writeFileSync(path.join(currentDir, "sentinel"), "keep");

      expect(() => resolveApiConfig({ HOME: home })).toThrow(/refusing to move legacy workspace/);
      expect(fs.readFileSync(path.join(currentDir, "sentinel"), "utf8")).toBe("keep");
    } finally {
      cleanup();
    }
  });

  it("refuses a legacy workspace that already contains new-named database files before moving it", () => {
    const { home, cleanup } = makeHome();
    try {
      const legacyDir = seedLegacyWorkspace(home, immediateLegacyToken());
      fs.writeFileSync(path.join(legacyDir, "jobctrl.db"), "new");

      expect(() => resolveApiConfig({ HOME: home })).toThrow(/refusing to overwrite existing database file/);
      expect(fs.existsSync(legacyDir)).toBe(true);
      expect(fs.existsSync(path.join(home, ".jobctrl"))).toBe(false);
      expect(fs.readFileSync(path.join(legacyDir, "jobctrl.db"), "utf8")).toBe("new");
    } finally {
      cleanup();
    }
  });
});
