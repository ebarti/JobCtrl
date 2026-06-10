import { describe, expect, it } from "vitest";

import { activityLevelTone } from "./activity-tone.js";

describe("activityLevelTone", () => {
  it("maps activity levels into the shared tag tone vocabulary", () => {
    expect(activityLevelTone("error")).toBe("danger");
    expect(activityLevelTone("warning")).toBe("warn");
    expect(activityLevelTone("warn")).toBe("warn");
    expect(activityLevelTone("info")).toBe("info");
    expect(activityLevelTone("debug")).toBe("muted");
  });
});

