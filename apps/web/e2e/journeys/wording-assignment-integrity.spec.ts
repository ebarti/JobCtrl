// Public HTTP/Temporal/model boundaries only; no seeded state or internal mocks.
import { createHash } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import {
  test,
  expect,
  json,
  modelCall,
  completed,
  terminal,
  type ApplicationStack,
} from "../harness/fixtures.js";
import {
  createPosting,
  current,
  type Library,
  type Resume,
} from "./core-data.js";
import {
  createScoredFit,
  groupedCoverageDecision,
  refreshPayload,
  startRefresh,
  type GroupedCoverageContext,
  type PendingRefresh,
  type RefreshOperation,
} from "./fit-data.js";
import {
  catalogMatching,
  citeSources,
  modelSources,
  typedExtraction,
} from "./requirements-data.js";

type Assignment = {
  assignment_id: string;
  revision: number;
  state: "active" | "removed";
  profile_id: string;
  achievement_id: string;
  requirement_id: string;
  requirement_revision: number;
  variant_id: string;
  variant_revision: number;
  approval_id: string;
  relation_id: string;
  current: boolean;
};
type WordingLibrary = {
  requirements: {
    requirement_id: string;
    current_wordings: Assignment[];
    wording_assignments: Assignment[];
  }[];
};
type FreshResume = Resume & {
  composition_freshness: {
    current: boolean;
    revision_id: string;
    stale_reasons: string[];
  };
  accepted_freshness?: { status: string; coverage_stale: boolean };
};

const pending = (api: APIRequestContext) =>
  json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending");
const operation = (api: APIRequestContext, runId: string) =>
  json<RefreshOperation>(api, "get", `/v1/fit/refresh/operations/${runId}`);
const getFreshResume = async (api: APIRequestContext, id: string) =>
  (await json<{ resume: FreshResume }>(api, "get", `/v1/resumes/${id}`)).resume;
const assignments = async (api: APIRequestContext) =>
  (
    await json<WordingLibrary>(api, "get", "/v1/fit/requirement-library")
  ).requirements.flatMap((row) => row.wording_assignments);
const changeState = (
  api: APIRequestContext,
  row: Assignment,
  state: "active" | "removed",
) =>
  json<Assignment>(
    api,
    "post",
    `/v1/fit/current-wordings/${row.assignment_id}/state`,
    {
      profile_id: "default",
      expected_revision: row.revision,
      state,
    },
  );
const exactPins = (rows: Assignment[]) =>
  rows
    .map((row) => ({
      assignment_id: row.assignment_id,
      requirement_id: row.requirement_id,
      achievement_id: row.achievement_id,
      variant_id: row.variant_id,
      variant_revision: row.variant_revision,
      approval_id: row.approval_id,
      relation_id: row.relation_id,
      revision: row.revision,
      state: row.state,
    }))
    .sort((a, b) => a.assignment_id.localeCompare(b.assignment_id));

async function primeTwoCurrentAchievements(
  api: APIRequestContext,
  app: ApplicationStack,
  slug: string,
) {
  const seed = await createScoredFit(api, app, slug, { twoRequirements: true });
  const refresh = await startRefresh(
    api,
    refreshPayload(await pending(api)),
    `${slug}-prime`,
  );
  for (let index = 0; index < 2; index += 1) {
    const call = await modelCall(app, "fit.wording-coverage-grouped");
    const binding = call.body["context"] as GroupedCoverageContext;
    const achievement = seed.library.roles
      .flatMap((role) => role.achievements)
      .find((row) => row.achievement_id === binding.binding.achievement_id)!;
    call.reply(
      groupedCoverageDecision(call, {
        evidenceSourceId: `evidence:${achievement.source_refs[0]!.source_id}`,
        status: "covered",
        action: "reuse_approved",
        reusableVariantId: achievement.baseline_variant_id,
      }),
    );
  }
  await completed(api, refresh.runId);
  const heads = (await assignments(api)).filter(
    (row) => row.state === "active",
  );
  expect(heads).toHaveLength(2);
  expect(heads.every((row) => row.current)).toBe(true);
  const a = heads.find(
    (row) =>
      row.achievement_id ===
      seed.library.roles[0]!.achievements[0]!.achievement_id,
  )!;
  const b = heads.find(
    (row) =>
      row.achievement_id ===
      seed.library.roles[0]!.achievements[1]!.achievement_id,
  )!;
  return { seed, a, b };
}

