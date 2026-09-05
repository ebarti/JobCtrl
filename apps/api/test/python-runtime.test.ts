import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createBundledPythonRuntime,
  createSourcePythonRuntime,
} from "../src/python-runtime.js";

describe("Python runtime command resolution", () => {
  it("preserves uv project commands for source development", () => {
    const runtime = createSourcePythonRuntime({
      projectDir: "/repo/workers/automation",
      uvBinary: "uv-test",
      environment: { PATH: "/source/tools" },
    });

    expect(
      runtime.resolve({ kind: "cli", args: ["rpc"] }, { appDir: "/tmp/jobctrl" }),
    ).toEqual({
      executable: "uv-test",
      argv: ["--project", "/repo/workers/automation", "run", "jobctrl", "rpc"],
      cwd: "/tmp/jobctrl",
      env: { PATH: "/source/tools", JOBCTRL_DIR: "/tmp/jobctrl", JOBCTRL_RUNTIME_MODE: "source" },
    });
    expect(
      runtime.resolve(
        { kind: "module", module: "jobctrl.discovery.manual_capture_import", args: ["--db-path", "/tmp/jobctrl.db"] },
        { appDir: "/tmp/jobctrl" },
      ).argv,
    ).toEqual([
      "--project",
      "/repo/workers/automation",
      "run",
      "python",
      "-m",
      "jobctrl.discovery.manual_capture_import",
      "--db-path",
      "/tmp/jobctrl.db",
    ]);
  });

  it("uses only an absolute embedded Python executable in bundled mode", () => {
    const runtime = createBundledPythonRuntime({
      executable: "/runtime/python/bin/python3",
      environment: {
        PATH: "/usr/bin:/bin",
        PLAYWRIGHT_BROWSERS_PATH: "/user/playwright-cache",
        PYTHONHOME: "/user/python",
        PYTHONNOUSERSITE: "0",
        PYTHONPATH: "/user/modules",
        PYTHONSAFEPATH: "0",
        PYTHONUSERBASE: "/user/site",
        VIRTUAL_ENV: "/user/venv",
      },
      payloadDir: "/runtime",
    });

    expect(
      runtime.resolve({ kind: "cli", args: ["rpc"] }, { appDir: "/Users/example/.jobctrl" }),
    ).toEqual({
      executable: "/runtime/python/bin/python3",
      argv: ["-I", "-B", "-m", "jobctrl", "rpc"],
      cwd: "/Users/example/.jobctrl",
      env: {
        PATH: "/usr/bin:/bin",
        PLAYWRIGHT_BROWSERS_PATH: "/runtime/chromium",
        JOBCTRL_DIR: "/Users/example/.jobctrl",
        JOBCTRL_PAYLOAD_DIR: "/runtime",
        JOBCTRL_RUNTIME_MODE: "bundled",
        PYTHONNOUSERSITE: "1",
        PYTHONSAFEPATH: "1",
      },
    });
    expect(
      runtime.resolve(
        { kind: "script", script: "print('ok')", args: ["one"] },
        { appDir: "/Users/example/.jobctrl" },
    ).argv,
    ).toEqual(["-I", "-B", "-c", "print('ok')", "one"]);
  });

  it("executes an extracted payload through isolated Python and its fixed relative .pth", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-bundled-python-"));
    try {
      const payloadDir = path.join(tempDir, "payload");
      const pythonRoot = path.join(payloadDir, "python");
      const appDir = path.join(tempDir, "state");
      const workerSite = path.join(payloadDir, "worker", "site-packages");
      const playwrightSite = path.join(payloadDir, "playwright-python", "site-packages");
      const ambientSite = path.join(tempDir, "ambient-site");
      fs.mkdirSync(appDir, { recursive: true });
      fs.mkdirSync(path.join(payloadDir, "chromium"), { recursive: true });
      fs.mkdirSync(path.join(workerSite, "jobctrl"), { recursive: true });
      fs.mkdirSync(playwrightSite, { recursive: true });
      fs.mkdirSync(ambientSite, { recursive: true });

      const setupHome = path.join(tempDir, "setup-home");
      fs.mkdirSync(setupHome);
      const setupEnv = {
        PATH: process.env.PATH, HOME: setupHome, TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir,
        LANG: "C.UTF-8", PYTHON_DOTENV_DISABLED: "1",
      };
      const sourcePython = execFileSync("python3", ["-I", "-B", "-c", "import sys; print(sys.executable)"], {
        encoding: "utf8", cwd: tempDir, env: setupEnv,
      }).trim();
      execFileSync(sourcePython, ["-I", "-B", "-m", "venv", "--without-pip", pythonRoot], {
        cwd: tempDir, env: setupEnv,
      });
      const bundledPython = path.join(pythonRoot, "bin", "python3");
      const systemSite = execFileSync(
        bundledPython,
        ["-I", "-B", "-c", "import site; print(site.getsitepackages()[0])"],
        { encoding: "utf8", cwd: tempDir, env: setupEnv },
      ).trim();
      const relativeSite = path.relative(fs.realpathSync(pythonRoot), fs.realpathSync(systemSite));
      if (!relativeSite || relativeSite.startsWith("..") || path.isAbsolute(relativeSite)) {
        throw new Error("Fixture site-packages escaped its owned venv");
      }
      fs.writeFileSync(
        path.join(systemSite, "jobctrl-payload.pth"),
        "../../../../worker/site-packages\n../../../../playwright-python/site-packages\n",
      );
      fs.writeFileSync(path.join(workerSite, "core_marker.py"), "VALUE = 'worker'\n");
      fs.writeFileSync(path.join(playwrightSite, "playwright_marker.py"), "VALUE = 'playwright'\n");
      fs.writeFileSync(path.join(ambientSite, "core_marker.py"), "VALUE = 'ambient-poison'\n");
      fs.writeFileSync(path.join(workerSite, "jobctrl", "__init__.py"), "");
      fs.writeFileSync(
        path.join(workerSite, "jobctrl", "__main__.py"),
        [
          "import json, os, sys",
          "from core_marker import VALUE as core",
          "from playwright_marker import VALUE as playwright",
          "print(json.dumps({",
          "  'argv': sys.argv[1:],",
          "  'browser_path': os.environ['PLAYWRIGHT_BROWSERS_PATH'],",
          "  'core': core,",
          "  'isolated': sys.flags.isolated,",
          "  'playwright': playwright,",
          "  'worker_on_path': os.path.realpath(os.environ['JOBCTRL_PAYLOAD_DIR'] + '/worker/site-packages') in [os.path.realpath(item) for item in sys.path],",
          "  'playwright_on_path': os.path.realpath(os.environ['JOBCTRL_PAYLOAD_DIR'] + '/playwright-python/site-packages') in [os.path.realpath(item) for item in sys.path],",
          "}))",
          "",
        ].join("\n"),
      );

      const runtime = createBundledPythonRuntime({
        executable: bundledPython,
        payloadDir,
        environment: {
          PATH: process.env.PATH,
          PLAYWRIGHT_BROWSERS_PATH: path.join(tempDir, "ambient-browser-cache"),
          PYTHONHOME: path.join(tempDir, "ambient-python-home"),
          PYTHONPATH: ambientSite,
          PYTHONUSERBASE: path.join(tempDir, "ambient-user-site"),
          VIRTUAL_ENV: path.join(tempDir, "ambient-venv"),
        },
      });
      const command = runtime.resolve(
        { kind: "cli", args: ["doctor", "--synthetic"] },
        { appDir },
      );
      const result = JSON.parse(execFileSync(command.executable, [...command.argv], {
        cwd: command.cwd,
        encoding: "utf8",
        env: command.env,
      }));

      expect(result).toEqual({
        argv: ["doctor", "--synthetic"],
        browser_path: path.join(payloadDir, "chromium"),
        core: "worker",
        isolated: 1,
        playwright: "playwright",
        worker_on_path: true,
        playwright_on_path: true,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("leaves ambient Python environment and contributor argv unchanged in source mode", () => {
    const runtime = createSourcePythonRuntime({
      projectDir: "/repo/workers/automation",
      environment: {
        PYTHONHOME: "/source/python",
        PYTHONPATH: "/source/modules",
        VIRTUAL_ENV: "/source/venv",
      },
    });

    expect(runtime.resolve(
      { kind: "script", script: "print('source')", args: [] },
      { appDir: "/tmp/jobctrl" },
    )).toMatchObject({
      argv: ["--project", "/repo/workers/automation", "run", "python", "-c", "print('source')"],
      env: {
        JOBCTRL_DIR: "/tmp/jobctrl",
        JOBCTRL_RUNTIME_MODE: "source",
        PYTHONHOME: "/source/python",
        PYTHONPATH: "/source/modules",
        VIRTUAL_ENV: "/source/venv",
      },
    });
  });

  it("fails closed for relative bundled executables and working directories", () => {
    expect(() => createBundledPythonRuntime({ executable: "python3", payloadDir: "/runtime" })).toThrow(/absolute path/);
    expect(() => createBundledPythonRuntime({ executable: "/runtime/python/bin/python3", payloadDir: "runtime" })).toThrow(/payload directory must be an absolute path/);
    const runtime = createBundledPythonRuntime({ executable: "/runtime/python/bin/python3", payloadDir: "/runtime" });
    expect(() =>
      runtime.resolve({ kind: "cli", args: ["rpc"] }, { appDir: "relative-state" }),
    ).toThrow(/working directory must be an absolute path/);
  });
});
