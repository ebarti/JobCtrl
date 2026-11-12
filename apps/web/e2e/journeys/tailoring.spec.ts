import { createHash } from "node:crypto";
import type { Request, Route } from "@playwright/test";
import {
  test,
  expect,
  json,
  modelCall,
  completed,
  type ExternalCall,
} from "../harness/fixtures.js";
import {
  baseline,
  createBaseline,
  createPosting,
  current,
  getResume,
  type Library,
  type Resume,
} from "./core-data.js";
import { catalogMatching } from "./requirements-data.js";
import {
  groupedCoverageDecision,
  type GroupedCoverageContext,
} from "./fit-data.js";

type Source = { source_id: string; text: string };
type Fit = {
  current: boolean;
  score: { score: number; revision: number };
  coverage: { wording_gaps: unknown[] };
};
const sources = (call: ExternalCall) => call.body["sources"] as Source[];
const citations = (values: Source[]) =>
  values.map((source) => ({ source_id: source.source_id, quote: source.text }));

test("approved wording composes the full baseline and failed model or render refresh retains the accepted PDF", async ({
  page,
  api,
  app,
}, testInfo) => {
  const { library } = await createBaseline(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", {
    expectedRevision: settings.revision,
    resumeMode: "tailored",
  });
  const achievement = library.roles[0]!.achievements[0]!;
  const evidenceId = `evidence:${achievement.source_refs[0]!.source_id}`;
  const posting = await createPosting(api, "tailoring");
  await page.goto(`/jobs/${posting.job_id}`);
  await page
    .locator("summary")
    .filter({ hasText: /^Posting, availability and requirement details$/ })
    .click();
  await page
    .getByRole("button", { name: "Extract requirements", exact: true })
    .click();
  const extraction = await modelCall(app, "requirements.extract");
  const postingSource = sources(extraction)[0]!;
  extraction.reply({
    status: "complete",
    requirements: [
      {
        local_id: "recovery",
        text: postingSource.text,
        definition: "Implement durable workflow recovery",
        qualifiers: [],
        scope: "resume",
        tier: "must_have",
        weight: 1,
        support: "supported",
        spans: [
          {
            start: 0,
            end: postingSource.text.length,
            quote: postingSource.text,
          },
        ],
      },
    ],
    reason: "The posting expressly requires durable workflow recovery.",
    citations: citations([postingSource]),
  });
  const matching = await modelCall(app, "requirements.match_catalog");
  matching.reply(catalogMatching(matching, { recovery: { verdict: "new" } }));
  // Wait on the public accepted requirements state rather than a UI delay.
  await expect
    .poll(
      async () =>
        (
          await json<{ revision: number }>(
            api,
            "get",
            `/v1/jobs/${posting.job_id}/requirements`,
          )
        ).revision,
    )
    .toBe(1);

  // Prepare the factual state through its real public owner while keeping
  // wording admission explicit. The primary Prepare resume flow is exercised
  // below once the reviewed wording has current source-bound coverage.
  const scoring = api.post(`/v1/jobs/${posting.job_id}/fit/assess`, {
    data: {
      expected_revision: 0,
      prepare_wording: false,
      prepare_coverage: true,
    },
  });
  const qualification = await modelCall(app, "fit.qualification");
  const qualificationContext = qualification.body["context"] as {
    binding: Record<string, string>;
  };
  const fact = sources(qualification).find(
    (source) => source.source_id === evidenceId,
  )!;
  const requirement = sources(qualification).find(
    (source) => source.source_id === "requirement",
  )!;
  expect(fact).toBeTruthy();
  qualification.reply({
    ...qualificationContext.binding,
    kind: "matched",
    strength: "direct",
    confidence: "high",
    rationale:
      "The authored achievement directly supports the qualified requirement.",
    evidence: citations([fact]),
    requirement_citations: citations([requirement]),
    achievement_ids: [achievement.achievement_id],
    keywords: ["durable workflows"],
    eligibility: "eligible",
    blocker_category: null,
    warning_category: null,
  });
  const baselineCoverage = await modelCall(app, "fit.wording-coverage-grouped");
  baselineCoverage.reply(
    groupedCoverageDecision(baselineCoverage, {
      evidenceSourceId: evidenceId,
      status: "not_covered",
      action: "propose_wording",
      gapRequirementIds: (
        baselineCoverage.body["context"] as GroupedCoverageContext
      ).binding.requirements.map((row) => row.requirement_id),
    }),
  );
  expect((await scoring).status()).toBe(200);
  await expect(page.getByText("Score 10/10", { exact: true })).toBeVisible();
  const beforeWording = await json<Fit>(
    api,
    "get",
    `/v1/jobs/${posting.job_id}/fit`,
  );
  expect(beforeWording.current).toBe(true);
  expect(beforeWording.score.score).toBe(10);
  expect(beforeWording.coverage.wording_gaps).not.toHaveLength(0);

  const firstManualAdmission = page.waitForResponse(
    (response) =>
      response.url() === `${app.baseURL}/v1/actions/fit.refresh` &&
      response.request().method() === "POST",
  );
  await page
    .locator("summary")
    .filter({ hasText: /^Update affected matches$/ })
    .click();
  await page
    .getByRole("region", { name: "Affected matches", exact: true })
    .getByRole("button", { name: "Update affected matches", exact: true })
    .click();
  const firstManualResponse = await firstManualAdmission;
  expect(firstManualResponse.status()).toBe(202);
  const firstManualRun = (await firstManualResponse.json()) as {
    runId: string;
  };
  const authoring = await modelCall(app, "profile.wording_authoring");
  const alternative =
    "Built durable workflow recovery with documented operational ownership.";
  authoring.reply({
    support: "supported",
    text: alternative,
    rationale:
      "The proposed expression stays within the cited authored achievement.",
    citations: citations(sources(authoring)),
  });
  await completed(api, firstManualRun.runId);
  let proposed: Library | undefined;
  await expect
    .poll(async () => {
      proposed = await json<Library>(api, "get", "/v1/profile/wording");
      return proposed.variants.find((variant) => variant.text === alternative)
        ?.status;
    })
    .toBe("pending");
  const proposedVariant = proposed!.variants.find(
    (variant) => variant.text === alternative,
  )!;
  expect(proposedVariant.approval_id).toBeNull();
  expect(
    (await json<Fit>(api, "get", `/v1/jobs/${posting.job_id}/fit`)).score.score,
  ).toBe(10);

  await page.goto("/profile");
  const wording = page.getByRole("article").filter({
    has: page.getByText(alternative, { exact: true }),
  });
  await expect(wording.getByText(alternative, { exact: true })).toBeVisible();
  await wording
    .getByRole("button", { name: "Approve exact wording", exact: true })
    .click();
  let approved: Library | undefined;
  await expect
    .poll(async () => {
      approved = await json<Library>(api, "get", "/v1/profile/wording");
      return approved.variants.find(
        (variant) => variant.variant_id === proposedVariant.variant_id,
      )?.status;
    })
    .toBe("approved");
  expect(
    approved!.variants.find(
      (variant) => variant.variant_id === proposedVariant.variant_id,
    )!.approval_id,
  ).toBeTruthy();

  const beforeRefresh = app.external.calls.length;
  await page.goto(`/jobs/${posting.job_id}`);
  await page
    .locator("summary")
    .filter({ hasText: /^Update affected matches$/ })
    .click();
  const refreshPanel = page.getByRole("region", {
    name: "Affected matches",
    exact: true,
  });
  await refreshPanel
    .getByRole("button", { name: "Dismiss completed update", exact: true })
    .click();
  const coverageAdmission = page.waitForResponse(
    (response) =>
      response.url() === `${app.baseURL}/v1/actions/fit.refresh` &&
      response.request().method() === "POST",
  );
  await refreshPanel
    .getByRole("button", { name: "Update affected matches", exact: true })
    .click();
  const coverageResponse = await coverageAdmission;
  expect(coverageResponse.status()).toBe(202);
  const coverageRun = (await coverageResponse.json()) as { runId: string };
  const approvedCoverage = await modelCall(app, "fit.wording-coverage-grouped");
  approvedCoverage.reply(
    groupedCoverageDecision(approvedCoverage, {
      evidenceSourceId: evidenceId,
      status: "covered",
      action: "reuse_approved",
      reusableVariantId: proposedVariant.variant_id,
    }),
  );
  await completed(api, coverageRun.runId);
  await expect
    .poll(
      async () =>
        (await json<Fit>(api, "get", `/v1/jobs/${posting.job_id}/fit`)).coverage
          .wording_gaps.length,
    )
    .toBe(0);
  expect(
    app.external.calls
      .slice(beforeRefresh)
      .filter((call) => call.path === "/model")
      .map((call) => call.body["operation"]),
  ).toEqual(["fit.wording-coverage-grouped"]);
  expect(
    (await json<Fit>(api, "get", `/v1/jobs/${posting.job_id}/fit`)).score.score,
  ).toBe(10);

  await page
    .getByRole("combobox", { name: "Resume to prepare", exact: true })
    .selectOption("tailored");
  const preparationAdmission = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/v1/actions/preparation.run" &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Prepare resume", exact: true })
    .click();
  const preparationResponse = await preparationAdmission;
  expect(preparationResponse.status()).toBe(202);
  expect(preparationResponse.request().postDataJSON()).toMatchObject({
    recipe: "prepare",
    scope: "selected",
    job_ids: [posting.job_id],
    resume_mode: "tailored",
  });
  const preparation = (await preparationResponse.json()) as { runId: string };
  const review = await modelCall(app, "resumes.coherence");
  review.reply({ verdict: "pass", findings: [] });
  await completed(api, preparation.runId);
  let resume: Resume = (
    await json<{ resumes: Resume[] }>(
      api,
      "get",
      `/v1/resumes?jobId=${posting.job_id}`,
    )
  ).resumes[0]!;
  await expect(
    page.getByRole("tab", { name: "Resume", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const composed = current(resume);
  expect(composed.document.experience.map((role) => role.id)).toEqual(
    baseline.resume.experience_entries.map((role) => role.id),
  );
  expect(composed.selected_variants).toHaveLength(3);
  expect(composed.selected_variants[0]!.variant_id).toBe(
    proposedVariant.variant_id,
  );
  expect(composed.document.experience[0]!.bullets[0]!.text).toBe(alternative);
  const repeat = (
    await json<{ resume: Resume }>(api, "post", "/v1/resumes", {
      job_id: posting.job_id,
      expected_profile_revision: approved!.profileVersion,
      mode: "tailored",
    })
  ).resume;
  expect(current(repeat).document).toEqual(composed.document);
  expect(current(repeat).selected_variants).toEqual(composed.selected_variants);
  expect(current(repeat).coverage_manifest).toEqual(composed.coverage_manifest);

  await expect
    .poll(
      async () => current(await getResume(api, resume.resume_id)).review.status,
    )
    .toBe("pass");
  await expect
    .poll(
      async () =>
        current(await getResume(api, resume.resume_id)).renders.length,
      { timeout: 30_000 },
    )
    .toBe(1);
  await page
    .getByRole("button", { name: "Accept resume", exact: true })
    .click();
  await expect
    .poll(
      async () => (await getResume(api, resume.resume_id)).accepted_revision_id,
    )
    .toBe(composed.revision_id);
  const acceptedPdf = await (
    await api.get(
      `/v1/resumes/${resume.resume_id}/export?format=pdf&accepted=true`,
    )
  ).body();
  const acceptedDigest = createHash("sha256").update(acceptedPdf).digest("hex");

  // Refresh the same aggregate. The accepted pointer remains independently
  // readable while a new revision has invalid model output and browser failure.
  resume = await getResume(api, resume.resume_id);
  resume = (
    await json<{ resume: Resume }>(api, "post", "/v1/resumes", {
      job_id: posting.job_id,
      expected_profile_revision: approved!.profileVersion,
      resume_id: resume.resume_id,
      expected_version: resume.version,
      mode: "tailored",
    })
  ).resume;
  await page.reload();
  await page
    .getByRole("combobox", { name: "Saved resume", exact: true })
    .selectOption(resume.resume_id);
  await page
    .locator("summary:visible")
    .filter({ hasText: /^Document validation and recovery tools$/ })
    .click();

  // Keep a genuine read of the review's intermediate claim in flight while
  // the same browser receives its newer mutation result. Deliver its original
  // bytes afterward, reproducing the response ordering observed in hosted CI.
  const reviewingVersion = resume.version + 1;
  const listUrl = new URL("/v1/resumes", app.baseURL);
  listUrl.searchParams.set("jobId", posting.job_id);
  const matchesList = (url: URL) => url.href === listUrl.href;
  let staleListRead:
    { request: Request; body: Buffer; resume: Resume } | undefined;
  let releaseStaleRead!: () => void;
  const staleReadGate = new Promise<void>((resolve) => {
    releaseStaleRead = resolve;
  });
  let releaseLaterReads!: () => void;
  const laterReadGate = new Promise<void>((resolve) => {
    releaseLaterReads = resolve;
  });
  let holdLaterReads = true;
  const forwardingReads: Promise<void>[] = [];
  const forwardList = async (route: Route) => {
    const response = await route.fetch();
    try {
      const body = await response.body();
      const listed = JSON.parse(body.toString("utf8")) as { resumes: Resume[] };
      const selected = listed.resumes.find(
        (item) => item.resume_id === resume.resume_id,
      );
      if (
        selected?.version === reviewingVersion &&
        current(selected).review.status === "running"
      ) {
        staleListRead ??= { request: route.request(), body, resume: selected };
        await staleReadGate;
      } else if (
        holdLaterReads &&
        staleListRead &&
        selected &&
        selected.version > reviewingVersion
      ) {
        // A newer refetch must not conceal whether the older read can undo an
        // already successful own mutation before the next user action.
        await laterReadGate;
      }
      await route.fulfill({ response });
    } finally {
      await response.dispose();
    }
  };
  const delayList = async (route: Route) => {
    const pending = forwardList(route);
    forwardingReads.push(pending);
    await pending;
  };
  await page.route(matchesList, delayList);
  const browserReview = page.waitForResponse(
    (response) =>
      response.url() ===
        `${app.baseURL}/v1/resumes/${resume.resume_id}/review` &&
      response.request().method() === "POST",
  );
  try {
    await page
      .getByRole("button", { name: "Review coherence", exact: true })
      .click();
    const invalidReview = await modelCall(app, "resumes.coherence");
    await expect
      .poll(() => staleListRead?.resume.version, {
        message: "The real list read must observe the in-progress review claim",
      })
      .toBe(reviewingVersion);
    invalidReview.reply({
      verdict: "pass",
      findings: [],
      unauthorizedExtraField: "reject",
    });
    const reviewedResponse = await browserReview;
    expect(reviewedResponse.status()).toBe(200);
    const reviewed: Resume = (await reviewedResponse.json()).resume;
    expect(reviewed.version).toBe(reviewingVersion + 1);
    expect(current(reviewed).review.status).toBe("failed");
    const workspace = page
      .getByRole("region", { name: "Resume", exact: true })
      .filter({
        has: page.getByRole("heading", {
          name: "Advisory coherence review",
          exact: true,
        }),
      });
    await expect(
      workspace.getByText(/^Status: failed(?: \([^)]*\))?\.$/),
    ).toBeVisible();
    const staleDelivery = page.waitForResponse(
      (response) => response.request() === staleListRead!.request,
    );
    releaseStaleRead();
    const delivered = await staleDelivery;
    expect(delivered.status()).toBe(200);
    expect(
      createHash("sha256")
        .update(await delivered.body())
        .digest("hex"),
    ).toBe(createHash("sha256").update(staleListRead!.body).digest("hex"));
    expect(staleListRead!.resume.version).toBeLessThan(reviewed.version);
    await app.failRendering();
    const renderUrl = `${app.baseURL}/v1/resumes/${resume.resume_id}/render`;
    const renderRequested = page.waitForRequest(
      (request) => request.url() === renderUrl && request.method() === "POST",
    );
    const renderResponse = page.waitForResponse(
      (response) =>
        response.url() === renderUrl && response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Render resume", exact: true })
      .click();
    const renderRequest = await renderRequested;
    holdLaterReads = false;
    releaseLaterReads();
    await testInfo.attach("review-render-version-order", {
      contentType: "application/json",
      body: JSON.stringify({
        resumeId: resume.resume_id,
        staleReadVersion: staleListRead!.resume.version,
        completedReviewVersion: reviewed.version,
        renderExpectedVersion: renderRequest.postDataJSON().expected_version,
      }),
    });
    expect(renderRequest.postDataJSON()).toEqual({
      expected_version: reviewed.version,
    });
    const failedRenderResponse = await renderResponse;
    expect(failedRenderResponse.status()).toBe(200);
    const failedRender: Resume = (await failedRenderResponse.json()).resume;
    expect(current(failedRender).render_attempts.at(-1)?.status).toBe("failed");
    await expect(
      page.getByRole("alert").filter({ hasText: "Render failed" }),
    ).toBeVisible();
    expect(
      createHash("sha256")
        .update(
          await (
            await api.get(
              `/v1/resumes/${resume.resume_id}/export?format=pdf&accepted=true`,
            )
          ).body(),
        )
        .digest("hex"),
    ).toBe(acceptedDigest);
    await app.restoreRendering();
    await page
      .getByRole("button", { name: "Render resume", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          current(await getResume(api, resume.resume_id)).renders.length,
        { timeout: 30_000 },
      )
      .toBe(1);
    await page
      .getByRole("button", { name: "Accept with review override", exact: true })
      .click();
    await expect
      .poll(
        async () => (await getResume(api, resume.resume_id)).acceptances.length,
      )
      .toBe(2);
    const overridden = await getResume(api, resume.resume_id);
    expect(overridden.acceptances.at(-1)!.review_status).toBe("failed");
    expect(overridden.acceptances.at(-1)!.review_override).toBe(true);
    expect(current(overridden).selected_variants).toHaveLength(3);
    await testInfo.attach("full-baseline-approval", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    holdLaterReads = false;
    releaseStaleRead();
    releaseLaterReads();
    // Stop admitting callbacks and drain this test's sole route before removing
    // interception; removing it first auto-continues responses still in flight.
    await page.unrouteAll({ behavior: "wait" });
    await Promise.all(forwardingReads);
  }
});
