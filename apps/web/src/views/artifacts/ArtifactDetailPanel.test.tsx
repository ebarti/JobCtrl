import type { ArtifactTailoringExplanation } from "@jobhunter/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { artifactsSearchSchema } from "../../routes/-artifacts.search.js";
import { buildProviderHarness } from "../../test/render.js";
import { sampleArtifact } from "../../test/fixtures/projections.js";
import { ArtifactDetailPanel } from "./ArtifactDetailPanel.js";

vi.mock("../../shared/ui/PdfPreviewViewer.js", () => ({
  PdfPreviewViewer: ({ title, url }: { title: string; url: string }) => (
    <div>
      <span>{title}</span>
      <span>{url}</span>
    </div>
  ),
}));

function renderArtifactRoute(
  children: ReactNode,
  status = "approved",
  tailoringExplanation: ArtifactTailoringExplanation | null = null,
) {
  const artifact = {
    ...sampleArtifact,
    artifactId: "artifact-preview",
    type: "resume_pdf",
    status,
    localPath: "/tmp/artifact-preview.pdf",
    sizeBytes: 1234,
  };
  const ports = buildProviderHarness().ports;
  const artifactPreviewPdfUrl = vi.fn(() => "/v1/artifacts/artifact-preview/preview.pdf?v=test");
  const harness = buildProviderHarness({
    ports: {
      ...ports,
      api: Object.assign(Object.create(Object.getPrototypeOf(ports.api)), ports.api, {
        artifact: vi.fn(async () => ({ ok: true as const, artifact, tailoringExplanation })),
        artifactPreviewPdfUrl,
      }),
    },
  });

  const root = createRootRoute({ component: () => <Outlet /> });
  const artifacts = createRoute({
    getParentRoute: () => root,
    path: "/artifacts",
    validateSearch: (search) => artifactsSearchSchema.parse(search),
    component: () => <Outlet />,
  });
  const artifactDetail = createRoute({
    getParentRoute: () => artifacts,
    path: "$artifactId",
    component: () => <>{children}</>,
  });
  const router = createRouter({
    routeTree: root.addChildren([artifacts.addChildren([artifactDetail])]),
    history: createMemoryHistory({ initialEntries: ["/artifacts/artifact-preview"] }),
  });

  render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });
  return { artifactPreviewPdfUrl };
}

