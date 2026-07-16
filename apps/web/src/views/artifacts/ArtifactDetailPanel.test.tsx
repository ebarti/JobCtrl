import type {
  ArtifactOpenResponse,
  ArtifactSummary,
  ArtifactTailoringExplanation,
  EvidenceMapResponse,
  JobDetail,
} from "@jobctrl/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { artifactsSearchSchema } from "../../routes/-artifacts.search.js";
import { DemoArtifactPreviewError } from "../../demo/DemoExternalRehearsalExecutor.js";
import { DemoFeatureFlagAdapter } from "../../demo/ports.js";
import { buildProviderHarness } from "../../test/render.js";
import {
  makeArtifactTailoringExplanation,
  makeArtifactsPage,
  makeJobDetail,
  sampleArtifact,
  sampleEvidenceMapResponse,
  sampleJob,
} from "../../test/fixtures/projections.js";
import {
  populatedEmployerAnalysis,
  provenanceEntries,
} from "../../test/fixtures/materials-inspector.js";
import { ArtifactDetailPanel } from "./ArtifactDetailPanel.js";

vi.mock("../../shared/ui/PdfPreviewViewer.js", () => ({
  PdfPreviewViewer: ({ title, url }: { title: string; url: string }) => (
    <div>
      <span>{title}</span>
      <span>{url}</span>
    </div>
  ),
}));

interface RenderArtifactRouteOptions {
  readonly demo?: boolean;
  readonly evidenceMap?: EvidenceMapResponse;
  readonly jobDetail?: JobDetail;
  readonly openArtifact?: (artifactId: string) => Promise<ArtifactOpenResponse>;
}

const artifactEvidenceMap: EvidenceMapResponse = {
  ...sampleEvidenceMapResponse,
  entries: [
    {
      ...sampleEvidenceMapResponse.entries[0]!,
      entryId: "ev_latency",
      evidenceId: "ev_latency",
      title: "Reduced platform latency through reliability automation",
      story: {
        ...sampleEvidenceMapResponse.entries[0]!.story!,
        outcome: "Improved response time across critical services.",
      },
    },
    {
      ...sampleEvidenceMapResponse.entries[0]!,
      entryId: "ev_scope",
      evidenceId: "ev_scope",
      title: "Led reliability programs across the platform",
      story: {
        ...sampleEvidenceMapResponse.entries[0]!.story!,
        outcome: "Expanded technical ownership across multiple teams.",
      },
    },
  ],
};

function renderArtifactRoute(
  children: ReactNode,
  status = "approved",
  tailoringExplanation: ArtifactTailoringExplanation | null = null,
  comparisonArtifacts: readonly ArtifactSummary[] = [],
  options: RenderArtifactRouteOptions = {},
) {
  const artifact = {
    ...sampleArtifact,
    artifactId: "artifact-preview",
    type: "resume_pdf",
    status,
    localPath: "/tmp/artifact-preview.pdf",
    sizeBytes: 1234,
  };
  const artifactList = [artifact, ...comparisonArtifacts];
  const ports = buildProviderHarness().ports;
  const artifactPreviewPdfUrl = vi.fn(
    () => "/v1/artifacts/artifact-preview/preview.pdf?v=test",
  );
  const harness = buildProviderHarness({
    ports: {
      ...ports,
      api: Object.assign(
        Object.create(Object.getPrototypeOf(ports.api)),
        ports.api,
        {
          artifacts: vi.fn(async () => makeArtifactsPage(artifactList)),
          artifact: vi.fn(async (artifactId: string) => ({
            ok: true as const,
            artifact:
              artifactList.find(
                (candidate) => candidate.artifactId === artifactId,
              ) ?? artifact,
            layoutBoxes: [],
            tailoringExplanation,
          })),
          evidenceMap: vi.fn(
            async () => options.evidenceMap ?? artifactEvidenceMap,
          ),
          job: vi.fn(async () => options.jobDetail ?? makeJobDetail()),
          artifactPreviewPdfUrl,
        },
      ),
      openInOs: options.openArtifact
        ? { open: options.openArtifact }
        : ports.openInOs,
      featureFlags: options.demo
        ? new DemoFeatureFlagAdapter()
        : ports.featureFlags,
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
    history: createMemoryHistory({
      initialEntries: ["/artifacts/artifact-preview"],
    }),
  });

  render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });
  return { artifactPreviewPdfUrl, router };
}

