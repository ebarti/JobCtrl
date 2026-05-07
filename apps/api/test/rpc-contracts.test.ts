/**
 * RPC contract schema coverage — keeps the TS contract package in sync with
 * the Python worker handler set.  Each new RPC method gets a parse + reject
 * pair here so type drift between TS and Python surfaces in CI.
 */
import { describe, expect, it } from "vitest";

import {
  CancelRunParamsSchema,
  CancelRunResultSchema,
  RpcMethods,
} from "../src/contracts.js";

describe("cancel_run RPC contract", () => {
  it("registers cancel_run in RpcMethods", () => {
    expect(RpcMethods.CancelRun).toBe("cancel_run");
  });

  it("parses a known-good request payload", () => {
    const parsed = CancelRunParamsSchema.parse({
      tenantId: "local",
      runId: "wf-123",
    });
    expect(parsed).toEqual({ tenantId: "local", runId: "wf-123" });
  });

  it("defaults tenantId to 'local' when omitted", () => {
    const parsed = CancelRunParamsSchema.parse({ runId: "wf-123" });
    expect(parsed.tenantId).toBe("local");
  });

  it("rejects a request missing runId", () => {
    expect(() => CancelRunParamsSchema.parse({ tenantId: "local" })).toThrow();
  });

  it("rejects an empty runId", () => {
    expect(() =>
      CancelRunParamsSchema.parse({ tenantId: "local", runId: "" }),
    ).toThrow();
  });

  it("parses a known-good response payload", () => {
    const parsed = CancelRunResultSchema.parse({
      runId: "wf-123",
      status: "canceling",
    });
    expect(parsed).toEqual({ runId: "wf-123", status: "canceling" });
  });

  it("rejects responses with the wrong status literal", () => {
    expect(() =>
      CancelRunResultSchema.parse({ runId: "wf-123", status: "canceled" }),
    ).toThrow();
  });
});
