import type { ArtifactTailoringExplanation } from "@jobhunter/contracts";
import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { routeTree } from "../../routeTree.gen.js";
import { makeApplyAudit, sampleApplyReviewQueue, sampleArtifact } from "../../test/fixtures/projections.js";
import { buildProviderHarness, renderWithProviders } from "../../test/render.js";
import { buildTestPorts } from "../../test/testPorts.js";
import { ApplyReviewView } from "./ApplyReviewView.js";

vi.mock("../../shared/ui/PdfPreviewViewer.js", () => ({
  PdfPreviewViewer: ({ title, url }: { title: string; url: string }) => (
    <div aria-label={title} data-url={url} role="img">
      PDF preview
    </div>
  ),
  PdfAuditPreviewViewer: ({
    lineTargets,
    onSelectLine,
    onSelectLineNumber,
    selectedLineKey,
    selectedLineNumber,
    title,
    url,
  }: {
    readonly lineTargets: readonly { lineNumber: number; text: string }[];
    readonly onSelectLine?: (selection: {
      lineKey: string;
      lineNumber: number | null;
      pageLineIndex: number;
      pageNumber: number;
      resumeLineText: string | null;
      text: string;
    }) => void;
    readonly onSelectLineNumber?: (lineNumber: number | null) => void;
    readonly selectedLineKey?: string | null;
    readonly selectedLineNumber?: number | null;
    readonly title: string;
    readonly url: string;
  }) => {
    const pdfOnlyLine = {
      lineKey: "pdf:3:15:Platform & Cloud: Kubernetes, Docker, GCP",
      pageLineIndex: 15,
      pageNumber: 3,
      text: "Platform & Cloud: Kubernetes, Docker, GCP",
    };
    return (
      <div>
        <div aria-label={title} data-url={url} role="img">
          PDF preview
        </div>
        <div aria-label="PDF resume selectable lines">
          {lineTargets.map((line) => (
            <button
              aria-label={`Line ${line.lineNumber}: ${line.text}`}
              aria-pressed={selectedLineKey === `resume:${line.lineNumber}` || line.lineNumber === selectedLineNumber}
              key={line.lineNumber}
              type="button"
              onClick={() => {
                onSelectLine?.({
                  lineKey: `resume:${line.lineNumber}`,
                  lineNumber: line.lineNumber,
                  pageLineIndex: line.lineNumber,
                  pageNumber: 1,
                  resumeLineText: line.text,
                  text: line.text,
                });
                onSelectLineNumber?.(line.lineNumber);
              }}
            />
          ))}
          <button
            aria-label={`PDF page ${pdfOnlyLine.pageNumber} line ${pdfOnlyLine.pageLineIndex}: ${pdfOnlyLine.text}`}
            aria-pressed={selectedLineKey === pdfOnlyLine.lineKey}
            type="button"
            onClick={() => {
              onSelectLine?.({
                lineKey: pdfOnlyLine.lineKey,
                lineNumber: null,
                pageLineIndex: pdfOnlyLine.pageLineIndex,
                pageNumber: pdfOnlyLine.pageNumber,
                resumeLineText: null,
                text: pdfOnlyLine.text,
              });
              onSelectLineNumber?.(null);
            }}
          />
        </div>
      </div>
    );
  },
}));

vi.mock("../jobs/JobDetailDrawer.js", () => ({
  JobDetailDrawer: ({
    jobId,
    onClose,
  }: {
    readonly jobId: string;
    readonly onClose: () => void;
  }) => (
    <div aria-label={`Job details for ${jobId}`} role="dialog">
      <button type="button" onClick={onClose}>
        close details
      </button>
    </div>
  ),
}));