test("a manual Fit refresh refuses an unrelated maintained assignment change while its grouped decision is in flight", async ({
  api,
  app,
}) => {
  const { seed, a, b } = await primeTwoCurrentAchievements(
    api,
    app,
    "wording-assignment-race",
  );
  const achievement = seed.library.roles[0]!.achievements[0]!;
  const beforeCreation = app.external.calls.length;
  const before = await json<Library>(api, "get", "/v1/profile/wording");
  const proposedText =
    "Implemented the durable workflow service with its documented recovery process.";
  const proposed = await json<Library>(api, "post", "/v1/profile/wording", {
    expectedProfileVersion: before.profileVersion,
    achievementId: achievement.achievement_id,
    text: proposedText,
    sourceRefs: achievement.source_refs,
    replacesVariantId: a.variant_id,
    replacesVariantRevision: a.variant_revision,
    intendedRequirementIds: [a.requirement_id],
  });
  const variant = proposed.variants.find((row) => row.text === proposedText)!;
  await json<Library>(
    api,
    "post",
    `/v1/profile/wording/${variant.variant_id}/decision`,
    {
      expectedProfileVersion: proposed.profileVersion,
      expectedVariantRevision: variant.revision,
      exactText: variant.text,
      decision: "approve",
    },
  );
  expect(
    app.external.calls.length,
    "Saving and approving text does not admit semantic work",
  ).toBe(beforeCreation);
  const originalA = exactPins(
    (await assignments(api)).filter(
      (row) => row.assignment_id === a.assignment_id,
    ),
  );
  const admitted = await startRefresh(
    api,
    refreshPayload(await pending(api)),
    "wording-assignment-race-held",
  );
  const grouped = await modelCall(app, "fit.wording-coverage-grouped");
  expect(
    (grouped.body["context"] as GroupedCoverageContext).binding.achievement_id,
  ).toBe(a.achievement_id);
  // A real external determination is pending. B changes through its independent
  // public CAS endpoint without changing any Profile fact, variant or approval.
  const removedB = await changeState(api, b, "removed");
  expect(removedB).toMatchObject({
    assignment_id: b.assignment_id,
    state: "removed",
    revision: b.revision + 1,
  });
  grouped.reply(
    groupedCoverageDecision(grouped, {
      evidenceSourceId: `evidence:${achievement.source_refs[0]!.source_id}`,
      status: "covered",
      action: "reuse_approved",
      reusableVariantId: a.variant_id,
    }),
  );
  expect((await terminal(api, admitted.runId))["status"]).toBe("failed");
  expect(await operation(api, admitted.runId)).toMatchObject({
    status: "stale",
    failure_code: "revision_conflict",
  });
  expect(
    exactPins(
      (await assignments(api)).filter(
        (row) => row.assignment_id === a.assignment_id,
      ),
    ),
  ).toEqual(originalA);
  expect(
    (await assignments(api)).find(
      (row) => row.assignment_id === b.assignment_id,
    ),
  ).toMatchObject({
    state: "removed",
    revision: removedB.revision,
  });
  const afterFailure = app.external.calls.length;
  await pending(api);
  await operation(api, admitted.runId);
  expect(
    app.external.calls.length,
    "Failure/pending reads do not start another allowance",
  ).toBe(afterFailure);
});

async function captureOneExistingRequirement(
  api: APIRequestContext,
  app: ApplicationStack,
  requirementId: string,
) {
  const posting = await createPosting(api, "wording-scope-one-requirement");
  const extracting = api.post(`/v1/jobs/${posting.job_id}/requirements`, {
    data: { expected_posting_revision: posting.revision, expected_revision: 0 },
  });
  const extraction = await modelCall(app, "requirements.extract");
  const source = modelSources(extraction)[0]!;
  const text = "Implement and maintain durable workflow recovery.";
  const start = source.text.indexOf(text);
  expect(start).toBeGreaterThanOrEqual(0);
  extraction.reply(typedExtraction(extraction, { requirements: [{ localId: "recovery", text }] }));
  const matching = await modelCall(app, "requirements.match_catalog");
  matching.reply(
    catalogMatching(matching, {
      recovery: { verdict: "equivalent", requirementId },
    }),
  );
  expect((await extracting).status()).toBe(200);
  const beforeAssess = app.external.calls.length;
  await json(api, "post", `/v1/jobs/${posting.job_id}/fit/assess`, {
    expected_revision: 0,
    prepare_wording: false,
    prepare_coverage: false,
  });
  expect(
    app.external.calls.length,
    "The exact canonical qualification is reused for the second job",
  ).toBe(beforeAssess);
  return posting;
}

