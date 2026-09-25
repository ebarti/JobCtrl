/** Cross-language JSON-RPC guard over the live-Python-verified observation snapshot. */
import { describe, expect, it } from "vitest";
import boundaryFixture from "../../../workers/automation/tests/fixtures/rpc_boundary.json" with {
  type: "json",
};
import pythonObservation from "../../../workers/automation/tests/fixtures/rpc_boundary_python.json" with {
  type: "json",
};

import {
  ApplyResultSchema,
  ENDPOINTS,
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
  responseCount?: number;
  responseCode: number | null;
  resultSchema: "providerModels" | "workflowAck" | null;
  tsResponse: boolean | null;
  tsRunStageParams?: boolean;
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
const probe = pythonObservation as Probe;

describe("TypeScript/Python JSON-RPC boundary", () => {
  it("matches the live Python registration inventory to RpcMethods", () => {
    const expected = Object.values(RpcMethods).sort();
    const actual = probe.inventory.map(({ method }) => method).sort();
    expect(actual).toEqual(expected);
    expect(probe.inventory.find(({ method }) => method === RpcMethods.ProviderModels)?.mode).toBe("sync");
    expect(probe.inventory.find(({ method }) => method === RpcMethods.RunStage)?.mode).toBe("workflow");

    // The endpoint spec remains the source for route-to-worker dispatch.
    const endpointReferences = Object.values(ENDPOINTS).flatMap((endpoint) => {
      const spec = endpoint as {
        dispatch?: { rpcMethod: string };
        rpcDependencies?: readonly string[];
      };
      return [
        ...(spec.dispatch ? [spec.dispatch.rpcMethod] : []),
        ...(spec.rpcDependencies ?? []),
      ];
    });
    expect(endpointReferences.length).toBeGreaterThan(0);
    expect(actual).toEqual(expect.arrayContaining(endpointReferences));

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
    expect(observation?.responses).toHaveLength(boundaryCase.responseCount ?? 1);
    if (boundaryCase.responseCount === 0) {
      expect(boundaryCase.tsResponse).toBeNull();
      return;
    }
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
    if (boundaryCase.tsRunStageParams !== undefined) {
      expect(RunStageParamsSchema.safeParse(boundaryCase.request?.params).success).toBe(
        boundaryCase.tsRunStageParams,
      );
    }
    if (["run_stage_source_ids", "run_stage_recovery_reason", "run_stage_profile_continuation"]
      .includes(boundaryCase.name)) {
      const knownParams = { ...(boundaryCase.request?.params as Record<string, unknown>) };
      delete knownParams.sourceIds;
      delete knownParams.reason;
      delete knownParams.awaitResult;
      expect(RunStageParamsSchema.safeParse(knownParams).success).toBe(true);
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
