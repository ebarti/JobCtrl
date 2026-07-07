import type { ArtifactDetail } from "@jobctl/contracts";
import { axe } from "jest-axe";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  makeArtifactDetail,
  makeArtifactTailoringExplanation,
  makeCoverageAudit,
  sampleAcceptedResumeArtifact,
  sampleDraftResumeArtifact,
} from "../../../test/fixtures/projections.js";
import { buildProviderHarness } from "../../../test/render.js";
import { ArtifactComparison } from "./ArtifactComparison.js";

function renderComparison(details: Record<string, ArtifactDetail>) {
  const ports = buildProviderHarness().ports;
  const harness = buildProviderHarness({
    ports: {
      ...ports,
      api: Object.assign(Object.create(Object.getPrototypeOf(ports.api)), ports.api, {
        artifact: vi.fn(async (artifactId: string) => details[artifactId]!),
      }),
    },
  });
  return render(
    <ArtifactComparison
      leftArtifactId={sampleAcceptedResumeArtifact.artifactId}
      rightArtifactId={sampleDraftResumeArtifact.artifactId}
    />,
    { wrapper: harness.Wrapper },
  );
}

describe("<ArtifactComparison> a11y", () => {
  it("has no critical/serious axe violations with recorded coverage", async () => {
    const view = renderComparison({
      [sampleAcceptedResumeArtifact.artifactId]: makeArtifactDetail(
        sampleAcceptedResumeArtifact,
        makeArtifactTailoringExplanation(makeCoverageAudit()),
      ),
      [sampleDraftResumeArtifact.artifactId]: makeArtifactDetail(
        sampleDraftResumeArtifact,
        makeArtifactTailoringExplanation(makeCoverageAudit()),
      ),
    });

    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("has no critical/serious axe violations when comparison coverage is absent", async () => {
    const view = renderComparison({
      [sampleAcceptedResumeArtifact.artifactId]: makeArtifactDetail(
        sampleAcceptedResumeArtifact,
        makeArtifactTailoringExplanation(makeCoverageAudit()),
      ),
      [sampleDraftResumeArtifact.artifactId]: makeArtifactDetail(
        sampleDraftResumeArtifact,
        makeArtifactTailoringExplanation(null),
      ),
    });

    expect(await axe(view.container)).toHaveNoViolations();
  });
});
