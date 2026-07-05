import { expect, test, type Page } from "@playwright/test";

import {
  makeArtifactDetail,
  makeArtifactTailoringExplanation,
  makeArtifactsPage,
  makeCoverageAudit,
  sampleAcceptedResumeArtifact,
  sampleApplyReviewQueue,
  sampleDraftResumeArtifact,
  sampleResumeTemplateListResponse,
} from "../../src/test/fixtures/projections.js";

const jobKey = sampleApplyReviewQueue.items[0]!.jobKey;
const acceptedArtifact = {
  ...sampleAcceptedResumeArtifact,
  artifactId: "resume-text-2",
  jobKey,
  title: "Accepted resume",
  company: sampleApplyReviewQueue.items[0]!.company,
};
const draftArtifact = {
  ...sampleDraftResumeArtifact,
  artifactId: "resume-review-text",
  jobKey,
  title: "Rendered draft resume",
  company: sampleApplyReviewQueue.items[0]!.company,
};
const draft = {
  draftId: "draft-job-2",
  jobKey,
  baseGeneration: 1,
  baseResumeTextArtifactId: acceptedArtifact.artifactId,
  baseResumePdfArtifactId: "resume-pdf-2",
  rendererFormat: "html_css",
  state: "active",
  currentRevisionId: "draft-revision-1",
  latestRevisionNumber: 1,
  createdAt: "2026-06-24T09:45:00.000Z",
  updatedAt: "2026-06-24T10:00:00.000Z",
  latestRevision: {
    revisionId: "draft-revision-1",
    draftId: "draft-job-2",
    jobKey,
    revisionNumber: 1,
    editedText: "Principal Platform Engineer\nExperience\nRestored human rewrite for incident response.",
    plateDocument: null,
    editDeltas: [],
    createdAt: "2026-06-24T10:00:00.000Z",
  },
  commentThreads: [
    {
      threadId: "thread-claim-risk",
      draftId: "draft-job-2",
      jobKey,
      baseArtifactId: acceptedArtifact.artifactId,
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
    },
  ],
  feedbackSignals: [],
};

function artifactDetail(artifactId: string) {
  if (artifactId === acceptedArtifact.artifactId) {
    return makeArtifactDetail(
      acceptedArtifact,
      makeArtifactTailoringExplanation(
        makeCoverageAudit({
          covered: ["platform reliability", "typescript"],
          missing: ["incident response", "kubernetes"],
        }),
      ),
    );
  }
  if (artifactId === draftArtifact.artifactId) {
    return makeArtifactDetail(
      draftArtifact,
      makeArtifactTailoringExplanation(
        makeCoverageAudit({
          covered: ["platform reliability", "incident response"],
          missing: ["kubernetes", "typescript"],
        }),
      ),
    );
  }
  return makeArtifactDetail({ ...acceptedArtifact, artifactId });
}

async function installArtifactComparisonRoutes(page: Page) {
  await page.route("**/v1/apply/review-queue", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(sampleApplyReviewQueue),
    });
  });
  await page.route("**/v1/resume-templates", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(sampleResumeTemplateListResponse),
    });
  });
  await page.route("**/v1/jobs/*/resume-review/draft", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, draft }),
    });
  });
  await page.route("**/v1/resume-review/drafts/*/comment-threads", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        draft,
        commentThreads: draft.commentThreads,
        seededCount: draft.commentThreads.length,
        updatedCount: 0,
      }),
    });
  });
  await page.route("**/v1/resume-review/drafts/*/render", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        draft: { ...draft, state: "rendered" },
        validation: { passed: true, errors: [], warnings: [] },
        artifacts: {
          resumeText: {
            artifactId: draftArtifact.artifactId,
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
      }),
    });
  });
  await page.route(/\/v1\/artifacts(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(makeArtifactsPage([draftArtifact, acceptedArtifact])),
    });
  });
  await page.route("**/v1/artifacts/*/preview.html*", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<main><h1>Principal Platform Engineer</h1><p>Owned platform reliability improvements for incident response.</p></main>",
    });
  });
  await page.route("**/v1/artifacts/*", async (route) => {
    const artifactId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(artifactDetail(artifactId)),
    });
  });
}

test("apply review compares accepted artifact with rendered draft artifact", async ({ page }) => {
  await installArtifactComparisonRoutes(page);

  await page.goto("/apply-review");

  const comparison = page.getByRole("region", { name: "Artifact comparison" });
  await expect(comparison).toContainText("Render a saved draft to compare it with the accepted artifact.");

  const renderButton = page.getByRole("button", { name: "render replacement" });
  await expect(renderButton).toBeEnabled();
  await renderButton.click();

  await expect(comparison).toContainText("+covered");
  await expect(comparison).toContainText("incident response");
  await expect(comparison).toContainText("lost");
  await expect(comparison).toContainText("typescript");
  await expect(comparison).toContainText("claim risk");
  await expect(page.getByRole("region", { name: "Tailored resume preview" })).toBeVisible();
});

test("artifacts drawer compares same-job generated artifacts", async ({ page }) => {
  await installArtifactComparisonRoutes(page);

  await page.goto(`/artifacts/${acceptedArtifact.artifactId}`);

  await expect(page.getByRole("dialog", { name: "Artifact details" })).toBeVisible();
  await expect(page.getByLabel("Compare with")).toHaveValue(draftArtifact.artifactId);
  const comparison = page.getByRole("region", { name: "Artifact comparison" });
  await expect(comparison).toContainText("+covered");
  await expect(comparison).toContainText("incident response");
  await expect(comparison).toContainText("lost");
  await expect(comparison).toContainText("typescript");
});
