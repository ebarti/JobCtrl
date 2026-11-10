import {
  test,
  expect,
  json,
  modelCall,
  action,
  completed,
  terminal,
  type ExternalCall,
} from "../harness/fixtures.js";
import { type Library } from "./core-data.js";
import {
  createScoredFit,
  groupedCoverageDecision,
  refreshPayload,
  startRefresh,
  type FitState,
  type GroupedCoverageContext,
  type PendingRefresh,
  type RefreshOperation,
} from "./fit-data.js";
import { citeSources, modelSources } from "./requirements-data.js";

type Proposal = {
  proposal_id: string;
  achievement_id: string;
  origin_key: string;
  status: string;
  variant_id: string | null;
  retry_of_proposal_id: string | null;
  retry_of_origin_key: string | null;
};
type WordingLibrary = Library & { proposals: Proposal[] };
const pending = (api: Parameters<typeof json>[0]) =>
  json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending");

function uncertainWording(call: ExternalCall) {
  call.reply({
    support: "uncertain",
    text: null,
    rationale:
      "This explicit source-bound choice does not establish a safe new expression for approval.",
    citations: citeSources(
      call,
      modelSources(call).map((row) => row.source_id),
    ),
  });
}

test("uncertain wording remains failed and a selected retry preserves lineage and another achievement's pending work", async ({
  api,
  app,
  page,
}, testInfo) => {
  const seed = await createScoredFit(api, app, "wording-recovery", {
    twoRequirements: true,
  });
  const achievements = seed.library.roles[0]!.achievements;
  const before = app.external.calls.length;
  const first = await startRefresh(
    api,
    refreshPayload(await pending(api)),
    "wording-uncertain-original",
  );
  for (let index = 0; index < 2; index += 1) {
    const grouped = await modelCall(app, "fit.wording-coverage-grouped");
    const context = grouped.body["context"] as GroupedCoverageContext;
    const achievement = achievements.find(
      (row) => row.achievement_id === context.binding.achievement_id,
    )!;
    expect(achievement).toBeTruthy();
    grouped.reply(
      groupedCoverageDecision(grouped, {
        evidenceSourceId: `evidence:${achievement.source_refs[0]!.source_id}`,
        status: "not_covered",
        action: "propose_wording",
        gapRequirementIds: context.binding.requirements.map(
          (row) => row.requirement_id,
        ),
      }),
    );
  }
  const originalBriefs = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < 2; index += 1) {
    const call = await modelCall(app, "profile.wording_authoring");
    const brief = call.body["context"] as Record<string, unknown>;
    originalBriefs.set(String(brief["achievement_id"]), brief);
    uncertainWording(call);
  }
  expect(await terminal(api, first.runId)).toMatchObject({
    status: "failed",
    errorCode: "fit_refresh_wording_incomplete",
  });
  const failed = await json<RefreshOperation>(
    api,
    "get",
    `/v1/fit/refresh/operations/${first.runId}`,
  );
  expect(failed).toMatchObject({
    status: "failed",
    partial: true,
    counters: {
      model_calls: 4,
      wording_proposals: 2,
      requirements_assessed: 0,
    },
  });
  expect(failed.wording_failures).toHaveLength(2);
  const current = await pending(api);
  expect(current.pending_wording_failures).toHaveLength(2);
  const firstFailure = current.pending_wording_failures.find(
    (row) => row.achievement_id === achievements[0]!.achievement_id,
  )!;
  const otherFailure = current.pending_wording_failures.find(
    (row) => row.achievement_id === achievements[1]!.achievement_id,
  )!;
  expect(firstFailure.status).toBe("uncertain");
  expect(otherFailure.status).toBe("uncertain");
  const beforeLibrary = await json<WordingLibrary>(
    api,
    "get",
    "/v1/profile/wording",
  );
  const originalA = beforeLibrary.proposals.find(
    (row) => row.proposal_id === firstFailure.proposal_id,
  )!;
  const originalB = beforeLibrary.proposals.find(
    (row) => row.proposal_id === otherFailure.proposal_id,
  )!;
  expect(originalA.status).toBe("uncertain");
  expect(originalB.status).toBe("uncertain");
  expect(
    beforeLibrary.variants.filter((row) => row.status === "pending"),
  ).toEqual([]);
  const profile = await json<{ profileVersion: number }>(
    api,
    "get",
    "/v1/profile",
  );
  const originalBriefA = originalBriefs.get(achievements[0]!.achievement_id)!;
  const beforeForgery = app.external.calls.length;
  const forged = await action(api, "profile.author_wording", {
    ...originalBriefA,
    origin_key: "synthetic-forged-retry-lineage",
    profile_revision: profile.profileVersion,
    origin_metadata: {
      ...(originalBriefA["origin_metadata"] as Record<string, unknown>),
      retry_of_proposal_id: firstFailure.proposal_id,
      retry_of_origin_key: originalA.origin_key,
      prior_remote_outcome: "uncertain",
    },
  });
  expect(await terminal(api, forged.runId)).toMatchObject({
    status: "failed",
    errorCode: "invalid_authoring_retry",
  });
  expect(app.external.calls).toHaveLength(beforeForgery);
  expect(
    (await json<WordingLibrary>(api, "get", "/v1/profile/wording")).proposals,
  ).toEqual(beforeLibrary.proposals);
  expect((await pending(api)).pending_wording_failures).toEqual(
    current.pending_wording_failures,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/profile");
  const panel = page.getByRole("region", {
    name: "Affected matches",
    exact: true,
  });
  await expect(
    panel.getByRole("button", { name: "Retry failed wording", exact: true }),
  ).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await testInfo.attach("manual-wording-uncertain-desktop", {
    contentType: "image/png",
    body: await page.screenshot(),
  });

  const retryPayload = {
    ...refreshPayload(current, []),
    retry_wording_proposal_ids: [firstFailure.proposal_id],
  };
  const retryA = await startRefresh(api, retryPayload, "wording-retry-A");
  const authoringA = await modelCall(app, "profile.wording_authoring");
  const contextA = authoringA.body["context"] as {
    achievement_id: string;
    origin_metadata: {
      retry_of_proposal_id: string;
      retry_of_origin_key: string;
    };
  };
  expect(contextA).toMatchObject({
    achievement_id: achievements[0]!.achievement_id,
    origin_metadata: {
      retry_of_proposal_id: firstFailure.proposal_id,
      retry_of_origin_key: originalA.origin_key,
    },
  });
  const alternativeA =
    "Implemented durable workflow recovery with an explicit recovery record.";
  authoringA.reply({
    support: "supported",
    text: alternativeA,
    rationale:
      "The retried expression stays inside the same recorded source binding.",
    citations: citeSources(
      authoringA,
      modelSources(authoringA).map((row) => row.source_id),
    ),
  });
  await completed(api, retryA.runId);
  const afterA = await pending(api);
  expect(afterA.pending_wording_failures.map((row) => row.proposal_id)).toEqual(
    [otherFailure.proposal_id],
  );
  const afterLibraryA = await json<WordingLibrary>(
    api,
    "get",
    "/v1/profile/wording",
  );
  expect(
    afterLibraryA.proposals.find(
      (row) => row.proposal_id === firstFailure.proposal_id,
    ),
  ).toEqual(originalA);
  expect(
    afterLibraryA.proposals.find(
      (row) => row.proposal_id === otherFailure.proposal_id,
    ),
  ).toEqual(originalB);
  const successorA = afterLibraryA.proposals.find(
    (row) => row.retry_of_proposal_id === firstFailure.proposal_id,
  )!;
  expect(successorA).toMatchObject({
    status: "pending",
    achievement_id: achievements[0]!.achievement_id,
    retry_of_origin_key: originalA.origin_key,
  });
  expect(successorA.proposal_id).not.toBe(firstFailure.proposal_id);
  const variantA = afterLibraryA.variants.find(
    (row) => row.variant_id === successorA.variant_id,
  )!;
  expect(variantA.status).toBe("pending");
  expect(variantA.approval_id).toBeNull();
  expect(
    await json<RefreshOperation>(
      api,
      "get",
      `/v1/fit/refresh/operations/${first.runId}`,
    ),
  ).toEqual(failed);
  const beforeReplay = app.external.calls.length;
  expect((await startRefresh(api, retryPayload, "wording-retry-A")).runId).toBe(
    retryA.runId,
  );
  expect(app.external.calls).toHaveLength(beforeReplay);

  await page.reload();
  await expect(
    panel.getByRole("button", { name: "Retry failed wording", exact: true }),
  ).toBeEnabled();
  await expect(panel).toContainText("1 wording proposal can be retried");
  await panel.scrollIntoViewIfNeeded();
  await testInfo.attach("manual-wording-subset-retry-desktop", {
    contentType: "image/png",
    body: await page.screenshot(),
  });
  const admitted = page.waitForResponse(
    (response) =>
      response.url() === `${app.baseURL}/v1/actions/fit.refresh` &&
      response.request().method() === "POST",
  );
  await panel
    .getByRole("button", { name: "Retry failed wording", exact: true })
    .click();
  const response = await admitted;
  expect(response.status(), await response.text()).toBe(202);
  expect(response.request().postDataJSON()).toMatchObject({
    job_ids: [],
    retry_wording_proposal_ids: [otherFailure.proposal_id],
  });
  const retryB = (await response.json()) as { runId: string };
  const authoringB = await modelCall(app, "profile.wording_authoring");
  expect(authoringB.body["context"]).toMatchObject({
    achievement_id: achievements[1]!.achievement_id,
    origin_metadata: {
      retry_of_proposal_id: otherFailure.proposal_id,
      retry_of_origin_key: originalB.origin_key,
    },
  });
  authoringB.reply({
    support: "supported",
    text: "Established explicit review ownership for supervised operational changes.",
    rationale:
      "This separately retried expression stays within its own achievement evidence.",
    citations: citeSources(
      authoringB,
      modelSources(authoringB).map((row) => row.source_id),
    ),
  });
  await completed(api, retryB.runId);
  expect((await pending(api)).pending_wording_failures).toEqual([]);
  const finalLibrary = await json<WordingLibrary>(
    api,
    "get",
    "/v1/profile/wording",
  );
  expect(
    finalLibrary.variants.filter((row) => row.status === "pending"),
  ).toHaveLength(2);
  expect(
    finalLibrary.variants.filter((row) => row.status === "approved"),
  ).toEqual(beforeLibrary.variants.filter((row) => row.status === "approved"));
  expect(
    (await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`))
      .score,
  ).toEqual(seed.fit.score);
  expect(
    app.external.calls
      .slice(before)
      .filter((call) => call.path === "/model")
      .map((call) => call.body["operation"]),
  ).toEqual([
    "fit.wording-coverage-grouped",
    "fit.wording-coverage-grouped",
    "profile.wording_authoring",
    "profile.wording_authoring",
    "profile.wording_authoring",
    "profile.wording_authoring",
  ]);
  const health = await json<{ llmSpend: { accountingComplete: boolean } }>(
    api,
    "get",
    "/v1/health",
  );
  expect(health.llmSpend.accountingComplete).toBe(true);
});