const sampleTailoringExplanation: ArtifactTailoringExplanation = {
  targetSeniority: "principal",
  claimMode: "evidence_reframing",
  validationMode: "normal",
  safety: {
    autoApprovableClaimModes: ["verified_only"],
    allowAdjacentAchievementDrafts: false,
    qualityPassed: true,
  },
  keywords: {
    coverageRecorded: true,
    planned: ["platform reliability", "incident response", "kubernetes"],
    covered: ["platform reliability"],
    missing: ["incident response"],
    filtered: {
      planned: [],
      covered: [],
      missing: [],
    },
    counts: {
      planned: 3,
      covered: 1,
      missing: 1,
      displayedPlanned: 3,
      displayedCovered: 1,
      displayedMissing: 1,
      filteredPlanned: 0,
      filteredCovered: 0,
      filteredMissing: 0,
    },
  },
  evidence: {
    requiredIds: ["ev_platform_reliability"],
    seniorityIds: ["ev_principal_scope"],
    representedIds: ["ev_platform_reliability"],
    missingIds: [],
    verifiedMetricCount: 2,
  },
  quality: {
    passed: true,
    errors: [],
    warnings: [],
    notes: ["Keyword coverage: 1/2"],
    metricClaims: ["42%"],
    repeatedKeywords: [],
  },
  judge: {
    passed: true,
    verdict: "PASS",
    score: 0.93,
    minScore: 0.84,
    issues: [],
    unsupportedClaims: [],
    fabrications: [],
    missingRequiredEvidence: [],
    repairInstructions: [],
  },
  adversarialReview: {
    ran: true,
    passed: true,
    score: 0.9,
    scoreRationale: "All personas passed with no blockers.",
    threshold: 0.8,
    blockers: [],
    warnings: [],
    repairInstructions: [],
    personas: [
      {
        persona: "evidence_auditor",
        verdict: "PASS",
        score: 0.91,
        scoreRationale: "Evidence was supported by profile facts.",
        promptRubric: "Check that every metric, tool, role, company, and achievement is supported.",
        blockers: [],
        warnings: [],
        repairInstructions: [],
        scoreBasis: ["LLM verdict: PASS", "LLM score: 0.91", "Blockers: none"],
        response: {
          verdict: "PASS",
          score: 0.91,
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
        score: 0.9,
        scoreRationale: "All personas passed with no blockers.",
        blockers: [],
        warnings: [],
        repairInstructions: [],
        personas: [
          {
            verdict: "PASS",
            score: 0.91,
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
    warningRepairAttempted: false,
    acceptedWithResidualWarnings: false,
    acceptedWarnings: [],
  },
  annotatedChanges: [
    {
      section: "experience",
      label: "Senior SWE at Acme",
      changeType: "achievement_reframed",
      sourceId: "ev_platform_reliability",
      sourceText: ["Built platform services."],
      tailoredText: ["Owned platform reliability improvements for incident response."],
      rationale: "Experience was emphasized because it matches platform reliability.",
      jobSignals: ["platform reliability", "incident response"],
      controls: ["target seniority: principal", "claim mode: evidence_reframing"],
      evidenceIds: ["ev_platform_reliability"],
      evidenceNotes: ["ev_platform_reliability: platform ownership"],
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
};

const pinnedTailoringExplanation: ArtifactTailoringExplanation = {
  ...sampleTailoringExplanation,
  quality: {
    ...sampleTailoringExplanation.quality,
    warnings: [
      "Keyword repetition: 'platform' repeated 7 times",
      "Keyword repetition: 'architecture' repeated 5 times",
      "Keyword repetition: 'platform' repeated 7 times",
    ],
  },
  judge: {
    ...sampleTailoringExplanation.judge,
    passed: false,
    verdict: "REVIEW",
    score: 0.62,
    unsupportedClaims: ["Owned platform reliability improvements for incident response."],
    missingRequiredEvidence: ["req-platform-scale"],
    repairInstructions: ["Remove unsupported scope claim."],
  },
  reviewFeedback: {
    warningRepairAttempted: true,
    acceptedWithResidualWarnings: true,
    acceptedWarnings: [
      "Banned words: pioneered, robust, proven track record",
      "Keyword repetition: 'platform' repeated 7 times",
      "Keyword repetition: 'architecture' repeated 5 times",
      "Keyword repetition: 'platform' repeated 7 times",
    ],
  },
  bulletProvenance: [
    {
      bulletId: "pin-1",
      section: "experience",
      sourceId: "ev_platform_reliability",
      evidenceIds: ["ev_platform_reliability"],
      sourceText: ["Built platform services."],
      requirementIds: ["req-platform"],
      matchedKeywords: ["platform reliability"],
      transformType: "achievement_reframed",
      control: "evidence_reframing",
      rationale: "Reframed the source fact to foreground platform reliability ownership.",
      generatedText: "Owned platform reliability improvements for incident response.",
    },
  ],
};

describe("<ApplyReviewView>", () => {
  it("renders the review workspace with job evidence and tailored materials", async () => {
    renderWithProviders(<ApplyReviewView />);

    expect((await screen.findAllByText("Principal Platform Engineer")).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("heading", { name: "Requirements and original post" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tailored resume and cover" })).toBeInTheDocument();
    expect(screen.getAllByText("materials ready").length).toBeGreaterThan(0);
    expect(screen.getAllByText("platform reliability").length).toBeGreaterThan(0);
    expect(screen.getByText("public company scale")).toBeInTheDocument();
    expect(screen.getByText(/Dry run completed/i)).toBeInTheDocument();
    expect(screen.queryByText(/dry_run/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Globex needs a principal engineer/i)).toBeInTheDocument();
    const detailButton = screen.getByRole("button", {
      name: /Open job detail for Principal Platform Engineer/i,
    });
    expect(detailButton).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open job detail/i })).not.toBeInTheDocument();
    const resumePdf = screen.getByRole("img", { name: "Tailored resume PDF" });
    expect(resumePdf.getAttribute("data-url")).toContain("/v1/artifacts/resume-pdf-2/preview.pdf");
    expect(screen.queryByText("Recruiter reply indicates an interview request.")).not.toBeInTheDocument();
  });

  it("surfaces resume tailoring rationale in the apply review workspace", async () => {
    const artifact = vi.fn(async (artifactId: string) => ({
      ok: true as const,
      artifact: {
        ...sampleArtifact,
        artifactId,
        jobKey: sampleApplyReviewQueue.items[0]!.jobKey,
        title: "Principal Platform Engineer Resume",
        company: sampleApplyReviewQueue.items[0]!.company,
      },
      tailoringExplanation: sampleTailoringExplanation,
    }));

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => sampleApplyReviewQueue),
          artifact,
        },
      }),
    });

    expect(await screen.findByRole("region", { name: "Line-by-line resume audit" })).toBeInTheDocument();
    const pdfReviewSurface = screen.getByRole("region", { name: "PDF resume line review" });
    fireEvent.click(
      within(pdfReviewSurface).getByRole("button", {
        name: "Line 3: Owned platform reliability improvements for incident response.",
      }),
    );
    const selectedAudit = await screen.findByRole("article", { name: /Selected resume line audit for line 3/i });
    const selectedJustification = selectedAudit.querySelector(".resume-pin-justification") as HTMLElement;
    expect(within(selectedJustification).getByText("Original source line")).toBeInTheDocument();
    expect(within(selectedJustification).getByText("Rendered resume line")).toBeInTheDocument();
    expect(within(selectedJustification).getByText("Built platform services.")).toBeVisible();
    expect(within(selectedAudit).getByText("Source check")).toBeInTheDocument();
    expect(within(selectedAudit).queryByText("Source evidence")).not.toBeInTheDocument();
    expect(within(selectedAudit).queryByText("Evidence basis")).not.toBeInTheDocument();
    expect(
      within(selectedAudit).getByText(/Experience was emphasized because it matches platform reliability/i),
    ).toBeInTheDocument();
    const artifactRisk = screen.getByRole("region", { name: "Artifact-level grounding and claim risk" });
    const pdfAudit = screen.getByRole("region", { name: "PDF resume audit" });
    expect(artifactRisk.compareDocumentPosition(pdfAudit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("region", { name: "Line-by-line resume audit" })).not.toContainElement(artifactRisk);
    expect(within(selectedAudit).queryByText("Artifact-level grounding and claim risk")).not.toBeInTheDocument();
    expect(screen.queryByText("Annotated resume changes")).not.toBeInTheDocument();
    expect(screen.queryByText("Tailoring rationale")).not.toBeInTheDocument();
    expect(screen.queryByText("join")).not.toBeInTheDocument();
    expect(screen.getAllByText("Built platform services.").length).toBeGreaterThan(0);
    expect(
      within(pdfReviewSurface).getByRole("button", {
        name: "Line 3: Owned platform reliability improvements for incident response.",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(within(selectedAudit).getByText("Job signals reflected")).toBeInTheDocument();
    expect(within(selectedAudit).getAllByText("platform reliability").length).toBeGreaterThan(0);
    expect(within(selectedAudit).queryByText("Evidence IDs")).not.toBeInTheDocument();
    expect(within(selectedAudit).queryByText("Requirement IDs")).not.toBeInTheDocument();
    expect(within(selectedAudit).queryByText("Controls")).not.toBeInTheDocument();
    expect(within(selectedAudit).queryByText("Transform")).not.toBeInTheDocument();
    expect(within(selectedAudit).queryByText("ev_platform_reliability")).not.toBeInTheDocument();
    expect(within(selectedAudit).queryByText("evidence_reframing")).not.toBeInTheDocument();
    expect(screen.getAllByText("High-fit review").length).toBeGreaterThan(0);
    expect(artifact).toHaveBeenCalledWith("resume-text-2");
    expect(artifact).not.toHaveBeenCalledWith("resume-pdf-2");
  });

  it("uses the PDF preview as the selectable line-level claim surface", async () => {
    const artifact = vi.fn(async (artifactId: string) => ({
      ok: true as const,
      artifact: {
        ...sampleArtifact,
        artifactId,
        jobKey: sampleApplyReviewQueue.items[0]!.jobKey,
        title: "Principal Platform Engineer Resume",
        company: sampleApplyReviewQueue.items[0]!.company,
      },
      tailoringExplanation: pinnedTailoringExplanation,
    }));

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => sampleApplyReviewQueue),
          artifact,
        },
      }),
    });

    const resumePdf = await screen.findByRole("img", { name: "Tailored resume PDF" });
    const pins = await screen.findByRole("region", { name: "Line-by-line resume audit" });
    await waitFor(() => expect(artifact).toHaveBeenCalledWith("resume-text-2"));
    expect(artifact).not.toHaveBeenCalledWith("resume-pdf-2");
    expect(resumePdf.compareDocumentPosition(pins) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Resume audit line list" })).not.toBeInTheDocument();
    const pdfReviewSurface = screen.getByRole("region", { name: "PDF resume line review" });
    const pdfLineThree = within(pdfReviewSurface).getByRole("button", {
      name: "Line 3: Owned platform reliability improvements for incident response.",
    });
    const initialAudit = screen.getByRole("article", { name: /Selected resume line audit for line 1/i });
    expect(within(initialAudit).queryByText("claim risk")).not.toBeInTheDocument();
    fireEvent.click(pdfLineThree);
    const selectedAudit = await screen.findByRole("article", { name: /Selected resume line audit for line 3/i });
    expect(within(selectedAudit).getByText("Original source line")).toBeInTheDocument();
    expect(within(selectedAudit).getByText("Rendered resume line")).toBeInTheDocument();
    expect(within(selectedAudit).getByText("Source check")).toBeInTheDocument();
    expect(within(selectedAudit).queryByText("Source evidence")).not.toBeInTheDocument();
    expect(within(selectedAudit).queryByText("Evidence basis")).not.toBeInTheDocument();
    const selectedJustification = selectedAudit.querySelector(".resume-pin-justification") as HTMLElement;
    expect(within(selectedJustification).getByText("Built platform services.")).toBeVisible();
    expect(within(selectedAudit).getAllByText("Bullet provenance").length).toBeGreaterThan(0);
    expect(screen.queryByText("Tailored artifact text")).not.toBeInTheDocument();
    expect(screen.getAllByText("Owned platform reliability improvements for incident response.").length).toBeGreaterThan(0);
    expect(within(selectedAudit).getByText("Job signals reflected")).toBeInTheDocument();
    expect(within(selectedAudit).getAllByText("platform reliability").length).toBeGreaterThan(0);
    expect(within(selectedAudit).queryByText("Achievement Reframed")).not.toBeInTheDocument();
    expect(within(selectedAudit).queryByText("evidence_reframing")).not.toBeInTheDocument();
    expect(within(selectedAudit).queryByText("req-platform")).not.toBeInTheDocument();
    expect(within(selectedAudit).queryByText("ev_platform_reliability")).not.toBeInTheDocument();
    expect(within(selectedAudit).queryByText("Evidence IDs")).not.toBeInTheDocument();
    expect(within(selectedAudit).queryByText("Requirement IDs")).not.toBeInTheDocument();
    expect(within(selectedAudit).queryByText("Controls")).not.toBeInTheDocument();
    expect(within(selectedAudit).queryByText("Transform")).not.toBeInTheDocument();
    expect(screen.getByText("Artifact-level grounding and claim risk")).toBeInTheDocument();
    const artifactRisk = screen.getByRole("region", { name: "Artifact-level grounding and claim risk" });
    expect(within(selectedAudit).queryByText("Artifact-level grounding and claim risk")).not.toBeInTheDocument();
    expect(within(artifactRisk).queryByText("Warnings")).not.toBeInTheDocument();
    expect(within(artifactRisk).getByText("Accepted residual warnings")).toBeInTheDocument();
    expect(within(artifactRisk).getAllByText("Keyword repetition: 'platform' repeated 7 times")).toHaveLength(1);
    expect(within(artifactRisk).getAllByText("Keyword repetition: 'architecture' repeated 5 times")).toHaveLength(1);
    expect(screen.getAllByText("claim risk").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Owned platform reliability improvements for incident response.").length).toBeGreaterThan(0);
    expect(screen.getAllByText("req-platform-scale").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Warning repair attempted").length).toBeGreaterThan(0);
  });

  it("does not promote source-span fallback lines with audit metadata gaps to claim risk", async () => {
    const sourceBackedExplanation: ArtifactTailoringExplanation = {
      ...sampleTailoringExplanation,
      quality: {
        ...sampleTailoringExplanation.quality,
        errors: ["Tailoring audit metadata incomplete: missing profile evidence mapping"],
      },
      annotatedChanges: sampleTailoringExplanation.annotatedChanges.map((change) => ({
        ...change,
        sourceText: ["Built platform services.", "Led incident response handovers."],
        evidenceIds: [],
      })),
    };
    const artifact = vi.fn(async (artifactId: string) => ({
      ok: true as const,
      artifact: {
        ...sampleArtifact,
        artifactId,
        jobKey: sampleApplyReviewQueue.items[0]!.jobKey,
        title: "Principal Platform Engineer Resume",
        company: sampleApplyReviewQueue.items[0]!.company,
      },
      tailoringExplanation: sourceBackedExplanation,
    }));
    const queueWithContextualResume = {
      ...sampleApplyReviewQueue,
      items: sampleApplyReviewQueue.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              materialsPreview: {
                ...item.materialsPreview,
                resumeText: "Principal Platform Engineer\n\nExperience\nSenior SWE | Acme\n- Led incident response handovers.",
              },
            }
          : item,
      ),
    };

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => queueWithContextualResume),
          artifact,
        },
      }),
    });

    await waitFor(() => expect(artifact).toHaveBeenCalledWith("resume-text-2"));
    const pdfReviewSurface = screen.getByRole("region", { name: "PDF resume line review" });
    const pdfLineThree = within(pdfReviewSurface).getByRole("button", {
      name: "Line 5: - Led incident response handovers.",
    });
    fireEvent.click(pdfLineThree);
    const selectedAudit = await screen.findByRole("article", { name: /Selected resume line audit for line 5/i });

    expect(within(selectedAudit).getByText("source section")).toBeInTheDocument();
    expect(within(selectedAudit).getAllByText(/source span/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("source-backed")).not.toBeInTheDocument();
    expect(screen.queryByText("claim risk")).not.toBeInTheDocument();
    expect(screen.queryByText("No source evidence recorded for this line.")).not.toBeInTheDocument();
    expect(within(selectedAudit).getByText("Line justification")).toBeInTheDocument();
    expect(within(selectedAudit).getByText("Closest recorded source line")).toBeInTheDocument();
    expect(within(selectedAudit).getByText("Rendered resume line")).toBeInTheDocument();
    const selectedJustification = selectedAudit.querySelector(".resume-pin-justification") as HTMLElement;
    expect(within(selectedJustification).getByText("Led incident response handovers.")).toBeVisible();
    expect(within(selectedAudit).getByText("- Led incident response handovers.")).toBeInTheDocument();
    expect(within(selectedAudit).getByText(/No exact source mapping was recorded/i)).toBeInTheDocument();
    expect(within(selectedAudit).getByText("Job signals reflected")).toBeInTheDocument();
    expect(within(selectedAudit).getAllByText("platform reliability").length).toBeGreaterThan(0);
    expect(within(selectedAudit).queryByText("Evidence basis")).not.toBeInTheDocument();
    expect(within(selectedAudit).getAllByText("Section source span; exact line not recorded").length).toBeGreaterThan(0);
    expect(within(selectedAudit).queryByText("Source evidence")).not.toBeInTheDocument();
    const sourceSpanDetails = selectedAudit.querySelector(".resume-pin-source-span-details");
    expect(sourceSpanDetails).toBeInTheDocument();
    expect(sourceSpanDetails).not.toHaveAttribute("open");
    expect(within(selectedAudit).getByText("Built platform services.")).not.toBeVisible();
    expect(screen.getByText("Artifact-level grounding and claim risk")).toBeInTheDocument();
    expect(within(selectedAudit).queryByText("Audit metadata gaps")).not.toBeInTheDocument();
    expect(
      screen.getAllByText("Tailoring audit metadata incomplete: missing profile evidence mapping").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Built platform services.").length).toBeGreaterThan(0);
  });

  it("falls back to a line-by-line resume audit when generation provenance is missing", async () => {
    const artifact = vi.fn(async (artifactId: string) => ({
      ok: true as const,
      artifact: {
        ...sampleArtifact,
        artifactId,
        jobKey: sampleApplyReviewQueue.items[0]!.jobKey,
        title: "Principal Platform Engineer Resume",
        company: sampleApplyReviewQueue.items[0]!.company,
      },
      tailoringExplanation: null,
    }));

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => sampleApplyReviewQueue),
          artifact,
        },
      }),
    });

    expect(await screen.findByRole("img", { name: "Tailored resume PDF" })).toBeInTheDocument();
    await waitFor(() => expect(artifact).toHaveBeenCalledWith("resume-text-2"));
    expect(artifact).not.toHaveBeenCalledWith("resume-pdf-2");
    const pdfReviewSurface = screen.getByRole("region", { name: "PDF resume line review" });
    expect(pdfReviewSurface).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Rendered resume line review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Rendered resume text lines" })).not.toBeInTheDocument();
    expect(within(pdfReviewSurface).getAllByRole("button")).toHaveLength(3);
    const pdfLineOne = within(pdfReviewSurface).getByRole("button", {
      name: "Line 1: Principal Platform Engineer",
    });
    const pdfLineThree = within(pdfReviewSurface).getByRole("button", {
      name: "Line 3: Owned platform reliability improvements for incident response.",
    });
    expect(pdfLineOne).toHaveTextContent("");
    await waitFor(() => expect(pdfLineOne).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("region", { name: "Line-by-line resume audit" })).toBeInTheDocument();
    expect(screen.getByText(/No generation-time provenance was recorded/i)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Resume audit line list" })).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: /Selected resume line audit for line 1/i })).toBeInTheDocument();
    fireEvent.click(pdfLineThree);
    await waitFor(() => expect(pdfLineThree).toHaveAttribute("aria-pressed", "true"));
    expect(pdfLineOne).toHaveAttribute("aria-pressed", "false");
    const selectedAudit = await screen.findByRole("article", { name: /Selected resume line audit for line 3/i });
    expect(screen.getAllByText("missing source").length).toBeGreaterThan(0);
    expect(within(selectedAudit).getByText("No source mapping was recorded for this rendered resume line.")).toBeInTheDocument();
    fireEvent.click(pdfLineOne);
    await waitFor(() => expect(pdfLineOne).toHaveAttribute("aria-pressed", "true"));
    expect(pdfLineThree).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("article", { name: /Selected resume line audit for line 1/i })).toBeInTheDocument();
  });

  it("opens PDF-only skills lines in the same evidence inspector", async () => {
    const explanationWithSkillProvenance: ArtifactTailoringExplanation = {
      ...sampleTailoringExplanation,
      bulletProvenance: [
        {
          bulletId: "skills:platform_and_cloud#0",
          section: "skills",
          sourceId: "platform_and_cloud",
          evidenceIds: ["skills_platform_and_cloud"],
          sourceText: ["Platform & Cloud: Kubernetes, Docker, GCP, AWS"],
          requirementIds: [],
          matchedKeywords: ["kubernetes"],
          transformType: "verbatim",
          control: "verified_only",
          rationale: "Skill category is preserved from the profile skill source line.",
          generatedText: "Platform & Cloud: Kubernetes, Docker, GCP, AWS",
        },
      ],
    };
    const artifact = vi.fn(async (artifactId: string) => ({
      ok: true as const,
      artifact: {
        ...sampleArtifact,
        artifactId,
        jobKey: sampleApplyReviewQueue.items[0]!.jobKey,
        title: "Principal Platform Engineer Resume",
        company: sampleApplyReviewQueue.items[0]!.company,
      },
      tailoringExplanation: explanationWithSkillProvenance,
    }));

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => sampleApplyReviewQueue),
          artifact,
        },
      }),
    });

    await waitFor(() => expect(artifact).toHaveBeenCalledWith("resume-text-2"));
    const pdfReviewSurface = screen.getByRole("region", { name: "PDF resume line review" });
    const pdfOnlySkillLine = within(pdfReviewSurface).getByRole("button", {
      name: "PDF page 3 line 15: Platform & Cloud: Kubernetes, Docker, GCP",
    });

    fireEvent.click(pdfOnlySkillLine);

    await waitFor(() => expect(pdfOnlySkillLine).toHaveAttribute("aria-pressed", "true"));
    const selectedAudit = await screen.findByRole("article", {
      name: /Selected resume line audit for PDF page 3 line 15/i,
    });
    expect(within(selectedAudit).getByText("Line justification")).toBeInTheDocument();
    expect(within(selectedAudit).getByText("Platform & Cloud: Kubernetes, Docker, GCP")).toBeInTheDocument();
    expect(within(selectedAudit).getByText("Original source line")).toBeInTheDocument();
    const selectedJustification = selectedAudit.querySelector(".resume-pin-justification") as HTMLElement;
    expect(within(selectedJustification).getByText("Platform & Cloud: Kubernetes, Docker, GCP, AWS")).toBeVisible();
    expect(within(selectedAudit).queryByText("Evidence basis")).not.toBeInTheDocument();
    expect(within(selectedAudit).getAllByText("PDF page 3 line 15").length).toBeGreaterThan(0);
    expect(within(selectedAudit).queryByText("missing source")).not.toBeInTheDocument();
    expect(within(selectedAudit).getByText(/Skill category is preserved/i)).toBeInTheDocument();
    expect(within(selectedAudit).queryByText("Evidence IDs")).not.toBeInTheDocument();
    expect(within(selectedAudit).queryByText("Requirement IDs")).not.toBeInTheDocument();
    expect(within(selectedAudit).queryByText("Source ID")).not.toBeInTheDocument();
    expect(within(selectedAudit).queryByText("Controls")).not.toBeInTheDocument();
    expect(within(selectedAudit).queryByText("Transform")).not.toBeInTheDocument();
  });

  it("feeds resume text line targets into the PDF audit viewer", async () => {
    const queueWithModernCvResumeText = {
      ...sampleApplyReviewQueue,
      items: sampleApplyReviewQueue.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              materialsPreview: {
                ...item.materialsPreview,
                resumeText: [
                  "Eloi Barti Tremoleda",
                  "eloibarti@gmail.com | (+34) 611-682-399 | https://eloibarti.com | https://linkedin.com/in/ebarti",
                  "",
                  "EXECUTIVE PROFILE",
                  "Engineering Director with 12+ years of experience.",
                  "",
                  "EXPERIENCE",
                  "Director of Engineering / Acting CISO | Welltech",
                  "Barcelona, Spain (Remote) | Mar 2024 -- Present",
                  "- Rebuilt engineering and IT organizations to 30+ engineers.",
                  "",
                  "EDUCATION",
                  "Master's Degree in Aerospace and Mechanical Engineering",
                  "Illinois Institute of Technology (IIT) | Chicago, IL | Aug 2014",
                  "",
                  "SKILLS",
                  "Platform & Cloud: Kubernetes, Docker, GCP",
                ].join("\n"),
              },
            }
          : item,
      ),
    };

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => queueWithModernCvResumeText),
        },
      }),
    });

    await screen.findByRole("img", { name: "Tailored resume PDF" });
    const pdfReviewSurface = screen.getByRole("region", { name: "PDF resume line review" });
    const experienceCompanyButton = within(pdfReviewSurface).getByRole("button", {
      name: "Line 8: Director of Engineering / Acting CISO | Welltech",
    });
    expect(experienceCompanyButton).toHaveTextContent("");
    expect(
      within(pdfReviewSurface).getByRole("button", {
        name: "Line 9: Barcelona, Spain (Remote) | Mar 2024 -- Present",
      }),
    ).toBeInTheDocument();
    expect(
      within(pdfReviewSurface).getByRole("button", {
        name: "Line 13: Master's Degree in Aerospace and Mechanical Engineering",
      }),
    ).toBeInTheDocument();
    expect(
      within(pdfReviewSurface).getByRole("button", {
        name: "Line 17: Platform & Cloud: Kubernetes, Docker, GCP",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Rendered resume line review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Rendered resume text lines" })).not.toBeInTheDocument();
  });

  it("opens job detail as an in-place overlay", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ApplyReviewView />);

    await user.click(
      await screen.findByRole("button", {
        name: /Open job detail for Principal Platform Engineer/i,
      }),
    );

    expect(
      screen.getByRole("dialog", {
        name: `Job details for ${sampleApplyReviewQueue.items[0]!.jobKey}`,
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "close details" }));

    expect(
      screen.queryByRole("dialog", {
        name: `Job details for ${sampleApplyReviewQueue.items[0]!.jobKey}`,
      }),
    ).not.toBeInTheDocument();
  });

  it("renders non-pending review decisions as user-facing copy", async () => {
    const approvedQueue = {
      ...sampleApplyReviewQueue,
      items: sampleApplyReviewQueue.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              review: {
                state: "approved_submit" as const,
                decision: "approve_submit" as const,
                decidedAt: "2026-05-06T08:30:00Z",
              },
            }
          : item,
      ),
    };

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => approvedQueue),
        },
      }),
    });

    expect(await screen.findByText(/Current decision: Approved for submit/i)).toBeInTheDocument();
    expect(screen.queryByText(/approved_submit/i)).not.toBeInTheDocument();
  });

  it("shows a stop control for the selected in-flight apply run", async () => {
    const runningQueue = {
      ...sampleApplyReviewQueue,
      items: sampleApplyReviewQueue.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              latestApplyRun: {
                runId: "apply-running-1",
                status: "in_progress" as const,
                result: null,
                dryRun: false,
                startedAt: "2026-05-30T06:33:32Z",
                finishedAt: null,
              },
            }
          : item,
      ),
    };

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => runningQueue),
        },
      }),
    });

    expect(
      await screen.findByRole("button", {
        name: /Stop apply run for Principal Platform Engineer/i,
      }),
    ).toBeInTheDocument();
  });

  it("hides submit approval until a dry run has completed", async () => {
    const noDryRunQueue = {
      ...sampleApplyReviewQueue,
      items: sampleApplyReviewQueue.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              latestApplyRun: null,
            }
          : item,
      ),
    };

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => noDryRunQueue),
        },
      }),
    });

    expect(
      await screen.findByRole("button", {
        name: /Approve dry run for Principal Platform Engineer/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /Approve submit for Principal Platform Engineer/i,
      }),
    ).not.toBeInTheDocument();
  });

  it("renders the verbatim job post markdown without injecting raw html", async () => {
    const markdownQueue = {
      ...sampleApplyReviewQueue,
      items: sampleApplyReviewQueue.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              position: {
                ...item.position,
                descriptionPreview: [
                  "**Welcome to the good side of tech 👋**",
                  "Build [patient workflows](https://example.com) with `SDLC` discipline.",
                  "",
                  "- Lead engineering teams",
                  "- Improve platform reliability",
                  "",
                  "<script>alert('xss')</script>",
                ].join("\n"),
              },
            }
          : item,
      ),
    };

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => markdownQueue),
        },
      }),
    });

    expect(
      await screen.findByRole("heading", { name: "Welcome to the good side of tech 👋" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "patient workflows" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
    expect(screen.getByText("SDLC")).toBeInTheDocument();
    const verbatimJobPost = screen.getByRole("heading", { name: "Verbatim job post" }).closest("section");
    expect(verbatimJobPost).not.toBeNull();
    expect(within(verbatimJobPost!).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("<script>alert('xss')</script>")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
  });

  it("explains repair status with the latest apply failure reason", async () => {
    const repairQueue = {
      ...sampleApplyReviewQueue,
      items: sampleApplyReviewQueue.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              currentState: "failed" as const,
              latestApplyRun: {
                runId: "submit-failed",
                status: "failed",
                result: "SKIPPED: process killed by signal",
                dryRun: false,
                startedAt: "2026-05-30T06:33:32Z",
                finishedAt: "2026-05-30T06:40:29Z",
              },
              applyAudit: makeApplyAudit({
                state: "repair",
                label: "submit failed",
                summary: "Last submit failed: process killed by signal. Review evidence is still available.",
                hardBlockers: [
                  {
                    code: "apply_run_failed",
                    label: "submit failed",
                    detail: "Last submit failed: process killed by signal.",
                    severity: "blocking",
                    source: "apply_run",
                  },
                ],
              }),
              blockers: ["SKIPPED: process killed by signal"],
            }
          : item,
      ),
    };

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => repairQueue),
        },
      }),
    });

    expect((await screen.findAllByText(/Submit failed: process killed by signal/i)).length).toBeGreaterThan(0);
    expect(screen.getAllByText("submit failed").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Last submit failed: process killed by signal/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("needs repair")).not.toBeInTheDocument();
  });

  it("renders canonical audit facts for missing apply-review source data", async () => {
    const missingSourceQueue = {
      ...sampleApplyReviewQueue,
      items: sampleApplyReviewQueue.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              applyAudit: makeApplyAudit({
                state: "blocked",
                label: "missing apply link",
                summary: "No application or posting URL is recorded, so apply review cannot proceed.",
                hardBlockers: [
                  {
                    code: "missing_application_url",
                    label: "Missing apply link",
                    detail: "No application or posting URL is recorded, so apply review cannot proceed.",
                    severity: "blocking",
                    source: "application_url",
                  },
                ],
                sources: [
                  {
                    kind: "application_url",
                    label: "Application target",
                    status: "missing",
                    detail: "No application or posting URL is recorded.",
                  },
                  {
                    kind: "score_eligibility",
                    label: "Score eligibility",
                    status: "unknown",
                    detail: "No score eligibility data is recorded.",
                  },
                ],
              }),
            }
          : item,
      ),
    };

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => missingSourceQueue),
        },
      }),
    });

    expect((await screen.findAllByText("missing apply link")).length).toBeGreaterThan(0);
    expect(
      screen.getByText("Missing apply link: No application or posting URL is recorded, so apply review cannot proceed."),
    ).toBeInTheDocument();
    expect(screen.getByText("Application target: missing: No application or posting URL is recorded.")).toBeInTheDocument();
    expect(screen.getByText("Score eligibility: unknown: No score eligibility data is recorded.")).toBeInTheDocument();
  });

  it("records approval without dispatching apply automation", async () => {
    const user = userEvent.setup();
    const decideApplyReview = vi.fn(async () => ({
      ok: true as const,
      decision: {
        decisionId: "decision-1",
        jobKey: "job-2",
        decision: "approve_submit" as const,
        reason: "approved",
        decidedBy: "user",
        decidedAt: "2026-05-06T08:30:00Z",
      },
    }));
    const applyJob = vi.fn();

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => sampleApplyReviewQueue),
          decideApplyReview,
          applyJob,
        },
      }),
    });

    await user.click(await screen.findByRole("button", { name: /approve submit for principal platform engineer/i }));

    await waitFor(() => expect(decideApplyReview).toHaveBeenCalledTimes(1));
    expect(decideApplyReview).toHaveBeenCalledWith(
      "job-2",
      expect.objectContaining({ decision: "approve_submit" }),
    );
    expect(applyJob).not.toHaveBeenCalled();
  });

  it("does not depend on outcome suggestions to render the queue route", async () => {
    const applicationOutcomes = vi.fn(async () => {
      throw new Error("outcomes unavailable");
    });
    const ports = buildTestPorts({
      api: {
        applyReviewQueue: vi.fn(async () => sampleApplyReviewQueue),
        applicationOutcomes,
      },
    });
    const harness = buildProviderHarness({ ports, withEventStream: true });
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/apply-review"] }),
      context: { ports, queryClient: harness.queryClient, tenantId: LOCAL_TENANT },
    });

    render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });

    expect((await screen.findAllByText("Principal Platform Engineer")).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("outcomes unavailable")).not.toBeInTheDocument();
    expect(applicationOutcomes).not.toHaveBeenCalled();
  });

  it("selects the review item requested by the route search job key", async () => {
    const ports = buildTestPorts({
      api: {
        applyReviewQueue: vi.fn(async () => sampleApplyReviewQueue),
      },
    });
    const harness = buildProviderHarness({ ports, withEventStream: true });
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/apply-review?jobKey=job-1"] }),
      context: { ports, queryClient: harness.queryClient, tenantId: LOCAL_TENANT },
    });

    render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });

    const queue = await screen.findByRole("complementary", { name: "Application review queue" });
    expect(within(queue).getByRole("button", { name: /Staff Software Engineer/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      await screen.findByRole("region", { name: "Review evidence for Staff Software Engineer" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Review evidence for Principal Platform Engineer" })).not.toBeInTheDocument();
  });
});
