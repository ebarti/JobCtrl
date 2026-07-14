import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveApiConfig, resolveProductionApiConfig } from "../src/config.js";

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

function seedPayload(root: string): {
  payloadDir: string;
  pythonExecutable: string;
  webAssetsDir: string;
} {
  const payloadDir = path.join(root, "payload");
  const pythonExecutable = path.join(payloadDir, "python", "bin", "python3");
  const webAssetsDir = path.join(payloadDir, "web");
  fs.mkdirSync(path.dirname(pythonExecutable), { recursive: true });
  fs.mkdirSync(webAssetsDir, { recursive: true });
  fs.mkdirSync(path.join(payloadDir, "chromium"), { recursive: true });
  fs.writeFileSync(pythonExecutable, "#!/bin/sh\n");
  fs.chmodSync(pythonExecutable, 0o755);
  return { payloadDir, pythonExecutable, webAssetsDir };
}

describe("API runtime config workspace resolution", () => {
  it("requires real private runtime paths contained by the bundled payload", () => {
    const { home, cleanup } = makeHome();
    try {
      const payload = seedPayload(home);
      expect(() => resolveProductionApiConfig({ HOME: home })).toThrow(/JOBCTRL_PAYLOAD_DIR is required/);
      expect(() =>
        resolveProductionApiConfig({
          HOME: home,
          JOBCTRL_PAYLOAD_DIR: path.join(home, "missing"),
          JOBCTRL_WEB_ASSETS_DIR: payload.webAssetsDir,
          JOBCTRL_PYTHON_EXECUTABLE: payload.pythonExecutable,
        }),
      ).toThrow(/JOBCTRL_PAYLOAD_DIR must reference an existing directory/);
      expect(() =>
        resolveProductionApiConfig({
          HOME: home,
          JOBCTRL_PAYLOAD_DIR: payload.payloadDir,
          JOBCTRL_WEB_ASSETS_DIR: "relative/web",
          JOBCTRL_PYTHON_EXECUTABLE: payload.pythonExecutable,
        }),
      ).toThrow(/JOBCTRL_WEB_ASSETS_DIR must be an absolute path/);

      expect(
        resolveProductionApiConfig({
          HOME: home,
          JOBCTRL_PAYLOAD_DIR: payload.payloadDir,
          JOBCTRL_WEB_ASSETS_DIR: payload.webAssetsDir,
          JOBCTRL_PYTHON_EXECUTABLE: payload.pythonExecutable,
        }),
      ).toMatchObject({
        appDir: path.join(home, ".jobctrl"),
        payloadDir: fs.realpathSync(payload.payloadDir),
        pythonExecutable: fs.realpathSync(payload.pythonExecutable),
        webAssetsDir: fs.realpathSync(payload.webAssetsDir),
      });
    } finally {
      cleanup();
    }
  });

  it("rejects production runtime symlinks that escape the payload", () => {
    const { home, cleanup } = makeHome();
    try {
      const payload = seedPayload(home);
      const outsidePython = path.join(home, "outside-python");
      const outsideWeb = path.join(home, "outside-web");
      fs.writeFileSync(outsidePython, "#!/bin/sh\n");
      fs.chmodSync(outsidePython, 0o755);
      fs.mkdirSync(outsideWeb);
      const pythonEscape = path.join(payload.payloadDir, "python-escape");
      const webEscape = path.join(payload.payloadDir, "web-escape");
      fs.symlinkSync(outsidePython, pythonEscape);
      fs.symlinkSync(outsideWeb, webEscape);

      expect(() => resolveProductionApiConfig({
        HOME: home,
        JOBCTRL_PAYLOAD_DIR: payload.payloadDir,
        JOBCTRL_WEB_ASSETS_DIR: payload.webAssetsDir,
        JOBCTRL_PYTHON_EXECUTABLE: pythonEscape,
      })).toThrow(/JOBCTRL_PYTHON_EXECUTABLE must resolve inside JOBCTRL_PAYLOAD_DIR/);
      expect(() => resolveProductionApiConfig({
        HOME: home,
        JOBCTRL_PAYLOAD_DIR: payload.payloadDir,
        JOBCTRL_WEB_ASSETS_DIR: webEscape,
        JOBCTRL_PYTHON_EXECUTABLE: payload.pythonExecutable,
      })).toThrow(/JOBCTRL_WEB_ASSETS_DIR must resolve inside JOBCTRL_PAYLOAD_DIR/);

      fs.rmSync(path.join(payload.payloadDir, "chromium"), { recursive: true });
      fs.symlinkSync(outsideWeb, path.join(payload.payloadDir, "chromium"));
      expect(() => resolveProductionApiConfig({
        HOME: home,
        JOBCTRL_PAYLOAD_DIR: payload.payloadDir,
        JOBCTRL_WEB_ASSETS_DIR: payload.webAssetsDir,
        JOBCTRL_PYTHON_EXECUTABLE: payload.pythonExecutable,
      })).toThrow(/bundled Chromium directory must resolve inside JOBCTRL_PAYLOAD_DIR/);
    } finally {
      cleanup();
    }
  });

  it("requires an executable Python file and a web assets directory", () => {
    const { home, cleanup } = makeHome();
    try {
      const payload = seedPayload(home);
      const nonExecutable = path.join(payload.payloadDir, "python", "bin", "not-executable");
      const webFile = path.join(payload.payloadDir, "web-file");
      fs.writeFileSync(nonExecutable, "python");
      fs.chmodSync(nonExecutable, 0o644);
      fs.writeFileSync(webFile, "not a directory");

      expect(() => resolveProductionApiConfig({
        HOME: home,
        JOBCTRL_PAYLOAD_DIR: payload.payloadDir,
        JOBCTRL_WEB_ASSETS_DIR: payload.webAssetsDir,
        JOBCTRL_PYTHON_EXECUTABLE: nonExecutable,
      })).toThrow(/JOBCTRL_PYTHON_EXECUTABLE must reference an executable file/);
      expect(() => resolveProductionApiConfig({
        HOME: home,
        JOBCTRL_PAYLOAD_DIR: payload.payloadDir,
        JOBCTRL_WEB_ASSETS_DIR: webFile,
        JOBCTRL_PYTHON_EXECUTABLE: payload.pythonExecutable,
      })).toThrow(/JOBCTRL_WEB_ASSETS_DIR must reference an existing directory/);
    } finally {
      cleanup();
    }
  });

  it.each([immediateLegacyToken(), legacyToken()])(
    "ignores the legacy %s workspace when resolving appDir/dbPath",
    (token) => {
      const { home, cleanup } = makeHome();
      try {
        const legacyDir = seedLegacyWorkspace(home, token);

        const config = resolveApiConfig({ HOME: home });
        const currentDir = path.join(home, ".jobctrl");

        expect(config.appDir).toBe(currentDir);
        expect(config.dbPath).toBe(path.join(currentDir, "jobctrl.db"));
        expect(fs.existsSync(legacyDir)).toBe(true);
        expect(fs.existsSync(path.join(currentDir, ".env"))).toBe(false);
        expect(fs.existsSync(path.join(currentDir, "jobctrl.db"))).toBe(false);
      } finally {
        cleanup();
      }
    },
  );

  it("uses JOBCTRL_DIR without moving legacy workspaces", () => {
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

  it("expands home-relative workspace and config overrides", () => {
    const { home, cleanup } = makeHome();
    try {
      const config = resolveApiConfig({
        HOME: home,
        JOBCTRL_DIR: "~/custom-workspace",
        JOBCTRL_CONFIG_PATH: "~/config/config.json",
      });

      expect(config.appDir).toBe(path.join(home, "custom-workspace"));
      expect(config.configPath).toBe(path.join(home, "config", "config.json"));
    } finally {
      cleanup();
    }
  });

  it("uses an existing current workspace even when a legacy workspace also exists", () => {
    const { home, cleanup } = makeHome();
    try {
      const legacyDir = seedLegacyWorkspace(home);
      const currentDir = path.join(home, ".jobctrl");
      fs.mkdirSync(currentDir);
      fs.writeFileSync(path.join(currentDir, "sentinel"), "keep");

      const config = resolveApiConfig({ HOME: home });

      expect(config.appDir).toBe(currentDir);
      expect(fs.existsSync(legacyDir)).toBe(true);
      expect(fs.readFileSync(path.join(currentDir, "sentinel"), "utf8")).toBe("keep");
    } finally {
      cleanup();
    }
  });

  it("does not inspect or mutate legacy database files during config resolution", () => {
    const { home, cleanup } = makeHome();
    try {
      const legacyDir = seedLegacyWorkspace(home, immediateLegacyToken());
      fs.writeFileSync(path.join(legacyDir, "jobctrl.db"), "new");

      const config = resolveApiConfig({ HOME: home });

      expect(config.appDir).toBe(path.join(home, ".jobctrl"));
      expect(fs.existsSync(legacyDir)).toBe(true);
      expect(fs.existsSync(path.join(home, ".jobctrl"))).toBe(false);
      expect(fs.readFileSync(path.join(legacyDir, "jobctrl.db"), "utf8")).toBe("new");
    } finally {
      cleanup();
    }
  });
});
