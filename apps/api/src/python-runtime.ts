import path from "node:path";
import { fileURLToPath } from "node:url";

const API_SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const AUTOMATION_PROJECT_DIR = path.resolve(API_SRC_DIR, "../../../workers/automation");

export type PythonInvocation =
  | { readonly kind: "cli"; readonly args: readonly string[] }
  | { readonly kind: "module"; readonly module: string; readonly args: readonly string[] }
  | { readonly kind: "script"; readonly script: string; readonly args: readonly string[] };

export interface PythonRuntimeContext {
  readonly appDir: string;
}

export interface ResolvedPythonCommand {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface PythonRuntimeCommandResolver {
  /** Stable identity used to isolate long-lived JSON-RPC subprocesses. */
  readonly id: string;
  resolve(invocation: PythonInvocation, context: PythonRuntimeContext): ResolvedPythonCommand;
}

export interface SourcePythonRuntimeOptions {
  readonly projectDir?: string;
  readonly uvBinary?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface BundledPythonRuntimeOptions {
  readonly executable: string;
  readonly payloadDir: string;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Resolve commands for a source checkout. This preserves the contributor-facing
 * `uv --project ... run` behavior while keeping it behind the same process seam
 * used by the bundled runtime.
 */
export function createSourcePythonRuntime(
  options: SourcePythonRuntimeOptions = {},
): PythonRuntimeCommandResolver {
  const projectDir = path.resolve(options.projectDir ?? AUTOMATION_PROJECT_DIR);
  const executable = options.uvBinary ?? "uv";
  const environment = options.environment ?? process.env;
  return {
    id: `source:${executable}:${projectDir}`,
    resolve(invocation, context) {
      const invocationArgv = pythonInvocationArgv(invocation, false);
      return {
        executable,
        argv: ["--project", projectDir, "run", ...invocationArgv],
        cwd: context.appDir,
        env: runtimeEnvironment(environment, context.appDir, {
          JOBCTRL_RUNTIME_MODE: "source",
        }),
      };
    },
  };
}

/**
 * Resolve commands against JobCtrl's private Python runtime. The executable is
 * deliberately required to be absolute: bundled mode must never fall back to a
 * user-installed Python, uv, or a PATH lookup.
 */
export function createBundledPythonRuntime(
  options: BundledPythonRuntimeOptions,
): PythonRuntimeCommandResolver {
  if (!path.isAbsolute(options.executable)) {
    throw new Error("Bundled Python executable must be an absolute path.");
  }
  if (!path.isAbsolute(options.payloadDir)) {
    throw new Error("Bundled payload directory must be an absolute path.");
  }
  const executable = path.normalize(options.executable);
  const payloadDir = path.normalize(options.payloadDir);
  const environment = options.environment ?? process.env;
  return {
    id: `bundled:${executable}:${payloadDir}`,
    resolve(invocation, context) {
      if (!path.isAbsolute(context.appDir)) {
        throw new Error("Bundled Python working directory must be an absolute path.");
      }
      return {
        executable,
        argv: pythonInvocationArgv(invocation, true),
        cwd: context.appDir,
        env: bundledRuntimeEnvironment(environment, context.appDir, {
          JOBCTRL_PAYLOAD_DIR: payloadDir,
          JOBCTRL_RUNTIME_MODE: "bundled",
          PLAYWRIGHT_BROWSERS_PATH: path.join(payloadDir, "chromium"),
        }),
      };
    },
  };
}

export const defaultSourcePythonRuntime = createSourcePythonRuntime();

function pythonInvocationArgv(invocation: PythonInvocation, bundled: boolean): string[] {
  switch (invocation.kind) {
    case "cli":
      return bundled
        ? ["-I", "-B", "-m", "jobctrl", ...invocation.args]
        : ["jobctrl", ...invocation.args];
    case "module":
      return bundled
        ? ["-I", "-B", "-m", invocation.module, ...invocation.args]
        : ["python", "-m", invocation.module, ...invocation.args];
    case "script":
      return bundled
        ? ["-I", "-B", "-c", invocation.script, ...invocation.args]
        : ["python", "-c", invocation.script, ...invocation.args];
  }
}

const AMBIENT_PYTHON_ENVIRONMENT_KEYS = [
  "PYTHONHOME",
  "PYTHONNOUSERSITE",
  "PYTHONPATH",
  "PYTHONSAFEPATH",
  "PYTHONUSERBASE",
  "VIRTUAL_ENV",
] as const;

function bundledRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  appDir: string,
  overrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitizedEnvironment = { ...environment };
  for (const key of AMBIENT_PYTHON_ENVIRONMENT_KEYS) {
    delete sanitizedEnvironment[key];
  }
  return runtimeEnvironment(sanitizedEnvironment, appDir, {
    ...overrides,
    PYTHONNOUSERSITE: "1",
    PYTHONSAFEPATH: "1",
  });
}

function runtimeEnvironment(
  environment: NodeJS.ProcessEnv,
  appDir: string,
  overrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    JOBCTRL_DIR: appDir,
    ...overrides,
  };
}
