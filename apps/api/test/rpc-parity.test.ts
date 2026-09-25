/** Cross-language JSON-RPC guard using the actual Python parser and server. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import boundaryFixture from "../../../workers/automation/tests/fixtures/rpc_boundary.json" with {
  type: "json",
};

import {
  ApplyResultSchema,
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
  ProviderModelCatalogResultSchema,
  RpcMethods,
  RunStageParamsSchema,
} from "../src/contracts.js";

type BoundaryCase = {
  name: string;
  request?: Record<string, unknown>;
  raw?: string;
  tsRequest: boolean;
  pythonParsed: boolean;
  responseCode: number | null;
  resultSchema: "providerModels" | "workflowAck" | null;
  tsResponse: boolean;
};
type Observation = {
  pythonParsed: boolean;
  normalizedParams: unknown;
  responses: Record<string, unknown>[];
};
type Probe = {
  inventory: { method: string; mode: string }[];
  observations: Record<string, Observation>;
};

const fixture = boundaryFixture as unknown as { cases: BoundaryCase[] };
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const probePath = fileURLToPath(
  new URL("../../../workers/automation/tests/rpc_contract_probe.py", import.meta.url),
);

function runPythonProbe(): Probe {
  const python = process.env.JOBCTRL_RPC_PROBE_PYTHON;
  const child = spawnSync(
    python ?? "uv",
    python
      ? [probePath]
      : [
          "run", "--project", "workers/automation", "--locked", "--all-extras",
          "--exclude-newer", "false", "python", probePath,
        ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        UV_PROJECT_ENVIRONMENT: undefined,
        VIRTUAL_ENV: undefined,
        UV_EXCLUDE_NEWER: undefined,
        UV_EXCLUDE_NEWER_PACKAGE: undefined,
      },
    },
  );
  if (child.status !== 0) {
    throw new Error(`Python RPC probe failed (${child.status}): ${child.stderr || child.error}`);
  }
  return JSON.parse(child.stdout) as Probe;
}

describe("TypeScript/Python JSON-RPC boundary", () => {
  const probe = runPythonProbe();

  it("matches the live Python registration inventory to RpcMethods", () => {
    const expected = Object.values(RpcMethods).sort();
    const actual = probe.inventory.map(({ method }) => method).sort();
    expect(actual).toEqual(expected);
    expect(probe.inventory.find(({ method }) => method === RpcMethods.ProviderModels)?.mode).toBe("sync");
    expect(probe.inventory.find(({ method }) => method === RpcMethods.RunStage)?.mode).toBe("workflow");

    // An omitted live registration must break the same full-set assertion.
    expect(actual.filter((method) => method !== RpcMethods.RunStage)).not.toEqual(expected);
  });

  it.each(fixture.cases)("executes $name through both actual contracts", (boundaryCase) => {
    const observation = probe.observations[boundaryCase.name];
    expect(observation).toBeDefined();
    const tsRequest = boundaryCase.raw
      ? false
      : JsonRpcRequestSchema.safeParse(boundaryCase.request).success;
    expect(tsRequest).toBe(boundaryCase.tsRequest);
    expect(observation?.pythonParsed).toBe(boundaryCase.pythonParsed);
    expect(observation?.responses).toHaveLength(1);
    const response = observation?.responses[0];
    expect(JsonRpcResponseSchema.safeParse(response).success).toBe(boundaryCase.tsResponse);
    if (boundaryCase.responseCode === null) {
      expect(response?.error).toBeUndefined();
      const schema = boundaryCase.resultSchema === "workflowAck"
        ? ApplyResultSchema
        : ProviderModelCatalogResultSchema;
      expect(schema.safeParse(response?.result).success).toBe(true);
    } else {
      expect((response?.error as { code: number }).code).toBe(boundaryCase.responseCode);
    }
    if (boundaryCase.name === "run_stage_success") {
      expect(RunStageParamsSchema.safeParse(boundaryCase.request?.params).success).toBe(true);
    }
    if (boundaryCase.name === "run_stage_invalid_stage") {
      expect(RunStageParamsSchema.safeParse(boundaryCase.request?.params).success).toBe(false);
    }
  });

  it("rejects a mutated workflow acknowledgment and result catalog", () => {
    const ack = probe.observations.run_stage_success?.responses[0]?.result;
    expect(ApplyResultSchema.safeParse({ ...(ack as object), runId: 7 }).success).toBe(false);
    const catalog = probe.observations.provider_models_success?.responses[0]?.result;
    expect(ProviderModelCatalogResultSchema.safeParse({
      ...(catalog as object),
      providers: [{ provider: "codex", configured: false, ready: false, source: "live", models: [] }],
    }).success).toBe(false);
  });
});