describe("<ArtifactDetailPanel>", () => {
  it("explains approved status and renders PDF artifacts in the detail drawer", async () => {
    const { artifactPreviewPdfUrl } = renderArtifactRoute(
      <ArtifactDetailPanel artifactId="artifact-preview" />,
    );

    expect(
      await screen.findByText(
        "Approved means this generated material passed validation and is the accepted version for this job.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Artifact PDF preview")).toHaveTextContent("Artifact preview");
    expect(screen.getByLabelText("Artifact PDF preview")).toHaveTextContent(
      "/v1/artifacts/artifact-preview/preview.pdf?v=test",
    );
    expect(artifactPreviewPdfUrl).toHaveBeenCalledWith(
      "artifact-preview",
      expect.stringContaining("1234"),
    );
  });

  it("marks suppressed artifacts as historical audit material", async () => {
    renderArtifactRoute(<ArtifactDetailPanel artifactId="artifact-preview" />, "suppressed");

    expect(
      await screen.findByText(
        "This artifact is historical audit material and is not active apply-ready material.",
      ),
    ).toBeInTheDocument();
  });

  it("renders tailoring rationale from artifact detail evidence", async () => {
    renderArtifactRoute(<ArtifactDetailPanel artifactId="artifact-preview" />, "approved", {
      targetSeniority: "senior",
      claimMode: "evidence_reframing",
      validationMode: "normal",
      safety: {
        autoApprovableClaimModes: ["verified_only"],
        allowAdjacentAchievementDrafts: false,
        qualityPassed: true,
      },
      keywords: {
        planned: ["platform reliability", "typescript"],
        covered: ["platform reliability"],
        missing: ["typescript"],
        filtered: {
          planned: [],
          covered: [],
          missing: [],
        },
        counts: {
          planned: 2,
          covered: 1,
          missing: 1,
          displayedPlanned: 2,
          displayedCovered: 1,
          displayedMissing: 1,
          filteredPlanned: 0,
          filteredCovered: 0,
          filteredMissing: 0,
        },
      },
      evidence: {
        requiredIds: ["ev_latency"],
        seniorityIds: ["ev_scope"],
        representedIds: ["ev_latency"],
        missingIds: [],
        verifiedMetricCount: 2,
      },
      quality: {
        passed: true,
        errors: [],
        warnings: [],
        notes: ["Keyword coverage: 1/2"],
        metricClaims: ["35%"],
        repeatedKeywords: [],
      },
      judge: {
        passed: true,
        verdict: "PASS",
        score: 0.91,
        minScore: 0.82,
        issues: [],
        unsupportedClaims: [],
        fabrications: [],
        missingRequiredEvidence: [],
        repairInstructions: [],
      },
      adversarialReview: {
        ran: true,
        passed: true,
        score: 0.88,
        scoreRationale: "All personas passed with residual warnings only.",
        threshold: 0.8,
        blockers: [],
        warnings: ["Bullet could be more concise."],
        repairInstructions: [],
        personas: [
          {
            persona: "evidence_auditor",
            verdict: "PASS",
            score: 0.9,
            scoreRationale: "Evidence was supported by profile facts.",
            promptRubric: "Check that every metric, tool, role, company, and achievement is supported.",
            blockers: [],
            warnings: [],
            repairInstructions: [],
            scoreBasis: ["LLM verdict: PASS", "LLM score: 0.90", "Blockers: none"],
            response: {
              verdict: "PASS",
              score: 0.9,
              scoreRationale: "Evidence was supported by profile facts.",
              blockers: [],
              warnings: [],
              repairInstructions: [],
            },
          },
        ],
        audit: {
          model: "judge-a",
          schemaVersion: "tailor-adversarial.v2",
          promptMessages: [
            {
              role: "system",
              content: "Evaluate the tailored resume from every persona below.",
            },
            {
              role: "user",
              content: "Run the adversarial review and return JSON.",
            },
          ],
          response: {
            verdict: "PASS",
            score: 0.88,
            scoreRationale: "All personas passed with residual warnings only.",
            blockers: [],
            warnings: ["Bullet could be more concise."],
            repairInstructions: [],
            personas: [
              {
                verdict: "PASS",
                score: 0.9,
                scoreRationale: "Evidence was supported by profile facts.",
                blockers: [],
                warnings: [],
                repairInstructions: [],
              },
            ],
          },
        },
        skippedReason: null,
      },
      reviewFeedback: {
        warningRepairAttempted: true,
        acceptedWithResidualWarnings: true,
        acceptedWarnings: ["Bullet could be more concise."],
      },
      annotatedChanges: [
        {
          section: "executive_profile",
          label: "Executive profile",
          changeType: "summary_reframed",
          sourceId: "executive_profile",
          sourceText: ["Senior backend engineer."],
          tailoredText: ["Senior platform engineer focused on Kubernetes reliability."],
          rationale: "Summary was reframed toward platform reliability.",
          jobSignals: ["platform reliability", "kubernetes"],
          controls: ["target seniority: senior", "claim mode: evidence_reframing"],
          evidenceIds: ["ev_scope"],
          evidenceNotes: ["ev_scope: technical ownership"],
        },
      ],
      models: {
        candidateModels: ["generator-a"],
        selectedModel: "generator-a",
        selectedCandidate: "candidate-1",
        judgeModel: "judge-a",
        attempts: 2,
      },
    });

    expect(await screen.findByText("Tailoring rationale")).toBeInTheDocument();
    expect(screen.getByText("Senior")).toBeInTheDocument();
    expect(screen.getByText("Evidence Reframing")).toBeInTheDocument();
    expect(screen.getByText("1/2 found in resume")).toBeInTheDocument();
    expect(screen.getByText("2 total")).toBeInTheDocument();
    expect(screen.getByText("Target job keywords")).toBeInTheDocument();
    expect(screen.getByText("Found in tailored resume")).toBeInTheDocument();
    expect(screen.getByText("No recorded resume match")).toBeInTheDocument();
    expect(screen.queryByText("Not recorded as covered")).not.toBeInTheDocument();
    expect(screen.queryByText("Displayed target keywords")).not.toBeInTheDocument();
    expect(screen.queryByText("Filtered covered keywords")).not.toBeInTheDocument();
    expect(screen.queryByText("head")).not.toBeInTheDocument();
    expect(screen.getAllByText("platform reliability").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ev_latency")).toHaveLength(2);
    expect(screen.getAllByText("ev_scope").length).toBeGreaterThan(0);
    expect(screen.queryByText("Missing evidence")).not.toBeInTheDocument();
    expect(screen.queryByText("Metric claims")).not.toBeInTheDocument();
    expect(screen.queryByText("none recorded")).not.toBeInTheDocument();
    expect(screen.getByText("91% / minimum 82%")).toBeInTheDocument();
    expect(screen.getByText("Review outcome")).toBeInTheDocument();
    expect(screen.getByText("Accepted residual warnings")).toBeInTheDocument();
    expect(screen.getByText("Warning repair attempted")).toBeInTheDocument();
    expect(screen.getAllByText("Bullet could be more concise.").length).toBeGreaterThan(0);
    expect(screen.getByText("Annotated resume changes")).toBeInTheDocument();
    expect(screen.getByText("Summary was reframed toward platform reliability.")).toBeInTheDocument();
    expect(screen.getByText("Senior backend engineer.")).toBeInTheDocument();
    expect(screen.getByText("Senior platform engineer focused on Kubernetes reliability.")).toBeInTheDocument();
    expect(screen.getByText("Persona judgments")).toBeInTheDocument();
    expect(screen.getByText("Evidence Auditor")).toBeInTheDocument();
    expect(screen.getByText("Show LLM audit trail")).toBeInTheDocument();
    expect(screen.getByText("Persona rubric")).toBeInTheDocument();
    expect(screen.getByText("Check that every metric, tool, role, company, and achievement is supported.")).toBeInTheDocument();
    expect(screen.getByText("Why it scored this way")).toBeInTheDocument();
    expect(screen.getByText("LLM returned")).toBeInTheDocument();
    expect(screen.getByText("Exact LLM request")).toBeInTheDocument();
    expect(screen.getByText("Persona response")).toBeInTheDocument();
    expect(screen.getByText("Stored LLM response")).toBeInTheDocument();
    expect(screen.getAllByText("Evidence was supported by profile facts.").length).toBeGreaterThan(0);
    expect(screen.getByText("Evaluate the tailored resume from every persona below.")).toBeInTheDocument();
    expect(screen.getAllByText("All personas passed with residual warnings only.").length).toBeGreaterThan(0);
  });
});
