import type { ArtifactDetail } from "@jobctrl/contracts";
import { render, screen } from "@testing-library/react";
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

function renderComparison(details: Record<string, ArtifactDetail>, rightRiskLabels: readonly string[] = []) {
  const ports = buildProviderHarness().ports;
  const artifact = vi.fn(async (artifactId: string) => {
    const detail = details[artifactId];
    if (!detail) {
      throw new Error(`missing test artifact ${artifactId}`);
    }
    return detail;
  });
  const harness = buildProviderHarness({
    ports: {
      ...ports,
      api: Object.assign(Object.create(Object.getPrototypeOf(ports.api)), ports.api, {
        artifact,
      }),
    },
  });

  render(
    <ArtifactComparison
      leftArtifactId={sampleAcceptedResumeArtifact.artifactId}
      leftLabel="Accepted"
      rightArtifactId={sampleDraftResumeArtifact.artifactId}
      rightLabel="Rendered draft"
      rightRiskLabels={rightRiskLabels}
    />,
    { wrapper: harness.Wrapper },
  );
  return { artifact };
}

describe("<ArtifactComparison>", () => {
  it("renders coverage deltas, template identity, risk labels, and verdict rows", async () => {
    renderComparison(
      {
        [sampleAcceptedResumeArtifact.artifactId]: makeArtifactDetail(
          sampleAcceptedResumeArtifact,
          makeArtifactTailoringExplanation(
            makeCoverageAudit({
              covered: ["platform reliability", "typescript"],
              declared: ["terraform", "gcp"],
              missing: ["incident response", "kubernetes"],
            }),
          ),
        ),
        [sampleDraftResumeArtifact.artifactId]: makeArtifactDetail(
          sampleDraftResumeArtifact,
          makeArtifactTailoringExplanation(
            makeCoverageAudit({
              covered: ["platform reliability", "incident response", "terraform"],
              declared: ["gcp", "kubernetes"],
              missing: ["typescript"],
            }),
            {
              judge: {
                passed: false,
                verdict: "REVIEW",
                score: 0.72,
                minScore: 0.82,
                issues: ["Check one claim."],
                unsupportedClaims: [],
                fabrications: [],
                missingRequiredEvidence: [],
                repairInstructions: [],
              },
            },
          ),
        ),
      },
      ["claim risk"],
    );

    expect(await screen.findByText("Classic")).toBeInTheDocument();
    expect(screen.getByText("Compact")).toBeInTheDocument();
    expect(screen.getByText("+covered")).toBeInTheDocument();
    expect(screen.getByText("incident response")).toBeInTheDocument();
    expect(screen.getByText("2/6 covered; 2 declared; 2 missing")).toBeInTheDocument();
    expect(screen.getByText("3/6 covered; 2 declared; 1 missing")).toBeInTheDocument();
    expect(screen.getByText("lost")).toBeInTheDocument();
    expect(screen.getByText("typescript")).toBeInTheDocument();
    expect(screen.getByText("+declared")).toBeInTheDocument();
    expect(screen.getByText("kubernetes")).toBeInTheDocument();
    expect(screen.getByText("declared lost")).toBeInTheDocument();
    expect(screen.getByText("declared")).toBeInTheDocument();
    expect(screen.getByText("gcp")).toBeInTheDocument();
    expect(screen.getByText("missing")).toBeInTheDocument();
    expect(screen.getByText("claim risk")).toBeInTheDocument();
    expect(screen.getByText("REVIEW; score 72% / minimum 82%; 1 issues")).toBeInTheDocument();
  });

  it("shows coverage not recorded instead of zero coverage", async () => {
    renderComparison({
      [sampleAcceptedResumeArtifact.artifactId]: makeArtifactDetail(
        sampleAcceptedResumeArtifact,
        makeArtifactTailoringExplanation(makeCoverageAudit()),
      ),
      [sampleDraftResumeArtifact.artifactId]: makeArtifactDetail(
        sampleDraftResumeArtifact,
        makeArtifactTailoringExplanation(null),
      ),
    });

    expect(
      await screen.findByText("coverage not recorded for the comparison artifact"),
    ).toBeInTheDocument();
    expect(screen.getByText("coverage not recorded")).toBeInTheDocument();
    expect(screen.queryByText("0/3 covered; 3 missing")).not.toBeInTheDocument();
  });

  it("does not request a right artifact before one is selected", async () => {
    const ports = buildProviderHarness().ports;
    const artifact = vi.fn(async () =>
      makeArtifactDetail(sampleAcceptedResumeArtifact, makeArtifactTailoringExplanation()),
    );
    const harness = buildProviderHarness({
      ports: {
        ...ports,
        api: Object.assign(Object.create(Object.getPrototypeOf(ports.api)), ports.api, {
          artifact,
        }),
      },
    });

    render(
      <ArtifactComparison
        leftArtifactId={sampleAcceptedResumeArtifact.artifactId}
        rightArtifactId={null}
      />,
      { wrapper: harness.Wrapper },
    );

    expect(await screen.findByText("Select a second artifact to compare coverage and review rows.")).toBeInTheDocument();
    expect(artifact).not.toHaveBeenCalledWith("");
  });
});
