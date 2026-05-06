import { describe, expect, it } from "vitest";

import { sampleJob, sampleSecondaryJob, sampleArtifact } from "../../../test/fixtures/projections.js";
import type { ArtifactSummary } from "../../../contexts/operations/types.js";
import { groupArtifactsByJob, summarizeFunnel } from "./jobsSelectors.js";

describe("summarizeFunnel", () => {
  it("returns one entry per stage with the correct count", () => {
    const result = summarizeFunnel([sampleJob, sampleSecondaryJob, sampleJob]);
    expect(result).toHaveLength(2);
    expect(result.find((entry) => entry.stage === "tailor")?.count).toBe(2);
    expect(result.find((entry) => entry.stage === "apply")?.count).toBe(1);
  });

  it("returns an empty array on an empty input", () => {
    expect(summarizeFunnel([])).toEqual([]);
  });
});

describe("groupArtifactsByJob", () => {
  it("groups artifacts by jobKey", () => {
    const second: ArtifactSummary = { ...sampleArtifact, artifactId: "artifact-2", jobKey: "job-2" };
    const third: ArtifactSummary = { ...sampleArtifact, artifactId: "artifact-3", jobKey: "job-1" };
    const grouped = groupArtifactsByJob([sampleArtifact, second, third]);
    expect(grouped.get("job-1")).toHaveLength(2);
    expect(grouped.get("job-2")).toHaveLength(1);
  });

  it("skips artifacts with falsy jobKey", () => {
    const orphan: ArtifactSummary = { ...sampleArtifact, jobKey: "" };
    const grouped = groupArtifactsByJob([orphan]);
    expect(grouped.size).toBe(0);
  });
});
