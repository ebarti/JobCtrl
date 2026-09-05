import { expect, test, type Page } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";

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

test.beforeEach(async ({ context, baseURL }) => {
  const allowed = new Set([new URL(baseURL!).origin, `http://127.0.0.1:${process.env["JOBCTRL_E2E_API_PORT"] ?? "8767"}`]);
  await context.route("**/*", (route) => allowed.has(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
});

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
    editedText:
      "Principal Platform Engineer\nExperience\nRestored human rewrite for incident response.",
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
      commentBody:
        "Check the quantified reliability claim against profile evidence.",
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
          declared: ["terraform", "gcp"],
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
          covered: ["platform reliability", "incident response", "terraform"],
          declared: ["kubernetes", "gcp"],
          missing: ["typescript"],
        }),
      ),
    );
  }
  return makeArtifactDetail({ ...acceptedArtifact, artifactId });
}

async function installArtifactComparisonRoutes(page: Page, advanceDraftAfterRender = true) {
  let renderCompleted = false;
  const nextDraft = {
    ...draft, draftId: "draft-after-promotion", baseGeneration: 3,
    baseResumeTextArtifactId: draftArtifact.artifactId, baseResumePdfArtifactId: "resume-review-pdf",
    state: "active", currentRevisionId: null, latestRevisionNumber: 0,
    latestRevision: null, commentThreads: [],
  };
  const currentDraft = () => renderCompleted && advanceDraftAfterRender ? nextDraft : draft;
  await page.route("**/v1/apply/review-queue", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(renderCompleted && advanceDraftAfterRender ? {
        ...sampleApplyReviewQueue,
        items: sampleApplyReviewQueue.items.map((item) => item.jobKey === jobKey ? {
          ...item, materialsPreview: { ...item.materialsPreview,
            resumeTextArtifactId: draftArtifact.artifactId, resumePdfArtifactId: "resume-review-pdf" },
        } : item),
      } : sampleApplyReviewQueue),
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
      body: JSON.stringify({ ok: true, draft: currentDraft() }),
    });
  });
  await page.route(
    "**/v1/resume-review/drafts/*/comment-threads",
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          draft: currentDraft(),
          commentThreads: currentDraft().commentThreads,
          seededCount: currentDraft().commentThreads.length,
          updatedCount: 0,
        }),
      });
    },
  );
  await page.route("**/v1/resume-review/drafts/*/render", async (route) => {
    renderCompleted = true;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        draft: { ...draft, state: advanceDraftAfterRender ? "promoted" : "rendered" },
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
      body: JSON.stringify(
        makeArtifactsPage([draftArtifact, acceptedArtifact]),
      ),
    });
  });
  await page.route("**/v1/artifacts/*/preview.html*", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<main><section class="resume-page" data-resume-page="1">
        <h1 data-resume-line-number="1" data-resume-layout-target="personal:full_name">Principal Platform Engineer</h1>
        <h2 data-resume-line-number="2" data-resume-layout-target="section:experience">Experience</h2>
        <p data-resume-line-number="3" data-resume-layout-target="experience:line:3">Owned platform reliability work for incident response.</p>
      </section></main>`,
    });
  });
  await page.route("**/v1/artifacts/*", async (route) => {
    const artifactId = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").pop() ?? "",
    );
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(artifactDetail(artifactId)),
    });
  });
}

test("apply review compares accepted artifact with rendered draft artifact", async ({
  page,
}) => {
  await installArtifactComparisonRoutes(page);

  await page.goto("/apply-review");

  const comparison = page.getByRole("region", { name: "Artifact comparison" });
  await expect(comparison).toContainText(
    "Render a saved draft to compare it with the accepted artifact.",
  );

  const renderButton = page.getByRole("button", { name: "Render replacement" });
  await expect(renderButton).toBeEnabled();
  await renderButton.click();

  await expect(comparison).toContainText("+covered");
  await expect(comparison).toContainText("incident response");
  await expect(comparison).toContainText("lost");
  await expect(comparison).toContainText("typescript");
  await expect(comparison).toContainText("+declared");
  await expect(comparison).toContainText("declared lost");
  await expect(comparison).toContainText("gcp");
  await expect(comparison).toContainText("claim risk");
  await expect(comparison).toContainText("Accepted resume");
  await expect(comparison).toContainText("Rendered draft resume");
  await expect(page.getByText("draft ready", { exact: true })).toBeVisible();
  await expect(renderButton).toBeDisabled();
  await expect(page.getByText("replacement rendered", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Tailored resume preview" }),
  ).toBeVisible();
  await injectAxe(page);
  await checkA11y(page, ".apply-review-resume-review", { includedImpacts: ["critical", "serious"] });
});

test("artifact full-page detail compares same-job generated artifacts", async ({
  page,
}) => {
  await installArtifactComparisonRoutes(page);

  await page.goto(`/artifacts/${acceptedArtifact.artifactId}`);

  const artifactDetail = page.getByRole("article", {
    name: "Artifact details",
  });
  await expect(artifactDetail).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Artifact details" }),
  ).toHaveCount(0);
  await expect(
    artifactDetail.getByRole("button", { name: "Back to artifacts" }),
  ).toBeVisible();
  await expect(
    artifactDetail.getByRole("combobox", { name: "Compare with" }),
  ).toContainText("candidate / Compact");
  const comparison = page.getByRole("region", { name: "Artifact comparison" });
  await expect(
    comparison.getByRole("region", { name: "Comparison artifact summary" }),
  ).toContainText(draftArtifact.title);
  await expect(comparison).toContainText("+covered");
  await expect(comparison).toContainText("incident response");
  await expect(comparison).toContainText("lost");
  await expect(comparison).toContainText("typescript");
  await expect(comparison).toContainText("+declared");
  await expect(comparison).toContainText("declared lost");
  await expect(comparison).toContainText("gcp");
});

test("late saved snapshot preserves newer typing and keeps rendering gated", async ({ page }) => {
  await installArtifactComparisonRoutes(page);
  let acknowledge!: () => void;
  let savedText = "";
  let savedDraft = draft;
  await page.route("**/v1/resume-review/drafts/*/revisions", async (route) => {
    const body = route.request().postDataJSON();
    savedText = body.editedText;
    await new Promise<void>((resolve) => { acknowledge = resolve; });
    savedDraft = {
      ...draft,
      currentRevisionId: "revision-2",
      latestRevisionNumber: 2,
      latestRevision: { ...draft.latestRevision, revisionId: "revision-2", revisionNumber: 2,
        editedText: body.editedText, plateDocument: body.plateDocument },
    };
    await route.fulfill({ json: { ok: true, draft: savedDraft, revision: savedDraft.latestRevision } });
  });
  await page.goto("/apply-review");
  const editor = page.getByRole("textbox", { name: "Tailored resume preview editor" });
  await expect(editor).toBeVisible();
  await editor.click();
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially(" snapshotA");
  await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect.poll(() => Boolean(acknowledge)).toBe(true);
  await editor.click();
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially(" laterB");
  acknowledge();
  await expect(page.getByText("unsaved changes", { exact: true })).toBeVisible();
  await expect(editor).toContainText("laterB");
  await expect(editor).toBeFocused();
  expect(savedText).toContain("snapshotA");
  expect(savedText).not.toContain("laterB");
  await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Render replacement" })).toBeDisabled();
});

test("a delayed seed snapshot cannot replace a rendered saved revision", async ({ page }) => {
  await installArtifactComparisonRoutes(page, false);
  let finishSeed!: () => void;
  const lateThread = { ...draft.commentThreads[0]!, threadId: "late-seed-witness",
    semanticId: null, lineAnchor: null, sourcePinId: null, anchorResolved: false,
    commentBody: "Late seed response published" };
  const seededDraft = { ...draft, commentThreads: [...draft.commentThreads, lateThread] };
  await page.route("**/v1/resume-review/drafts/*/comment-threads", async (route) => {
    await new Promise<void>((resolve) => { finishSeed = resolve; });
    await route.fulfill({ json: { ok: true, draft: seededDraft, commentThreads: seededDraft.commentThreads, seededCount: 1, updatedCount: 0 } });
  });
  await page.goto("/apply-review");
  await expect.poll(() => Boolean(finishSeed)).toBe(true);
  await page.getByRole("button", { name: "Render replacement" }).click();
  await expect(page.getByText("replacement rendered", { exact: true })).toBeVisible();
  finishSeed();
  // This new thread is observable only after the late mutation publishes into the cache.
  await expect(page.getByText("Late seed response published", { exact: true })).toBeVisible();
  await expect(page.getByText("replacement rendered", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Artifact comparison" })).toContainText("+covered");
});
