import type {
  ApplyReviewDecisionRequest,
  ApplyReviewDecisionResponse,
  ArtifactTailoringExplanation,
  ResumeCommentThread,
  ResumeReviewCommentThreadSeedRequest,
  ResumeReviewDraft,
  ResumeReviewDraftRenderResponse,
  ResumeReviewDraftRevision,
  ResumeReviewEditDelta,
} from "@jobhunter/contracts";
import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyReviewKeys } from "../../contexts/operations/applyReviewKeys.js";
import { routeTree } from "../../routeTree.gen.js";
import {
  makeApplyAudit,
  sampleApplyReviewQueue,
  sampleArtifact,
  sampleResumeTemplateListResponse,
} from "../../test/fixtures/projections.js";
import { buildProviderHarness, createTestQueryClient, renderWithProviders } from "../../test/render.js";
import { buildTestPorts } from "../../test/testPorts.js";
import { ApplyReviewView } from "./ApplyReviewView.js";

let htmlPreviewResumeText = sampleApplyReviewQueue.items[0]!.materialsPreview.resumeText;

const TEST_RESUME_SECTION_HEADINGS = new Set([
  "core skills",
  "education",
  "executive profile",
  "experience",
  "languages",
  "professional profile",
  "profile",
  "projects",
  "skills",
  "summary",
  "technical skills",
]);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildPreviewHtmlFromText(text: string): string {
  let lineNumber = 0;
  let body = '<main class="resume-page" data-resume-page="1"><header class="resume-header">';
  const lines = text.split(/\r?\n/);
  const contentIndexes = lines.map((line, index) => (line.trim() ? index : -1)).filter((index) => index >= 0);
  const target = (semanticId: string, lineText: string, tag = "div", className = "resume-line"): string => {
    const clean = lineText.trim().replace(/^[-•○]\s+/, "");
    if (!clean) return "";
    lineNumber += 1;
    return `<${tag} class="${className}" data-resume-layout-target="${escapeHtml(semanticId)}" data-resume-line-number="${lineNumber}">${escapeHtml(clean)}</${tag}>`;
  };
  const isSection = (line: string) => {
    const trimmed = line.trim();
    const normalized = trimmed.toLowerCase().replace(/\s+/g, " ");
    return (
      (trimmed.length <= 48 && TEST_RESUME_SECTION_HEADINGS.has(normalized)) ||
      (trimmed.length <= 48 && /^[A-Z][A-Z\s&/]+$/.test(trimmed) && /[A-Z]/.test(trimmed))
    );
  };
  if (contentIndexes.length) {
    const first = contentIndexes[0]!;
    body += target("personal:full_name", lines[first]!, "h1", "resume-name");
    const second = contentIndexes[1];
    let startIndex = first + 1;
    if (second !== undefined && second === first + 1 && !isSection(lines[second]!)) {
      body += target("personal:contact", lines[second]!, "p", "resume-contact");
      startIndex = second + 1;
    }
    body += "</header>";
    let currentSection: string | null = null;
    let sectionOpen = false;
    let listOpen: "bullets" | "skills" | false = false;
    const closeList = () => {
      if (!listOpen) return;
      body += "</ul>";
      listOpen = false;
    };
    for (const rawLine of lines.slice(startIndex)) {
      const line = rawLine.trim();
      if (!line) {
        closeList();
        continue;
      }
      if (isSection(line)) {
        closeList();
        if (sectionOpen) body += "</section>";
        sectionOpen = true;
        currentSection = line.toLowerCase().replace(/\s+/g, " ");
        body += '<section class="resume-section">';
        body += target(`section:${line.toLowerCase().replace(/\s+/g, "_")}`, line, "h2", "resume-section-title");
        continue;
      }
      if (line.startsWith("- ") || line.startsWith("• ") || line.startsWith("○ ")) {
        if (listOpen !== "bullets") {
          closeList();
          body += '<ul class="resume-bullets">';
          listOpen = "bullets";
        }
        body += target(`line:${lineNumber + 1}`, line, "li");
        continue;
      }
      if ((currentSection === "skills" || currentSection === "technical skills" || currentSection === "core skills") && line.includes(":")) {
        if (listOpen !== "skills") {
          closeList();
          body += '<ul class="resume-skills-list">';
          listOpen = "skills";
        }
        const [rawLabel = "", values = ""] = line.split(/:(.*)/s);
        const label = rawLabel.trim();
        const clean = `${label}: ${values.trim()}`.trim();
        lineNumber += 1;
        body += `<li class="resume-skill-line" data-resume-layout-target="skills:line:${lineNumber}" data-resume-line-number="${lineNumber}"><b>${escapeHtml(label)}:</b> ${escapeHtml(values.trim())}</li>`;
        continue;
      }
      closeList();
      const className = line.includes(" | ") ? "resume-entry-heading" : "resume-line";
      body += target(`line:${lineNumber + 1}`, line, "p", className);
    }
    closeList();
    if (sectionOpen) body += "</section>";
  } else {
    body += "</header>";
  }
  body += "</main>";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 0; }
    body { margin: 0; font-family: "Avenir Next", "Aptos", "Helvetica Neue", Helvetica, Arial, sans-serif; color: #111; font-size: 10.35pt; line-height: 1.32; }
    .resume-page { inline-size: 210mm; min-block-size: 297mm; padding: 16.5mm 17.5mm 18mm; }
    .resume-header { text-align: center; margin-block-end: 4.5mm; }
    .resume-name { color: #111; font-size: 22pt; font-weight: 400; margin: 0 0 1.8mm; }
    .resume-contact { color: #111; font-size: 8.8pt; margin: 0; }
    .resume-section { margin-block-start: 4.1mm; }
    .resume-section-title { color: #111; font-size: 9.5pt; margin: 0 0 2.2mm; text-transform: uppercase; }
    .resume-bullets { list-style: disc outside; margin: 1.1mm 0 0 4.2mm; padding: 0; }
    .resume-bullets li { display: list-item; list-style: disc outside; }
    .resume-skills-list { list-style: none; margin: 1.1mm 0 0 0; padding: 0; }
  </style></head><body>${body}</body></html>`;
}

async function findResumeShadowRoot(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector(".resume-plate-document .resume-page")).toBeTruthy());
  return document.querySelector(".resume-plate-document") as HTMLElement;
}

function shadowText(shadow: HTMLElement): string {
  return shadow.textContent ?? "";
}

function shadowElementWithText(shadow: HTMLElement, text: string): HTMLElement {
  const element = Array.from(shadow.querySelectorAll<HTMLElement>("[data-resume-line-number]")).find((node) =>
    (node.textContent ?? "").includes(text),
  );
  if (!element) {
    throw new Error(`Expected shadow resume line containing "${text}"`);
  }
  return element;
}

async function selectResumeLine(shadow: HTMLElement, text: string): Promise<void> {
  await userEvent.click(shadowElementWithText(shadow, text));
  await waitFor(() => expect(shadowElementWithText(shadow, text).className).toContain("jobhunter-selected-line"));
}

function savedDraftPlateDocument(lineText = "Restored human rewrite for incident response.") {
  return [
    {
      type: "resume_block",
      tagName: "main",
      className: "resume-page",
      pageNumber: 1,
      semanticId: null,
      children: [
        {
          type: "resume_block",
          tagName: "h1",
          className: "resume-name",
          lineNumber: 1,
          pageNumber: 1,
          semanticId: "personal:full_name",
          children: [{ text: "Principal Platform Engineer" }],
        },
        {
          type: "resume_block",
          tagName: "section",
          className: "resume-section",
          pageNumber: 1,
          semanticId: null,
          children: [
            {
              type: "resume_block",
              tagName: "h2",
              className: "resume-section-title",
              lineNumber: 2,
              pageNumber: 1,
              semanticId: "section:experience",
              children: [{ text: "Experience" }],
            },
            {
              type: "resume_block",
              tagName: "li",
              className: "resume-line",
              lineNumber: 3,
              pageNumber: 1,
              semanticId: "experience:line:3",
              children: [{ text: lineText }],
            },
          ],
        },
      ],
    },
  ];
}

function savedDraftPlateDocumentWithEntryHeading() {
  return [
    {
      type: "resume_block",
      tagName: "main",
      className: "resume-page",
      pageNumber: 1,
      semanticId: null,
      children: [
        {
          type: "resume_block",
          tagName: "section",
          className: "resume-section",
          pageNumber: 1,
          semanticId: null,
          children: [
            {
              type: "resume_block",
              tagName: "div",
              className: "resume-entry-heading",
              lineNumber: 30,
              pageNumber: 1,
              semanticId: "experience:entry:datadog:heading",
              children: [
                { text: "" },
                {
                  type: "resume_inline",
                  tagName: "span",
                  className: "resume-entry-row resume-entry-company-row",
                  children: [
                    { text: "" },
                    {
                      type: "resume_inline",
                      tagName: "span",
                      className: "resume-entry-company",
                      children: [{ text: "Datadog" }],
                    },
                    { text: "" },
                    {
                      type: "resume_inline",
                      tagName: "span",
                      className: "resume-entry-location",
                      children: [{ text: "Barcelona, Spain" }],
                    },
                    { text: "" },
                  ],
                },
                { text: "" },
                {
                  type: "resume_inline",
                  tagName: "span",
                  className: "resume-entry-row resume-entry-role-row",
                  children: [
                    {
                      type: "resume_inline",
                      tagName: "span",
                      className: "resume-entry-title",
                      children: [{ text: "Security Customer Advisory Board Member" }],
                    },
                    {
                      type: "resume_inline",
                      tagName: "span",
                      className: "resume-entry-date",
                      children: [{ text: "Sep 2022 | Aug 2023" }],
                    },
                  ],
                },
                { text: "" },
              ],
            },
          ],
        },
      ],
    },
  ];
}

function makeResumeReviewDraft(
  jobKey = sampleApplyReviewQueue.items[0]!.jobKey,
  revision?: Partial<ResumeReviewDraftRevision> | null,
): ResumeReviewDraft {
  const latestRevision =
    revision === null
      ? null
      : {
          revisionId: "draft-revision-1",
          draftId: "draft-job-2",
          jobKey,
          revisionNumber: 1,
          editedText: "Principal Platform Engineer\nExperience\nRestored human rewrite for incident response.",
          plateDocument: savedDraftPlateDocument(),
          editDeltas: [],
          createdAt: "2026-06-24T10:00:00.000Z",
          ...revision,
        };
  return {
    draftId: latestRevision?.draftId ?? "draft-job-2",
    jobKey,
    baseGeneration: 1,
    baseResumeTextArtifactId: "resume-text-2",
    baseResumePdfArtifactId: "resume-pdf-2",
    rendererFormat: "html_css",
    state: "active",
    currentRevisionId: latestRevision?.revisionId ?? null,
    latestRevisionNumber: latestRevision?.revisionNumber ?? 0,
    createdAt: "2026-06-24T09:45:00.000Z",
    updatedAt: "2026-06-24T10:00:00.000Z",
    latestRevision,
    commentThreads: [],
    feedbackSignals: [],
  };
}

function makeResumeCommentThread(draftId = "draft-job-2"): ResumeCommentThread {
  return {
    threadId: "thread-claim-risk",
    draftId,
    jobKey: sampleApplyReviewQueue.items[0]!.jobKey,
    baseArtifactId: "resume-text-2",
    semanticId: "experience:line:3",
    lineAnchor: {
      semanticId: "experience:line:3",
      lineNumber: 3,
      pageNumber: 1,
      textHash: null,
    },
    sourcePinId: "pin-experience-claim",
    riskLabel: "claim risk",
    commentBody: "Check the quantified reliability claim against profile evidence.",
    state: "open",
    anchorResolved: true,
    createdAt: "2026-06-24T10:02:00.000Z",
    updatedAt: "2026-06-24T10:02:00.000Z",
    replies: [],
  };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  };
}

beforeEach(() => {
  htmlPreviewResumeText = sampleApplyReviewQueue.items[0]!.materialsPreview.resumeText;
  const originalFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      if (url.includes("/preview.html")) {
        return {
          ok: true,
          text: async () => buildPreviewHtmlFromText(htmlPreviewResumeText ?? ""),
        };
      }
      const draftRoute = url.match(/\/v1\/jobs\/([^/]+)\/resume-review\/draft/);
      if (draftRoute) {
        return jsonResponse({ ok: true, draft: makeResumeReviewDraft(decodeURIComponent(draftRoute[1]!), null) });
      }
      const revisionRoute = url.match(/\/v1\/resume-review\/drafts\/([^/]+)\/revisions/);
      if (revisionRoute) {
        const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {};
        const draft = makeResumeReviewDraft(sampleApplyReviewQueue.items[0]!.jobKey, {
          draftId: decodeURIComponent(revisionRoute[1]!),
          revisionId: "draft-revision-saved",
          editedText: typeof body.editedText === "string" ? body.editedText : "",
          plateDocument: body.plateDocument,
          editDeltas: (body.editDeltas ?? []) as ResumeReviewEditDelta[],
          revisionNumber: 1,
        });
        return jsonResponse({ ok: true, draft, revision: draft.latestRevision });
      }
      const seedThreadsRoute = url.match(/\/v1\/resume-review\/drafts\/([^/]+)\/comment-threads/);
      if (seedThreadsRoute) {
        const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : { threads: [] };
        const draft = {
          ...makeResumeReviewDraft(sampleApplyReviewQueue.items[0]!.jobKey, null),
          draftId: decodeURIComponent(seedThreadsRoute[1]!),
          commentThreads: (body.threads ?? []).map((thread: Record<string, unknown>, index: number) => ({
            threadId: `thread-${index + 1}`,
            draftId: decodeURIComponent(seedThreadsRoute[1]!),
            jobKey: sampleApplyReviewQueue.items[0]!.jobKey,
            baseArtifactId: typeof thread.baseArtifactId === "string" ? thread.baseArtifactId : null,
            semanticId: typeof thread.semanticId === "string" ? thread.semanticId : null,
            lineAnchor: thread.lineAnchor ?? null,
            sourcePinId: typeof thread.sourcePinId === "string" ? thread.sourcePinId : null,
            riskLabel: typeof thread.riskLabel === "string" ? thread.riskLabel : null,
            commentBody: typeof thread.commentBody === "string" ? thread.commentBody : "Seeded comment",
            state: "open",
            anchorResolved: true,
            createdAt: "2026-06-24T10:02:00.000Z",
            updatedAt: "2026-06-24T10:02:00.000Z",
            replies: [],
          })),
        };
        return jsonResponse({
          ok: true,
          draft,
          commentThreads: draft.commentThreads,
          seededCount: draft.commentThreads.length,
          updatedCount: 0,
        });
      }
      const renderRoute = url.match(/\/v1\/resume-review\/drafts\/([^/]+)\/render/);
      if (renderRoute) {
        const draft = {
          ...makeResumeReviewDraft(sampleApplyReviewQueue.items[0]!.jobKey, {
            draftId: decodeURIComponent(renderRoute[1]!),
            revisionId: "draft-revision-saved",
          }),
          state: "promoted" as const,
        };
        return jsonResponse({
          ok: true,
          draft,
          validation: { passed: true, errors: [], warnings: [] },
          artifacts: {
            resumeText: {
              artifactId: "resume-review-text",
              artifactType: "tailored_resume",
              generation: 3,
              renderFormat: "text",
            },
            resumePdf: {
              artifactId: "resume-review-pdf",
              artifactType: "resume_pdf",
              generation: 3,
              renderFormat: "html_pdf",
            },
          },
          layoutBoxCount: 3,
        });
      }
      return originalFetch(input, init);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

vi.mock("../../shared/ui/PdfPreviewViewer.js", () => ({
  PdfPreviewViewer: ({ title, url }: { title: string; url: string }) => (
    <div aria-label={title} data-url={url} role="img">
      PDF preview
    </div>
  ),
  PdfAuditPreviewViewer: ({
    layoutBoxes = [],
    lineTargets,
    onSelectLine,
    onSelectLineNumber,
    selectedLineKey,
    selectedLineNumber,
    title,
    url,
  }: {
    readonly layoutBoxes?: readonly unknown[];
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
    const pdfOnlyProfileLine = {
      lineKey: "pdf:1:2:Jordan Candidate",
      pageLineIndex: 2,
      pageNumber: 1,
      text: "Jordan Candidate",
    };
    return (
      <div>
        <div aria-label={title} data-url={url} role="img">
          PDF preview
        </div>
        <span data-testid="pdf-layout-box-count">{layoutBoxes.length}</span>
        <div aria-label="Resume selectable lines">
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
          <button
            aria-label={`PDF page ${pdfOnlyProfileLine.pageNumber} line ${pdfOnlyProfileLine.pageLineIndex}: ${pdfOnlyProfileLine.text}`}
            aria-pressed={selectedLineKey === pdfOnlyProfileLine.lineKey}
            type="button"
            onClick={() => {
              onSelectLine?.({
                lineKey: pdfOnlyProfileLine.lineKey,
                lineNumber: null,
                pageLineIndex: pdfOnlyProfileLine.pageLineIndex,
                pageNumber: pdfOnlyProfileLine.pageNumber,
                resumeLineText: null,
                text: pdfOnlyProfileLine.text,
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
    expect(screen.getByText("Ideal profile from job post")).toBeInTheDocument();
    expect(screen.getByText(/principal engineer who can lead platform reliability/i)).toBeInTheDocument();
    expect(screen.getByText("Job needs from posting")).toBeInTheDocument();
    expect(screen.getByText("Lead platform reliability improvements across critical services.")).toBeInTheDocument();
    expect(screen.getAllByText("Candidate fit").length).toBeGreaterThan(0);
    expect(screen.getByText("matched direct")).toBeInTheDocument();
    expect(screen.getByText("transferable")).toBeInTheDocument();
    expect(screen.getAllByText("Tailoring action").length).toBeGreaterThan(0);
    expect(screen.getByText("double down")).toBeInTheDocument();
    expect(screen.getByText("bridge gap")).toBeInTheDocument();
    expect(screen.getAllByText("Resume coverage").length).toBeGreaterThan(0);
    expect(screen.getByText("covered in tailored resume")).toBeInTheDocument();
    expect(screen.getByText("missing from tailored resume")).toBeInTheDocument();
    expect(screen.getByText("2 resume bullets")).toBeInTheDocument();
    expect(
      screen.getByText(/Tailored resume evidence: Owned platform reliability improvements/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Why fit score is 9/10")).toBeInTheDocument();
    expect(screen.getByText("Strong fit on platform reliability.")).toBeInTheDocument();
    expect(screen.getByText("Technical fit")).toBeInTheDocument();
    expect(screen.getByText("Experience fit")).toBeInTheDocument();
    expect(screen.getByText("Role fit")).toBeInTheDocument();
    expect(screen.getByText("Numeric basis: weighted dimension score 8.1/10 with no adjustment.")).toBeInTheDocument();
    expect(screen.getByText("Profile evidence matched by scorer")).toBeInTheDocument();
    expect(screen.getByText("Profile gaps found by scorer")).toBeInTheDocument();
    expect(screen.getByText("Transferable profile evidence")).toBeInTheDocument();
    expect(screen.getByText("Job keywords used by scorer")).toBeInTheDocument();
    expect(screen.queryByText("Matched")).not.toBeInTheDocument();
    expect(screen.queryByText("Keywords")).not.toBeInTheDocument();
    expect(screen.queryByText(/signals/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Derived from existing scoring evidence/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Evidence groups/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Dry run completed/i)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Compensation" })).toBeInTheDocument();
    expect(screen.getByText("EUR 112000-142000/year")).toBeInTheDocument();
    expect(screen.getByText("reported company-role market")).toBeInTheDocument();
    expect(screen.getByText(/market confidence medium/i)).toBeInTheDocument();
    expect(screen.getByText(/2 sources/i)).toBeInTheDocument();
    expect(screen.getByText(/7 samples/i)).toBeInTheDocument();
    expect(screen.queryByText(/dry_run/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Globex needs a principal engineer/i)).toBeInTheDocument();
    const detailButton = screen.getByRole("button", {
      name: /Open job detail for Principal Platform Engineer/i,
    });
    expect(detailButton).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open job detail/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Tailored resume preview" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Tailored resume preview editor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Italic" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Underline" })).toBeInTheDocument();
    expect(screen.getByLabelText("Font")).toBeInTheDocument();
    expect(screen.getByLabelText("Size")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Align left" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Align center" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Align right" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "open final file" }).getAttribute("href")).toContain(
      "/v1/artifacts/resume-pdf-2/preview.pdf",
    );
    const shadow = await findResumeShadowRoot();
    const comments = shadow.querySelectorAll('[aria-label="JobHunter resume comment"]');
    expect(comments.length).toBeGreaterThan(0);
    comments.forEach((comment) => {
      expect(comment).toHaveAttribute("contenteditable", "false");
      expect(comment).toHaveAttribute("data-resume-editor-chrome", "true");
    });
    expect(screen.queryByText("Recruiter reply indicates an interview request.")).not.toBeInTheDocument();
  });

  it("assigns a resume template override for the selected job", async () => {
    const jobKey = sampleApplyReviewQueue.items[0]!.jobKey;
    const setJobResumeTemplate = vi.fn(async (_jobKey: string, body: { templateId?: string | null }) => ({
      ok: true as const,
      jobKey,
      effectiveTemplate: {
        ...sampleResumeTemplateListResponse.builtInDefault,
        templateId: body.templateId ?? sampleResumeTemplateListResponse.builtInDefault.templateId,
        assignmentSource: body.templateId ? ("job_override" as const) : ("built_in" as const),
      },
      overrideTemplate: body.templateId
        ? {
            ...sampleResumeTemplateListResponse.builtInDefault,
            templateId: body.templateId,
            assignmentSource: "job_override" as const,
          }
        : null,
      templateState: null,
    }));

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: { setJobResumeTemplate },
      }),
    });

    await userEvent.selectOptions(await screen.findByLabelText("Resume template"), "built_in:modern-html");

    await waitFor(() =>
      expect(setJobResumeTemplate).toHaveBeenCalledWith(jobKey, {
        templateId: "built_in:modern-html",
        versionId: null,
      }),
    );
  });

  it("restores the latest saved resume review draft in the Plate editor", async () => {
    const draft = makeResumeReviewDraft(sampleApplyReviewQueue.items[0]!.jobKey, {
      editedText: "Principal Platform Engineer\nExperience\nRestored human rewrite for incident response.",
      plateDocument: savedDraftPlateDocument("Restored human rewrite for incident response."),
    });
    const createResumeReviewDraft = vi.fn(async () => ({ ok: true as const, draft }));

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => sampleApplyReviewQueue),
          createResumeReviewDraft,
        },
      }),
    });

    const shadow = await findResumeShadowRoot();
    expect(shadowText(shadow)).toContain("Restored human rewrite for incident response.");
    expect(shadowText(shadow)).not.toContain("Owned platform reliability improvements for incident response.");
    await waitFor(() =>
      expect(createResumeReviewDraft).toHaveBeenCalledWith(
        sampleApplyReviewQueue.items[0]!.jobKey,
        expect.objectContaining({
          rendererFormat: "html_css",
          resumePdfArtifactId: "resume-pdf-2",
          resumeTextArtifactId: "resume-text-2",
        }),
      ),
    );
    expect(screen.getByRole("button", { name: "save draft" })).toBeDisabled();
    expect(screen.getByText("saved revision 1")).toBeInTheDocument();
  });

  it("normalizes saved entry heading rows so editing does not add spacer grid tracks", async () => {
    const draft = makeResumeReviewDraft(sampleApplyReviewQueue.items[0]!.jobKey, {
      editedText:
        "Datadog Barcelona, Spain\nSecurity Customer Advisory Board Member Sep 2022 | Aug 2023",
      plateDocument: savedDraftPlateDocumentWithEntryHeading(),
    });

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => sampleApplyReviewQueue),
          createResumeReviewDraft: vi.fn(async () => ({ ok: true as const, draft })),
        },
      }),
    });

    const shadow = await findResumeShadowRoot();
    const heading = shadowElementWithText(shadow, "Datadog");
    const rows = Array.from(heading.querySelectorAll<HTMLElement>(".resume-entry-row"));

    expect(rows).toHaveLength(2);
    rows.forEach((row) => {
      expect(row.tagName).toBe("DIV");
      expect(row.querySelectorAll(':scope > [data-slate-node="text"]')).toHaveLength(0);
    });
    expect(rows[0]!.children[0]).toHaveClass("resume-entry-company");
    expect(rows[0]!.children[1]).toHaveClass("resume-entry-location");
    expect(rows[1]!.children[0]).toHaveClass("resume-entry-title");
    expect(rows[1]!.children[1]).toHaveClass("resume-entry-date");
  });

  it("keeps editor focus while typing multiple characters", async () => {
    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => sampleApplyReviewQueue),
        },
      }),
    });

    const editor = await screen.findByRole("textbox", { name: "Tailored resume preview editor" });
    await userEvent.click(editor);
    await userEvent.type(editor, "xy");

    expect(screen.getByRole("textbox", { name: "Tailored resume preview editor" })).toBe(editor);
    expect(editor).toBeInTheDocument();
    expect(editor).toHaveFocus();
  });

  it("scopes resume editor font and size formatting to all lines or the selected line", async () => {
    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => sampleApplyReviewQueue),
        },
      }),
    });

    const shadow = await findResumeShadowRoot();
    const nameLine = shadowElementWithText(shadow, "Principal Platform Engineer");
    const bodyLine = shadowElementWithText(shadow, "Owned platform reliability improvements for incident response.");

    await waitFor(() => expect(nameLine.className).toContain("jobhunter-selected-line"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(nameLine.className).not.toContain("jobhunter-selected-line"));

    await userEvent.selectOptions(screen.getByLabelText("Font"), "garamond");
    await waitFor(() => expect(nameLine.style.fontFamily).toContain("Garamond"));
    expect(bodyLine.style.fontFamily).toContain("Garamond");

    await selectResumeLine(shadow, "Owned platform reliability improvements for incident response.");
    await userEvent.selectOptions(screen.getByLabelText("Font"), "helvetica");
    await waitFor(() => expect(bodyLine.style.fontFamily).toContain("Helvetica"));
    expect(nameLine.style.fontFamily).toContain("Garamond");

    const sizeInput = screen.getByLabelText("Size");
    await userEvent.clear(sizeInput);
    fireEvent.change(sizeInput, { target: { value: "1.1" } });
    fireEvent.blur(sizeInput);
    await waitFor(() =>
      expect(shadowElementWithText(shadow, "Owned platform reliability improvements for incident response.").style.fontSize).toBe(
        "1.1em",
      ),
    );
    expect(shadowElementWithText(shadow, "Principal Platform Engineer").style.fontSize).toBe("");

    await userEvent.click(document.body);
    await waitFor(() =>
      expect(
        shadowElementWithText(shadow, "Owned platform reliability improvements for incident response.").className,
      ).not.toContain("jobhunter-selected-line"),
    );
  });

  it("keeps the cached resume review draft visible while create/load is pending", async () => {
    const jobKey = sampleApplyReviewQueue.items[0]!.jobKey;
    const draft = makeResumeReviewDraft(jobKey, {
      editedText: "Principal Platform Engineer\nExperience\nRestored human rewrite for incident response.",
      plateDocument: savedDraftPlateDocument("Restored human rewrite for incident response."),
    });
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(applyReviewKeys.draft(LOCAL_TENANT, jobKey), { ok: true, draft });
    const createResumeReviewDraft = vi.fn(
      (): Promise<{ ok: true; draft: ResumeReviewDraft }> => new Promise(() => {}),
    );

    renderWithProviders(<ApplyReviewView />, {
      queryClient,
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => sampleApplyReviewQueue),
          createResumeReviewDraft,
        },
      }),
    });

    const shadow = await findResumeShadowRoot();
    expect(shadowText(shadow)).toContain("Restored human rewrite for incident response.");
    expect(screen.getByText("saved revision 1")).toBeInTheDocument();
    expect(screen.queryByText("loading draft")).not.toBeInTheDocument();
    expect(createResumeReviewDraft).toHaveBeenCalled();
  });

  it("renders a saved draft automatically when approval is requested", async () => {
    const draft = makeResumeReviewDraft(sampleApplyReviewQueue.items[0]!.jobKey, {
      editedText: "Principal Platform Engineer\nExperience\nRestored human rewrite for incident response.",
      plateDocument: savedDraftPlateDocument("Restored human rewrite for incident response."),
    });
    const promotedDraft: ResumeReviewDraft = {
      ...draft,
      state: "promoted",
      updatedAt: "2026-06-24T10:10:00.000Z",
    };
    const renderResponse = {
      ok: true as const,
      draft: promotedDraft,
      validation: { passed: true, errors: [], warnings: [] },
      artifacts: {
        resumeText: {
          artifactId: "resume-review-text",
          artifactType: "tailored_resume" as const,
          generation: 3,
          renderFormat: "text" as const,
        },
        resumePdf: {
          artifactId: "resume-review-pdf",
          artifactType: "resume_pdf" as const,
          generation: 3,
          renderFormat: "html_pdf" as const,
        },
      },
      layoutBoxCount: 3,
    } satisfies Extract<ResumeReviewDraftRenderResponse, { ok: true }>;
    let resolveRender: ((response: typeof renderResponse) => void) | null = null;
    const renderResumeReviewDraft = vi.fn(
      () =>
        new Promise<typeof renderResponse>((resolve) => {
          resolveRender = resolve;
        }),
    );
    const decideApplyReview = vi.fn(
      async (jobKey: string, body: ApplyReviewDecisionRequest): Promise<ApplyReviewDecisionResponse> => ({
        ok: true,
        decision: {
          decisionId: "decision-rendered-draft",
          jobKey,
          decision: body.decision,
          reason: body.reason ?? null,
          decidedBy: body.decidedBy,
          decidedAt: "2026-06-24T10:15:00.000Z",
        },
      }),
    );

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => sampleApplyReviewQueue),
          createResumeReviewDraft: vi.fn(async () => ({ ok: true as const, draft })),
          decideApplyReview,
          renderResumeReviewDraft,
          seedResumeReviewCommentThreads: vi.fn(async () => ({
            ok: true as const,
            draft,
            commentThreads: [],
            seededCount: 0,
            updatedCount: 0,
          })),
        },
      }),
    });

    await findResumeShadowRoot();
    const approveDryRun = screen.getByRole("button", { name: /Approve dry run/i });
    await waitFor(() => expect(approveDryRun).not.toBeDisabled());
    expect(screen.getByText("Saved draft will render automatically before approval.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Defer for Principal Platform Engineer/i })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /Decline for Principal Platform Engineer/i })).not.toBeDisabled();

    await userEvent.click(approveDryRun);
    await waitFor(() => expect(renderResumeReviewDraft).toHaveBeenCalledWith(draft.draftId, {
      draftRevisionId: draft.currentRevisionId,
    }));
    expect(approveDryRun).toBeDisabled();
    expect(approveDryRun).toHaveTextContent("Rendering");

    expect(resolveRender).not.toBeNull();
    resolveRender!(renderResponse);
    await waitFor(() =>
      expect(decideApplyReview).toHaveBeenCalledWith(sampleApplyReviewQueue.items[0]!.jobKey, {
        decision: "approve_dry_run",
        reason: "Approved for dry-run validation from the review queue.",
        decidedBy: "user",
      }),
    );
    expect(screen.queryByText("Saved draft will render automatically before approval.")).not.toBeInTheDocument();
  });

  it("lets the user reply to a persisted JobHunter line comment without hiding source context", async () => {
    const draft: ResumeReviewDraft = {
      ...makeResumeReviewDraft(sampleApplyReviewQueue.items[0]!.jobKey, {
        editedText: "Principal Platform Engineer\nExperience\nRestored human rewrite for incident response.",
        plateDocument: savedDraftPlateDocument("Restored human rewrite for incident response."),
      }),
      commentThreads: [makeResumeCommentThread()],
    };
    const repliedThread: ResumeCommentThread = {
      ...draft.commentThreads[0]!,
      state: "user_replied",
      replies: [
        {
          replyId: "reply-1",
          threadId: "thread-claim-risk",
          draftRevisionId: draft.currentRevisionId,
          author: "user",
          decision: "clarified",
          body: "This number is supported by the incident response profile bullet.",
          createdAt: "2026-06-24T10:12:00.000Z",
        },
      ],
    };
    const replyToResumeReviewComment = vi.fn(async () => ({
      ok: true as const,
      thread: repliedThread,
      reply: repliedThread.replies[0]!,
      feedbackSignal: {
        signalId: "resume-feedback-1",
        jobKey: draft.jobKey,
        draftId: draft.draftId,
        draftRevisionId: draft.currentRevisionId,
        sourceKind: "comment_reply" as const,
        sourceId: "reply-1",
        kind: "factual_correction" as const,
        status: "candidate" as const,
        summary: "This number is supported by the incident response profile bullet.",
        section: null,
        semanticId: "experience:line:3",
        createdAt: "2026-06-24T10:12:00.000Z",
        reviewedAt: null,
      },
    }));

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => sampleApplyReviewQueue),
          createResumeReviewDraft: vi.fn(async () => ({ ok: true as const, draft })),
          replyToResumeReviewComment,
          seedResumeReviewCommentThreads: vi.fn(async () => ({
            ok: true as const,
            draft,
            commentThreads: draft.commentThreads,
            seededCount: 0,
            updatedCount: 1,
          })),
        },
      }),
    });

    await screen.findByText("Check the quantified reliability claim against profile evidence.");
    expect(screen.getByText("claim risk")).toBeInTheDocument();
    expect(screen.getByText("Source pin: pin-experience-claim")).toBeInTheDocument();

    const replyBox = screen.getAllByLabelText("Reply")[0]!;
    await userEvent.type(replyBox, "This number is supported by the incident response profile bullet.");
    await userEvent.click(screen.getAllByRole("button", { name: "reply" })[0]!);

    await waitFor(() =>
      expect(replyToResumeReviewComment).toHaveBeenCalledWith("thread-claim-risk", {
        author: "user",
        body: "This number is supported by the incident response profile bullet.",
        decision: "clarified",
        draftRevisionId: draft.currentRevisionId,
      }),
    );
    await screen.findByText("This number is supported by the incident response profile bullet.");
    expect(screen.getByText("Source pin: pin-experience-claim")).toBeInTheDocument();
  });

  it("distinguishes pre-tailor profile gaps from accepted-resume coverage gaps", async () => {
    const queue = {
      ...sampleApplyReviewQueue,
      items: sampleApplyReviewQueue.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              position: {
                ...item.position,
                idealRequirements: item.position.idealRequirements.map((requirement, requirementIndex) => ({
                  ...requirement,
                  coverage: {
                    ...requirement.coverage,
                    state:
                      requirementIndex === 0
                        ? ("missing_from_resume" as const)
                        : ("missing_from_profile" as const),
                    bulletCount: 0,
                    examples: [],
                  },
                })),
              },
            }
          : item,
      ),
    };

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => queue),
        },
      }),
    });

    expect(await screen.findByText("missing from tailored resume")).toBeInTheDocument();
    expect(screen.getByText("missing from profile")).toBeInTheDocument();
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
      layoutBoxes: [],
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

    await screen.findByRole("region", { name: "Tailored resume preview" });
    const shadow = await findResumeShadowRoot();
    expect(screen.queryByRole("region", { name: "Line-by-line resume audit" })).not.toBeInTheDocument();
    expect(shadow.querySelectorAll('[aria-label="JobHunter resume comment"]').length).toBeGreaterThan(0);
    await selectResumeLine(shadow, "Owned platform reliability improvements for incident response.");
    await waitFor(() => expect(shadowText(shadow)).toContain("Profile source field"));
    await waitFor(() => expect(shadowText(shadow)).toContain("Built platform services"));
    await waitFor(() =>
      expect(shadowText(shadow)).toMatch(/Experience was emphasized because it matches platform reliability/i),
    );
    const artifactRisk = screen.getByRole("region", { name: "Artifact-level grounding and claim risk" });
    const resumeAudit = screen.getByRole("region", { name: "Resume audit" });
    expect(artifactRisk.compareDocumentPosition(resumeAudit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("region", { name: "Tailored resume preview" })).not.toContainElement(artifactRisk);
    expect(screen.queryByText("Annotated resume changes")).not.toBeInTheDocument();
    expect(screen.queryByText("Tailoring rationale")).not.toBeInTheDocument();
    expect(screen.queryByText("join")).not.toBeInTheDocument();
    expect(shadowText(shadow)).toContain("Built platform services");
    await waitFor(() => expect(shadowText(shadow)).toMatch(/Signals reflected: platform reliability/i));
    expect(screen.getAllByText("High-fit review").length).toBeGreaterThan(0);
    expect(artifact).toHaveBeenCalledWith("resume-text-2");
    expect(artifact).not.toHaveBeenCalledWith("resume-pdf-2");
  });

  it("bounds generated comment seed identifiers for long profile source paths", async () => {
    const jobKey = sampleApplyReviewQueue.items[0]!.jobKey;
    const longFields = Array.from({ length: 8 }, (_, index) => ({
      path: `profile.contact.channels.${"nested_segment_".repeat(8)}${index}`,
      label: `Profile > Contact > Channel ${index + 1}`,
      value: `candidate-${index + 1}@example.com`,
      section: "profile_personal",
    }));
    const contactLine = longFields.map((field) => field.value).join(" • ");
    const queueWithLongProfilePaths = {
      ...sampleApplyReviewQueue,
      items: sampleApplyReviewQueue.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              materialsPreview: {
                ...item.materialsPreview,
                resumeText: `Principal Platform Engineer\n${contactLine}\nExperience\nOwned platform reliability improvements for incident response.`,
                profileSourceFields: longFields,
              },
            }
          : item,
      ),
    };
    htmlPreviewResumeText = queueWithLongProfilePaths.items[0]!.materialsPreview.resumeText;
    const draft = makeResumeReviewDraft(jobKey, null);
    const seedResumeReviewCommentThreads = vi.fn(
      async (_draftId: string, _body: ResumeReviewCommentThreadSeedRequest) => ({
        ok: true as const,
        draft,
        commentThreads: [],
        seededCount: 0,
        updatedCount: 0,
      }),
    );

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => queueWithLongProfilePaths),
          createResumeReviewDraft: vi.fn(async () => ({ ok: true as const, draft })),
          seedResumeReviewCommentThreads,
        },
      }),
    });

    await waitFor(() => expect(seedResumeReviewCommentThreads).toHaveBeenCalled());
    const [, body] = seedResumeReviewCommentThreads.mock.calls[0]!;
    expect(body.threads.length).toBeGreaterThan(0);
    for (const thread of body.threads) {
      expect(thread.baseArtifactId?.length ?? 0).toBeLessThanOrEqual(240);
      expect(thread.semanticId?.length ?? 0).toBeLessThanOrEqual(240);
      expect(thread.sourcePinId?.length ?? 0).toBeLessThanOrEqual(240);
      expect(thread.lineAnchor?.semanticId?.length ?? 0).toBeLessThanOrEqual(240);
      expect(thread.commentBody.length).toBeLessThanOrEqual(4000);
    }
  });

  it("uses the resume preview as the selectable line-level claim surface", async () => {
    const artifact = vi.fn(async (artifactId: string) => ({
      ok: true as const,
      artifact: {
        ...sampleArtifact,
        artifactId,
        jobKey: sampleApplyReviewQueue.items[0]!.jobKey,
        title: "Principal Platform Engineer Resume",
        company: sampleApplyReviewQueue.items[0]!.company,
      },
      layoutBoxes: [],
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

    const resumeEditor = await screen.findByRole("region", { name: "Tailored resume preview" });
    await waitFor(() => expect(artifact).toHaveBeenCalledWith("resume-text-2"));
    expect(artifact).not.toHaveBeenCalledWith("resume-pdf-2");
    expect(screen.queryByRole("img", { name: "Tailored resume preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Line-by-line resume audit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Resume audit line list" })).not.toBeInTheDocument();
    const shadow = await findResumeShadowRoot();
    await selectResumeLine(shadow, "Owned platform reliability improvements for incident response.");
    await waitFor(() => expect(shadowText(shadow)).toContain("Profile source field"));
    expect(shadowText(shadow)).not.toContain("Tailored resume line");
    expect(shadowText(shadow)).not.toContain("Evidence basis");
    await waitFor(() => expect(shadowText(shadow)).toContain("Built platform services"));
    expect(screen.queryByText("Tailored artifact text")).not.toBeInTheDocument();
    expect(screen.getAllByText("Owned platform reliability improvements for incident response.").length).toBeGreaterThan(0);
    await waitFor(() => expect(shadowText(shadow)).toMatch(/Signals reflected: platform reliability/i));
    expect(shadowText(shadow)).not.toContain("Achievement Reframed");
    expect(shadowText(shadow)).not.toContain("evidence_reframing");
    expect(shadowText(shadow)).not.toContain("ev_platform_reliability");
    expect(screen.getByText("Artifact-level grounding and claim risk")).toBeInTheDocument();
    const artifactRisk = screen.getByRole("region", { name: "Artifact-level grounding and claim risk" });
    expect(shadowText(shadow)).not.toContain("Artifact-level grounding and claim risk");
    expect(within(artifactRisk).queryByText("Warnings")).not.toBeInTheDocument();
    expect(within(artifactRisk).getByText("Residual warnings after automated review")).toBeInTheDocument();
    expect(within(artifactRisk).getByText("workflow-selected")).toBeInTheDocument();
    expect(within(artifactRisk).queryByText("Accepted residual warnings")).not.toBeInTheDocument();
    expect(within(artifactRisk).getAllByText("Keyword repetition: 'platform' repeated 7 times")).toHaveLength(1);
    expect(within(artifactRisk).getAllByText("Keyword repetition: 'architecture' repeated 5 times")).toHaveLength(1);
    expect(shadowText(shadow)).toContain("claim risk");
    expect(screen.getAllByText("Owned platform reliability improvements for incident response.").length).toBeGreaterThan(0);
    expect(shadowText(shadow)).not.toContain("req-platform-scale");
    expect(within(artifactRisk).getByText("Warning handling")).toBeInTheDocument();
    expect(
      within(artifactRisk).getByText("retry attempted; selected artifact still has residual warnings"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Warning repair attempted")).not.toBeInTheDocument();
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
      layoutBoxes: [],
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
    htmlPreviewResumeText = queueWithContextualResume.items[0]!.materialsPreview.resumeText;

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => queueWithContextualResume),
          artifact,
        },
      }),
    });

    await waitFor(() => expect(artifact).toHaveBeenCalledWith("resume-text-2"));
    const shadow = await findResumeShadowRoot();
    await selectResumeLine(shadow, "Led incident response handovers.");
    await waitFor(() => expect(shadowText(shadow)).toContain("profile section"));
    await waitFor(() => expect(shadowText(shadow)).toMatch(/Closest recorded Profile source field/i));
    expect(screen.queryByText("source-backed")).not.toBeInTheDocument();
    expect(screen.queryByText("claim risk")).not.toBeInTheDocument();
    expect(screen.queryByText("No source evidence recorded for this line.")).not.toBeInTheDocument();
    expect(shadowText(shadow)).not.toContain("Tailored resume line");
    expect(shadowText(shadow)).toMatch(/Led incident response handovers/);
    await waitFor(() => expect(shadowText(shadow)).toMatch(/No exact Profile source field was recorded/i));
    await waitFor(() => expect(shadowText(shadow)).toMatch(/Signals reflected: platform reliability/i));
    expect(shadowText(shadow)).not.toContain("Evidence basis");
    expect(screen.getByText("Artifact-level grounding and claim risk")).toBeInTheDocument();
    expect(shadowText(shadow)).not.toContain("Audit metadata gaps");
    expect(
      screen.getAllByText("Tailoring audit metadata incomplete: missing profile evidence mapping").length,
    ).toBeGreaterThan(0);
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
      layoutBoxes: [],
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

    expect(await findResumeShadowRoot()).toBeInTheDocument();
    await waitFor(() => expect(artifact).toHaveBeenCalledWith("resume-text-2"));
    expect(artifact).not.toHaveBeenCalledWith("resume-pdf-2");
    const shadow = await findResumeShadowRoot();
    expect(screen.getByRole("region", { name: "Resume line review" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Rendered resume line review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Rendered resume text lines" })).not.toBeInTheDocument();
    expect(shadow.querySelectorAll('[aria-label="JobHunter resume comment"]').length).toBeGreaterThan(0);
    const lineOne = shadowElementWithText(shadow, "Principal Platform Engineer");
    expect(screen.queryByRole("region", { name: "Line-by-line resume audit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Resume audit line list" })).not.toBeInTheDocument();
    await selectResumeLine(shadow, "Owned platform reliability improvements for incident response.");
    expect(shadowText(shadow)).toContain("missing source");
    await userEvent.click(lineOne);
    await waitFor(() => expect(shadowElementWithText(shadow, "Principal Platform Engineer").className).toContain("jobhunter-selected-line"));
  });

  it("renders skill provenance as a JobHunter comment in the resume editor", async () => {
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
    const queueWithSkillsLine = {
      ...sampleApplyReviewQueue,
      items: sampleApplyReviewQueue.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              materialsPreview: {
                ...item.materialsPreview,
                resumeText: [
                  item.materialsPreview.resumeText,
                  "",
                  "Skills",
                  "Platform & Cloud: Kubernetes, Docker, GCP, AWS",
                ].join("\n"),
              },
            }
          : item,
      ),
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
      layoutBoxes: [],
      tailoringExplanation: explanationWithSkillProvenance,
    }));
    htmlPreviewResumeText = queueWithSkillsLine.items[0]!.materialsPreview.resumeText;

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => queueWithSkillsLine),
          artifact,
        },
      }),
    });

    await waitFor(() => expect(artifact).toHaveBeenCalledWith("resume-text-2"));
    const shadow = await findResumeShadowRoot();
    expect(shadowText(shadow)).toContain("Platform & Cloud: Kubernetes, Docker, GCP, AWS");
    await selectResumeLine(shadow, "Platform & Cloud: Kubernetes, Docker, GCP, AWS");
    await waitFor(() => expect(shadowText(shadow)).toContain("Profile source field"));
    expect(shadowText(shadow)).not.toContain("Tailored resume line");
    await waitFor(() => expect(shadowText(shadow)).toMatch(/Skill category is preserved/i));
    expect(shadowText(shadow)).not.toContain("Evidence IDs");
    expect(shadowText(shadow)).not.toContain("Requirement IDs");
    expect(shadowText(shadow)).not.toContain("Controls");
    expect(shadowText(shadow)).not.toContain("Transform");
  });

  it("resolves resume header rows to Profile source fields in JobHunter comments", async () => {
    const queueWithProfileHeader = {
      ...sampleApplyReviewQueue,
      items: sampleApplyReviewQueue.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              materialsPreview: {
                ...item.materialsPreview,
                resumeText: "Jordan Candidate\n\nOwned platform reliability improvements for incident response.",
              },
            }
          : item,
      ),
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
      layoutBoxes: [],
      tailoringExplanation: sampleTailoringExplanation,
    }));
    htmlPreviewResumeText = queueWithProfileHeader.items[0]!.materialsPreview.resumeText;

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => queueWithProfileHeader),
          artifact,
        },
      }),
    });

    await waitFor(() => expect(artifact).toHaveBeenCalledWith("resume-text-2"));
    const shadow = await findResumeShadowRoot();
    expect(shadowText(shadow)).toContain("Jordan Candidate");
    expect(shadowText(shadow)).toContain("profile source");
    expect(shadowText(shadow)).toContain("Profile source field");
    expect(shadowText(shadow)).not.toContain("Tailored resume line");
    expect(shadowText(shadow)).toMatch(/Full name: Jordan Candidate/);
    expect(shadowText(shadow)).not.toContain("Original source line");
    expect(shadowText(shadow)).not.toContain("Rendered resume line");
    expect(
      shadowText(shadow),
    ).not.toContain("No Profile source field mapping was recorded for this selected resume line.");
  });

  it("feeds resume text line targets into the resume audit viewer", async () => {
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
    htmlPreviewResumeText = queueWithModernCvResumeText.items[0]!.materialsPreview.resumeText;

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => queueWithModernCvResumeText),
        },
      }),
    });

    const shadow = await findResumeShadowRoot();
    expect(shadowText(shadow)).toContain("Director of Engineering / Acting CISO | Welltech");
    expect(shadowText(shadow)).toContain("Barcelona, Spain (Remote) | Mar 2024 -- Present");
    expect(shadowText(shadow)).toContain("Master's Degree in Aerospace and Mechanical Engineering");
    expect(shadowText(shadow)).toContain("Platform & Cloud: Kubernetes, Docker, GCP");
    expect(screen.queryByRole("region", { name: "Rendered resume line review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Rendered resume text lines" })).not.toBeInTheDocument();
  });

  it("passes generated resume layout boxes into the HTML editor", async () => {
    const queueWithLayoutBoxes = {
      ...sampleApplyReviewQueue,
      items: sampleApplyReviewQueue.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              materialsPreview: {
                ...item.materialsPreview,
                resumePdfLayoutBoxes: [
                  {
                    semanticId: "experience:acme:bullet:1",
                    pageNumber: 1,
                    lineNumber: 3,
                    textExcerpt: "Owned platform reliability improvements for incident response.",
                    leftPct: 12.5,
                    topPct: 24,
                    widthPct: 62,
                    heightPct: 2.4,
                  },
                ],
              },
            }
          : item,
      ),
    };

    renderWithProviders(<ApplyReviewView />, {
      ports: buildTestPorts({
        api: {
          applyReviewQueue: vi.fn(async () => queueWithLayoutBoxes),
        },
      }),
    });

    expect(await screen.findByRole("region", { name: "Tailored resume preview" })).toHaveAttribute(
      "data-layout-box-count",
      "1",
    );
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
