import { describe, expect, it } from "vitest";

import { DemoFeatureFlagAdapter } from "../../demo/ports.js";
import type { FeatureFlagPort } from "../ports/FeatureFlagPort.js";
import { getApiCapabilityAvailability } from "./apiCapabilityAvailability.js";

const localFlags: FeatureFlagPort = {
  get: (_key, defaultValue) => defaultValue,
};

describe("getApiCapabilityAvailability", () => {
  it("keeps local operations available without requiring per-operation flags", () => {
    expect(
      getApiCapabilityAvailability(localFlags, "runPipelineStages"),
    ).toEqual({ available: true, isDemo: false, reason: null });
  });

  it("resolves unavailable demo operations from the capability manifest", () => {
    expect(
      getApiCapabilityAvailability(
        new DemoFeatureFlagAdapter(),
        "runPipelineStages",
      ),
    ).toEqual({
      available: false,
      isDemo: true,
      reason:
        "Multi-stage pipeline runs are deferred from the public-demo MVP.",
    });
  });

  it("keeps supported browser-local demo operations available", () => {
    expect(
      getApiCapabilityAvailability(new DemoFeatureFlagAdapter(), "deleteJobs"),
    ).toMatchObject({ available: true, isDemo: true });
  });
});