const acceptedHash = async (api: APIRequestContext, resumeId: string) => {
  const exported = await api.get(
    `/v1/resumes/${resumeId}/export?format=pdf&accepted=true`,
  );
  expect(exported.status(), await exported.text()).toBe(200);
  const bytes = await exported.body();
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  return createHash("sha256").update(bytes).digest("hex");
};

test("resume freshness follows relevant current wording only and preserves accepted bytes across assignment edits", async ({
  api,
  app,
}) => {
  const { seed, a, b } = await primeTwoCurrentAchievements(
    api,
    app,
    "wording-resume-scope",
  );
  const posting = await captureOneExistingRequirement(
    api,
    app,
    a.requirement_id,
  );
  let resume = (
    await json<{ resume: Resume }>(api, "post", "/v1/resumes", {
      job_id: posting.job_id,
      expected_profile_revision: seed.profile.profileVersion,
      profile_id: "default",
      mode: "tailored",
    })
  ).resume;
  expect(current(resume).selected_variants).toHaveLength(3);
  expect(current(resume).document.experience.map((row) => row.id)).toEqual([
    "role-current",
    "role-earlier",
  ]);
  const reviewing = api.post(`/v1/resumes/${resume.resume_id}/review`, {
    data: { expected_version: resume.version },
  });
  const review = await modelCall(app, "resumes.coherence");
  review.reply({ verdict: "pass", findings: [] });
  const reviewed = await reviewing;
  expect(reviewed.status()).toBe(200);
  resume = ((await reviewed.json()) as { resume: Resume }).resume;
  resume = (
    await json<{ resume: Resume }>(
      api,
      "post",
      `/v1/resumes/${resume.resume_id}/render`,
      {
        expected_version: resume.version,
      },
    )
  ).resume;
  resume = (
    await json<{ resume: Resume }>(
      api,
      "post",
      `/v1/resumes/${resume.resume_id}/accept`,
      {
        expected_version: resume.version,
        override_review: false,
      },
    )
  ).resume;
  const acceptedRevision = resume.accepted_revision_id;
  const acceptedVersion = resume.version;
  const bytesBefore = await acceptedHash(api, resume.resume_id);
  expect(
    (await getFreshResume(api, resume.resume_id)).composition_freshness.current,
  ).toBe(true);
  const beforeChanges = app.external.calls.length;

  await changeState(api, b, "removed");
  const afterUnrelated = await getFreshResume(api, resume.resume_id);
  expect(afterUnrelated.composition_freshness).toMatchObject({
    current: true,
    stale_reasons: [],
  });
  expect(afterUnrelated.accepted_revision_id).toBe(acceptedRevision);
  expect(afterUnrelated.version).toBe(acceptedVersion);
  expect(await acceptedHash(api, resume.resume_id)).toBe(bytesBefore);
  const listedUnrelated = (
    await json<{ resumes: FreshResume[] }>(
      api,
      "get",
      `/v1/resumes?jobId=${posting.job_id}`,
    )
  ).resumes.find((row) => row.resume_id === resume.resume_id)!;
  expect(listedUnrelated.composition_freshness.current).toBe(true);

  await changeState(api, a, "removed");
  const afterRelevant = await getFreshResume(api, resume.resume_id);
  expect(afterRelevant.composition_freshness.current).toBe(false);
  expect(afterRelevant.composition_freshness.stale_reasons).toContain(
    "fit_coverage_changed",
  );
  expect(afterRelevant.accepted_freshness).toMatchObject({
    status: "current",
    coverage_stale: true,
  });
  expect(afterRelevant.accepted_revision_id).toBe(acceptedRevision);
  expect(afterRelevant.current_revision).toBe(resume.current_revision);
  expect(afterRelevant.version).toBe(acceptedVersion);
  expect(await acceptedHash(api, resume.resume_id)).toBe(bytesBefore);
  const listedRelevant = (
    await json<{ resumes: FreshResume[] }>(
      api,
      "get",
      `/v1/resumes?jobId=${posting.job_id}`,
    )
  ).resumes.find((row) => row.resume_id === resume.resume_id)!;
  expect(listedRelevant.composition_freshness.current).toBe(false);
  expect(
    app.external.calls.length,
    "Assignment edits and freshness/PDF reads make no model calls",
  ).toBe(beforeChanges);
});