describe("<ArtifactDetailPanel>", () => {
  it("renders as a route workspace and returns to the artifacts list", async () => {
    const user = userEvent.setup();
    const { router } = renderArtifactRoute(
      <ArtifactDetailPanel artifactId="artifact-preview" />,
    );

    expect(
      await screen.findByRole("article", { name: "Artifact details" }),
    ).toHaveClass("route-workspace", "artifact-detail-workspace");
    expect(
      screen.getByRole("heading", { level: 2, name: "Artifact audit" }),
    ).toHaveClass("sr-only");
    expect(
      screen.queryByRole("dialog", { name: "Artifact details" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to artifacts" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/artifacts"),
    );
  });

  it("surfaces a blocked demo popup without claiming that the preview opened", async () => {
    const openArtifact = vi.fn(async () => {
      throw new DemoArtifactPreviewError(
        "demo_preview_blocked",
        "/demo/tailored-resume.pdf",
      );
    });
    renderArtifactRoute(
      <ArtifactDetailPanel artifactId="artifact-preview" />,
      "approved",
      null,
      [],
      { demo: true, openArtifact },
    );

    const button = await screen.findByRole("button", {
      name: "preview in browser",
    });
    fireEvent.click(button);

    expect(
      await screen.findByText(
        "The browser blocked the new tab. Use the embedded same-origin preview instead.",
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "preview in browser" }),
      ).toBeEnabled(),
    );
    expect(openArtifact).toHaveBeenCalledWith("artifact-preview");
  });

  it("keeps raw storage details collapsed while preserving the audit trail", async () => {
    const user = userEvent.setup();
    renderArtifactRoute(<ArtifactDetailPanel artifactId="artifact-preview" />);

    expect(
      await screen.findByRole("heading", {
        level: 3,
        name: "Artifact summary",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("/tmp/artifact-preview.pdf"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("artifact-preview")).not.toBeInTheDocument();
    expect(screen.queryByText("job-1")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Technical details/i }),
    );

    expect(screen.getByText("/tmp/artifact-preview.pdf")).toBeInTheDocument();
    expect(screen.getByText("artifact-preview")).toBeInTheDocument();
    expect(screen.getByText("job-1")).toBeInTheDocument();
  });

  it("renders canonical requirement text while keeping provenance IDs in Technical details", async () => {
    const user = userEvent.setup();
    renderArtifactRoute(
      <ArtifactDetailPanel artifactId="artifact-preview" />,
      "approved",
      makeArtifactTailoringExplanation(null, {
        bulletProvenance: [provenanceEntries[0]!],
      }),
      [],
      {
        jobDetail: makeJobDetail(sampleJob, {
          employerAnalysis: populatedEmployerAnalysis,
        }),
      },
    );

    const requirementText = await screen.findByText(
      "Lead platform reliability programs across multiple teams",
    );
    const provenanceCard = requirementText.closest("article");
    if (!provenanceCard) {
      throw new Error("Expected requirement text inside a provenance card.");
    }

    expect(within(provenanceCard).queryByText("req-1")).not.toBeInTheDocument();

    await user.click(
      within(provenanceCard).getByRole("button", {
        name: "Technical details",
      }),
    );

    expect(within(provenanceCard).getByText("req-1")).toBeInTheDocument();
  });

  it("explains approved status and renders the PDF preview after the audit", async () => {
    const { artifactPreviewPdfUrl } = renderArtifactRoute(
      <ArtifactDetailPanel artifactId="artifact-preview" />,
    );

    expect(
      await screen.findByText(
        "Approved means this generated material passed validation and is the accepted version for this job.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Artifact PDF preview")).toHaveTextContent(
      "Artifact preview",
    );
    expect(screen.getByLabelText("Artifact PDF preview")).toHaveTextContent(
      "/v1/artifacts/artifact-preview/preview.pdf?v=test",
    );
    const audit = screen
      .getByRole("heading", { level: 2, name: "Artifact audit" })
      .closest(".artifact-detail-sidebar");
    expect(audit?.nextElementSibling).toBe(
      screen.getByLabelText("Artifact PDF preview"),
    );
    expect(artifactPreviewPdfUrl).toHaveBeenCalledWith(
      "artifact-preview",
      expect.stringContaining("1234"),
    );
  });

  it("marks suppressed artifacts as historical audit material", async () => {
    renderArtifactRoute(
      <ArtifactDetailPanel artifactId="artifact-preview" />,
      "suppressed",
    );

    expect(
      await screen.findByText(
        "This artifact is historical audit material and is not active apply-ready material.",
      ),
    ).toBeInTheDocument();
  });

  it("renders tailoring rationale from artifact detail evidence", async () => {
    renderArtifactRoute(
      <ArtifactDetailPanel artifactId="artifact-preview" />,
      "approved",
      {
        targetSeniority: "senior",
        claimMode: "evidence_reframing",
        validationMode: "normal",
        safety: {
          autoApprovableClaimModes: ["verified_only"],
          allowAdjacentAchievementDrafts: false,
          qualityPassed: true,
        },
        keywords: {
          coverageRecorded: true,
          planned: ["platform reliability", "typescript"],
          covered: ["platform reliability"],
          declared: [],
          missing: ["typescript"],
          filtered: {
            planned: [],
            covered: [],
            missing: [],
          },
          counts: {
            planned: 2,
            covered: 1,
            declared: 0,
            missing: 1,
            displayedPlanned: 2,
            displayedCovered: 1,
            displayedDeclared: 0,
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
              promptRubric:
                "Check that every metric, tool, role, company, and achievement is supported.",
              blockers: [],
              warnings: [],
              repairInstructions: [],
              scoreBasis: [
                "LLM verdict: PASS",
                "LLM score: 0.90",
                "Blockers: none",
              ],
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
                content:
                  "Evaluate the tailored resume from every persona below.",
              },
              {
                role: "user",
                content: "Run the adversarial review and return JSON.",
              },
            ],
            response: {
              verdict: "PASS",
              score: 0.88,
              scoreRationale:
                "All personas passed with residual warnings only.",
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
            tailoredText: [
              "Senior platform engineer focused on Kubernetes reliability.",
            ],
            rationale: "Summary was reframed toward platform reliability.",
            jobSignals: ["platform reliability", "kubernetes"],
            controls: [
              "target seniority: senior",
              "claim mode: evidence_reframing",
            ],
            evidenceIds: ["ev_scope"],
            evidenceNotes: ["ev_scope: technical ownership"],
          },
        ],
        bulletProvenance: [],
        coverageAudit: null,
        voicePass: null,
        models: {
          candidateModels: ["generator-a"],
          selectedModel: "generator-a",
          selectedCandidate: "candidate-1",
          judgeModel: "judge-a",
          attempts: 2,
        },
      },
    );

    expect(await screen.findByText("Tailoring rationale")).toBeInTheDocument();
    expect(screen.getByText("Senior")).toBeInTheDocument();
    expect(screen.getByText("Evidence Reframing")).toBeInTheDocument();
    expect(screen.getByText("1/2 demonstrated in resume")).toBeInTheDocument();
    expect(screen.getByText("2 total")).toBeInTheDocument();
    expect(screen.getByText("Target job keywords")).toBeInTheDocument();
    expect(screen.getByText("Found in tailored resume")).toBeInTheDocument();
    expect(
      screen.getByText("No resume keyword match found"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No recorded resume match"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Not recorded as covered"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Displayed target keywords"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Filtered covered keywords"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("head")).not.toBeInTheDocument();
    expect(screen.getAllByText("platform reliability").length).toBeGreaterThan(
      0,
    );
    const latencyEvidence = screen.getAllByRole("link", {
      name: /Reduced platform latency through reliability automation/i,
    });
    expect(latencyEvidence).toHaveLength(2);
    expect(latencyEvidence[0]).toHaveAttribute(
      "href",
      expect.stringContaining("/evidence-map"),
    );
    expect(latencyEvidence[0]).toHaveAttribute(
      "href",
      expect.stringContaining("entry=ev_latency"),
    );
    expect(latencyEvidence[0]).toHaveAttribute(
      "href",
      expect.stringContaining("job=job-1"),
    );
    const firstLatencyEvidence = latencyEvidence[0];
    if (!firstLatencyEvidence) {
      throw new Error("Expected latency evidence to be rendered.");
    }
    expect(firstLatencyEvidence.closest("li")).not.toHaveClass("tag");
    expect(firstLatencyEvidence.closest("li")).toHaveTextContent(
      "Improved response time across critical services.",
    );
    expect(
      screen.getAllByText("Led reliability programs across the platform")
        .length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("ev_latency")).not.toBeInTheDocument();
    expect(screen.queryByText("ev_scope")).not.toBeInTheDocument();
    expect(screen.queryByText("Missing evidence")).not.toBeInTheDocument();
    expect(screen.queryByText("Metric claims")).not.toBeInTheDocument();
    expect(screen.queryByText("none recorded")).not.toBeInTheDocument();
    expect(screen.getByText("91% / minimum 82%")).toBeInTheDocument();
    expect(screen.getByText("Review outcome")).toBeInTheDocument();
    expect(
      screen.getByText("Residual warnings after automated review"),
    ).toBeInTheDocument();
    expect(screen.getByText("Warning decision source")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Material generation workflow; no human approver recorded.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Accepted residual warnings"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Warning handling")).toBeInTheDocument();
    expect(
      screen.getByText(
        "retry attempted; selected artifact still has residual warnings",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Warning repair attempted"),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByText("Bullet could be more concise.").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Annotated resume changes")).toBeInTheDocument();
    expect(
      screen.getByText("Summary was reframed toward platform reliability."),
    ).toBeInTheDocument();
    expect(screen.getByText("Senior backend engineer.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Senior platform engineer focused on Kubernetes reliability.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Persona judgments")).toBeInTheDocument();
    expect(screen.getByText("Evidence Auditor")).toBeInTheDocument();
    expect(screen.getByText("Show LLM audit trail")).toBeInTheDocument();
    expect(screen.getByText("Persona rubric")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Check that every metric, tool, role, company, and achievement is supported.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Why it scored this way")).toBeInTheDocument();
    expect(screen.getByText("LLM returned")).toBeInTheDocument();
    expect(screen.getByText("Exact LLM request")).toBeInTheDocument();
    expect(screen.getByText("Persona response")).toBeInTheDocument();
    expect(screen.getByText("Stored LLM response")).toBeInTheDocument();
    expect(
      screen.getAllByText("Evidence was supported by profile facts.").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "Evaluate the tailored resume from every persona below.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("All personas passed with residual warnings only.")
        .length,
    ).toBeGreaterThan(0);
  });

  it("does not show missing resume keyword matches when coverage was not recorded", async () => {
    renderArtifactRoute(
      <ArtifactDetailPanel artifactId="artifact-preview" />,
      "approved",
      {
        targetSeniority: null,
        claimMode: null,
        validationMode: null,
        safety: {
          autoApprovableClaimModes: [],
          allowAdjacentAchievementDrafts: null,
          qualityPassed: null,
        },
        keywords: {
          coverageRecorded: false,
          planned: ["AWS", "GCP", "Java", "Observability"],
          covered: [],
          declared: [],
          missing: [],
          filtered: {
            planned: [],
            covered: [],
            missing: [],
          },
          counts: {
            planned: 4,
            covered: 0,
            declared: 0,
            missing: 0,
            displayedPlanned: 4,
            displayedCovered: 0,
            displayedDeclared: 0,
            displayedMissing: 0,
            filteredPlanned: 0,
            filteredCovered: 0,
            filteredMissing: 0,
          },
        },
        evidence: {
          requiredIds: [],
          seniorityIds: [],
          representedIds: [],
          missingIds: [],
          verifiedMetricCount: null,
        },
        quality: {
          passed: null,
          errors: [],
          warnings: [],
          notes: [],
          metricClaims: [],
          repeatedKeywords: [],
        },
        judge: {
          passed: null,
          verdict: null,
          score: null,
          minScore: null,
          issues: [],
          unsupportedClaims: [],
          fabrications: [],
          missingRequiredEvidence: [],
          repairInstructions: [],
        },
        adversarialReview: null,
        reviewFeedback: {
          warningRepairAttempted: null,
          acceptedWithResidualWarnings: null,
          acceptedWarnings: [],
        },
        annotatedChanges: [],
        bulletProvenance: [],
        coverageAudit: null,
        voicePass: null,
        models: {
          candidateModels: [],
          selectedModel: null,
          selectedCandidate: null,
          judgeModel: null,
          attempts: null,
        },
      },
    );

    expect(await screen.findByText("Resume match audit")).toBeInTheDocument();
    expect(
      screen.getByText("not recorded for this artifact"),
    ).toBeInTheDocument();
    expect(screen.getByText("Target job keywords")).toBeInTheDocument();
    expect(screen.getByText("AWS")).toBeInTheDocument();
    expect(
      screen.queryByText("Found in tailored resume"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("No resume keyword match found"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/0\/4 demonstrated in resume/i),
    ).not.toBeInTheDocument();
  });

  it("offers same-job same-type artifacts for comparison", async () => {
    renderArtifactRoute(
      <ArtifactDetailPanel artifactId="artifact-preview" />,
      "approved",
      null,
      [
        {
          ...sampleArtifact,
          artifactId: "artifact-template-b",
          jobKey: "job-1",
          type: "resume_pdf",
          status: "candidate",
          createdAt: "2026-05-03T08:00:00Z",
        },
      ],
    );

    expect(await screen.findByText("Artifact comparison")).toBeInTheDocument();
    const comparisonSelect = await screen.findByRole("combobox", {
      name: "Compare with",
    });
    expect(comparisonSelect).toHaveTextContent(/candidate/);
    await userEvent.setup().click(comparisonSelect);
    expect(
      await screen.findByRole("option", { name: /candidate/ }),
    ).toBeInTheDocument();
  });
});
