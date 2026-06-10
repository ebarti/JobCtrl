import { describe, expect, it } from "vitest";

import { artifactStatusTone } from "./artifact-status-tone.js";

describe("artifactStatusTone", () => {
  it("keeps artifact lifecycle statuses visually distinct", () => {
    expect(artifactStatusTone("active")).toBe("ok");
    expect(artifactStatusTone("approved")).toBe("ok");
    expect(artifactStatusTone("missing")).toBe("warn");
    expect(artifactStatusTone("stale")).toBe("warn");
    expect(artifactStatusTone("rejected")).toBe("danger");
    expect(artifactStatusTone("suppressed")).toBe("muted");
    expect(artifactStatusTone("candidate")).toBe("muted");
  });
});

