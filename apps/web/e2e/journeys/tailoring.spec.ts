import { createHash } from "node:crypto";
import {
  test,
  expect,
  json,
  modelCall,
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
  const novelty = await modelCall(app, "requirements.novelty");
  novelty.reply({
    verdict: "new",
    reason: "The complete catalog sweep has no equivalent qualified meaning.",
    citations: citations(sources(novelty)),
  });
  await expect(
    page.getByRole("button", { name: "Assess person fit", exact: true }),
  ).toBeEnabled();
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

  await page
    .getByRole("button", { name: "Assess person fit", exact: true })
    .click();
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
  const baselineCoverage = await modelCall(app, "fit.wording-coverage");
  baselineCoverage.reply({
    ...(baselineCoverage.body["context"] as { binding: Record<string, string> })
      .binding,
    status: "not_covered",
    rationale:
      "The person qualifies; this approved baseline expression does not express the complete requested emphasis.",
    citations: citations(
      sources(baselineCoverage).filter((source) =>
        ["requirement", "approved-variant", evidenceId].includes(
          source.source_id,
        ),
      ),
    ),
  });
  await expect(page.getByText("Score 10/10", { exact: true })).toBeVisible();
  const beforeWording = await json<Fit>(
    api,
    "get",
    `/v1/jobs/${posting.job_id}/fit`,
  );
  expect(beforeWording.current).toBe(true);
  expect(beforeWording.score.score).toBe(10);
  expect(beforeWording.coverage.wording_gaps).not.toHaveLength(0);

  await page
    .getByRole("button", { name: "Prepare wording", exact: true })
    .click();
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
  const wording = page.getByRole("article", {
    name: `Wording ${proposedVariant.variant_id}`,
    exact: true,
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
    .getByRole("button", { name: "Refresh wording coverage", exact: true })
    .click();
  const approvedCoverage = await modelCall(app, "fit.wording-coverage");
  approvedCoverage.reply({
    ...(approvedCoverage.body["context"] as { binding: Record<string, string> })
      .binding,
    status: "covered",
    rationale:
      "This exact approved expression covers the requirement using the same person evidence.",
    citations: citations(
      sources(approvedCoverage).filter((source) =>
        ["requirement", "approved-variant", evidenceId].includes(
          source.source_id,
        ),
      ),
    ),
  });
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
  ).toEqual(["fit.wording-coverage"]);
  expect(
    (await json<Fit>(api, "get", `/v1/jobs/${posting.job_id}/fit`)).score.score,
  ).toBe(10);

  const composedResponse = page.waitForResponse(
    (response) =>
      response.url() === `${app.baseURL}/v1/resumes` &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Compose tailored resume", exact: true })
    .click();
  let resume: Resume = (await (await composedResponse).json()).resume;
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

  await page
    .getByRole("button", { name: "Review coherence", exact: true })
    .click();
  const review = await modelCall(app, "resumes.coherence");
  review.reply({ verdict: "pass", findings: [] });
  await expect
    .poll(
      async () => current(await getResume(api, resume.resume_id)).review.status,
    )
    .toBe("pass");
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
    .getByRole("button", { name: "Review coherence", exact: true })
    .click();
  const invalidReview = await modelCall(app, "resumes.coherence");
  invalidReview.reply({
    verdict: "pass",
    findings: [],
    unauthorizedExtraField: "reject",
  });
  await expect
    .poll(
      async () => current(await getResume(api, resume.resume_id)).review.status,
    )
    .toBe("failed");
  await app.failRendering();
  await page
    .getByRole("button", { name: "Render resume", exact: true })
    .click();
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
});
