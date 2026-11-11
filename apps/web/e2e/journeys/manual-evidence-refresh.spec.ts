import type { APIRequestContext } from "@playwright/test";
import {
  test,
  expect,
  json,
  modelCall,
  action,
  completed,
  terminal,
  type ApplicationStack,
} from "../harness/fixtures.js";
import { createPosting, type Library, type Profile } from "./core-data.js";
import {
  createScoredFit,
  groupedCoverageDecision,
  impactPartition,
  qualificationDecision,
  refreshPayload,
  startRefresh,
  type FitState,
  type GroupedCoverageContext,
  type ImpactContext,
  type PendingRefresh,
  type RefreshOperation,
} from "./fit-data.js";
import {
  catalogMatching,
  citeSources,
  modelSources,
} from "./requirements-data.js";

const modelOperations = (app: ApplicationStack, since = 0) =>
  app.external.calls
    .slice(since)
    .filter((call) => call.path === "/model")
    .map((call) => call.body["operation"]);
const pendingRefresh = (api: APIRequestContext) =>
  json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending");
const operation = (api: APIRequestContext, runId: string) =>
  json<RefreshOperation>(api, "get", `/v1/fit/refresh/operations/${runId}`);

async function saveName(api: APIRequestContext, name: string) {
  const current = await json<Profile>(api, "get", "/v1/profile");
  return json<Profile>(api, "patch", "/v1/profile", {
    expectedProfileVersion: current.profileVersion,
    profile: {
      ...current.profile,
      personal: { ...current.profile.personal, full_name: name },
    },
  });
}

async function saveOwnership(api: APIRequestContext) {
  const current = await json<Profile>(api, "get", "/v1/profile");
  const profile = structuredClone(current.profile);
  profile.resume.experience_entries[0]!.bullets[1] =
    "Established explicit review ownership for operational changes and retained the review receipts.";
  return json<Profile>(api, "patch", "/v1/profile", {
    expectedProfileVersion: current.profileVersion,
    profile,
  });
}

test("Profile manually updates the previously missing match, reuses unaffected authority and leaves wording approval explicit", async ({
  page,
  api,
  app,
}, testInfo) => {
  const seed = await createScoredFit(api, app, "manual-profile", {
    twoRequirements: true,
    missingOwnership: true,
  });
  const recoveryId = seed.requirements.requirements[0]!.requirement_id;
  const ownershipId = seed.requirements.requirements[1]!.requirement_id;
  const recoveryAchievement = seed.library.roles[0]!.achievements[0]!;
  const ownershipAchievement = seed.library.roles[0]!.achievements[1]!;
  const preparing = api.post(
    `/v1/jobs/${seed.posting.job_id}/fit/coverage/refresh`,
    {
      data: { prepare_wording: false },
    },
  );
  const oldCoverage = await modelCall(app, "fit.wording-coverage-grouped");
  oldCoverage.reply(
    groupedCoverageDecision(oldCoverage, {
      evidenceSourceId: `evidence:${recoveryAchievement.source_refs[0]!.source_id}`,
      status: "covered",
      action: "reuse_approved",
      reusableVariantId: recoveryAchievement.baseline_variant_id,
    }),
  );
  expect((await preparing).status()).toBe(200);
  const beforeEdits = app.external.calls.length;
  await saveOwnership(api);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/profile");
  await expect(page).toHaveURL(/\/profile\/?$/);
  await expect(page).toHaveTitle(/JobCtrl/);
  await page
    .getByLabel("Full name", { exact: true })
    .fill("Synthetic Manual Refresh Candidate");
  const saved = page.waitForResponse(
    (response) =>
      response.url() === `${app.baseURL}/v1/profile` &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  expect((await saved).status()).toBe(200);
  const panel = page.getByRole("region", {
    name: "Affected matches",
    exact: true,
  });
  const start = panel.getByRole("button", {
    name: "Update affected matches",
    exact: true,
  });
  await expect(start).toBeEnabled();
  await expect(panel).toContainText("Saved changes may affect matches.");
  await panel.scrollIntoViewIfNeeded();
  await testInfo.attach("manual-refresh-profile-desktop-ready", {
    contentType: "image/png",
    body: await page.screenshot(),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await expect(start).toBeVisible();
  await testInfo.attach("manual-refresh-profile-mobile-ready", {
    contentType: "image/png",
    body: await page.screenshot(),
  });
  expect(modelOperations(app, beforeEdits)).toEqual([]);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await start.focus();
  await expect(start).toBeFocused();
  const admitted = page.waitForResponse(
    (response) =>
      response.url() === `${app.baseURL}/v1/actions/fit.refresh` &&
      response.request().method() === "POST",
  );
  await start.press("Enter");
  const admission = await admitted;
  expect(admission.status(), await admission.text()).toBe(202);
  const receipt = (await admission.json()) as { runId: string };
  const request = admission.request();
  const payload = request.postDataJSON() as ReturnType<typeof refreshPayload>;
  const key = request.headers()["idempotency-key"]!;
  expect(key).toBeTruthy();
  expect(payload.job_ids).toEqual([seed.posting.job_id]);
  const selection = await modelCall(app, "fit.catalog-impact");
  const selectorContext = selection.body["context"] as ImpactContext;
  expect(selectorContext.requirements).toHaveLength(2);
  expect(
    selectorContext.requirements.find(
      (row) => row.requirement_id === ownershipId,
    )!.prior_assessment_id,
  ).toBe(
    seed.fit.score.assessments.find(
      (row) => row.requirement_id === ownershipId,
    )!.assessment_id,
  );
  expect((await operation(api, receipt.runId)).counters.model_calls).toBe(1);
  await expect(panel).toContainText("Update in progress.");
  await expect(
    panel.getByRole("button", { name: "Request cancellation", exact: true }),
  ).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await testInfo.attach("manual-refresh-profile-running", {
    contentType: "image/png",
    body: await page.screenshot(),
  });
  selection.reply(
    impactPartition(selection, {
      [recoveryId]: "unchanged",
      [ownershipId]: "affected",
    }),
  );
  const qualification = await modelCall(app, "fit.qualification");
  expect(
    (qualification.body["context"] as { binding: { requirement_id: string } })
      .binding.requirement_id,
  ).toBe(ownershipId);
  qualification.reply(
    qualificationDecision(qualification, {
      achievementIds: [ownershipAchievement.achievement_id],
      evidenceSourceIds: [
        `evidence:${ownershipAchievement.source_refs[0]!.source_id}`,
      ],
    }),
  );
  const coverage = await modelCall(app, "fit.wording-coverage-grouped");
  expect(
    (coverage.body["context"] as GroupedCoverageContext).binding.achievement_id,
  ).toBe(ownershipAchievement.achievement_id);
  coverage.reply(
    groupedCoverageDecision(coverage, {
      evidenceSourceId: `evidence:${ownershipAchievement.source_refs[0]!.source_id}`,
      status: "not_covered",
      action: "propose_wording",
      gapRequirementIds: [ownershipId],
    }),
  );
  const authoring = await modelCall(app, "profile.wording_authoring");
  const alternative =
    "Established explicit review ownership with retained operational change receipts.";
  authoring.reply({
    support: "supported",
    text: alternative,
    rationale:
      "The expression preserves the explicitly cited current achievement facts.",
    citations: citeSources(
      authoring,
      modelSources(authoring).map((row) => row.source_id),
    ),
  });
  await completed(api, receipt.runId);
  const result = await operation(api, receipt.runId);
  expect(result).toMatchObject({
    status: "completed",
    selected_requirement_ids: [ownershipId],
    factual_published: true,
    counters: {
      model_calls: 4,
      requirements_assessed: 1,
      qualifications_reused: 1,
      wording_proposals: 1,
    },
  });
  const refreshed = await json<FitState>(
    api,
    "get",
    `/v1/jobs/${seed.posting.job_id}/fit`,
  );
  expect(refreshed.current).toBe(true);
  expect(refreshed.score.score).toBe(10);
  expect(
    refreshed.score.assessments.find(
      (row) => row.requirement_id === ownershipId,
    )!.kind,
  ).toBe("matched");
  const ownershipAfter = refreshed.score.assessments.find(
    (row) => row.requirement_id === ownershipId,
  )!;
  expect(ownershipAfter.determination_id).toBeTruthy();
  expect(ownershipAfter.provenance).toMatchObject({
    receipt_id: ownershipAfter.determination_id,
    provider: qualification.body["provider"],
    model: qualification.body["model"],
    lane: qualification.body["lane"],
  });
  const recoveryBefore = seed.fit.score.assessments.find(
    (row) => row.requirement_id === recoveryId,
  )!;
  const recoveryAfter = refreshed.score.assessments.find(
    (row) => row.requirement_id === recoveryId,
  )!;
  expect(recoveryAfter.determination_id).toBe(recoveryBefore.determination_id);
  expect(recoveryAfter.provenance).toEqual(recoveryBefore.provenance);
  expect(modelOperations(app, beforeEdits)).toEqual([
    "fit.catalog-impact",
    "fit.qualification",
    "fit.wording-coverage-grouped",
    "profile.wording_authoring",
  ]);
  await expect(panel).toContainText("Update completed.");
  await panel.scrollIntoViewIfNeeded();
  await testInfo.attach("manual-refresh-profile-completed-desktop", {
    contentType: "image/png",
    body: await page.screenshot(),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await testInfo.attach("manual-refresh-profile-completed-mobile", {
    contentType: "image/png",
    body: await page.screenshot(),
  });

  const beforeRetry = app.external.calls.length;
  expect((await startRefresh(api, payload, key)).runId).toBe(receipt.runId);
  expect(await operation(api, receipt.runId)).toEqual(result);
  expect(modelOperations(app, beforeRetry)).toEqual([]);
  const proposed = await json<Library>(api, "get", "/v1/profile/wording");
  const variant = proposed.variants.find((row) => row.text === alternative)!;
  expect(variant.status).toBe("pending");
  expect(variant.approval_id).toBeNull();
  expect((await pendingRefresh(api)).latest_operation!.status).toBe(
    "completed",
  );
  await json(
    api,
    "post",
    `/v1/profile/wording/${encodeURIComponent(variant.variant_id)}/decision`,
    {
      expectedProfileVersion: proposed.profileVersion,
      expectedVariantRevision: variant.revision,
      exactText: variant.text,
      decision: "approve",
    },
  );
  expect(
    (await json<Library>(api, "get", "/v1/profile/wording")).variants.find(
      (row) => row.variant_id === variant.variant_id,
    )!.status,
  ).toBe("approved");
  await pendingRefresh(api);
  expect(modelOperations(app, beforeRetry)).toEqual([]);
});

test("manual cancellation retains accepted scores and distinct keys cannot admit a competing Profile refresh", async ({
  api,
  app,
}) => {
  const seed = await createScoredFit(api, app, "manual-cancel");
  await saveName(api, "Synthetic Changed Candidate");
  const pending = await pendingRefresh(api);
  const payload = refreshPayload(pending);
  const before = app.external.calls.length;
  const run = await startRefresh(api, payload, "manual-cancel-original");
  const held = await modelCall(app, "fit.catalog-impact");
  const retry = await startRefresh(api, payload, "manual-cancel-original");
  expect(retry.runId).toBe(run.runId);
  const competing = await api.post("/v1/actions/fit.refresh", {
    headers: { "idempotency-key": "manual-cancel-competing" },
    data: payload,
  });
  expect(competing.status()).toBe(409);
  expect(await competing.json()).toMatchObject({
    error: { code: "action_scope_busy", details: { runId: run.runId } },
  });
  await json(api, "post", `/v1/action-runs/${run.runId}/cancel`, {});
  held.reply(
    impactPartition(held, {
      [seed.requirements.requirements[0]!.requirement_id]: "unchanged",
    }),
  );
  const cancelled = await terminal(api, run.runId);
  expect(cancelled["status"]).toBe("cancelled");
  const result = await operation(api, run.runId);
  expect(result.status).toBe("cancelled");
  expect(result.counters.model_calls).toBe(1);
  expect(result.factual_published).toBe(false);
  expect(
    (await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`))
      .score,
  ).toEqual(seed.fit.score);
  expect(modelOperations(app, before)).toEqual(["fit.catalog-impact"]);
});

test("manual work limits persist across worker restart and an exact retry cannot reset the allowance", async ({
  api,
  app,
}) => {
  const seed = await createScoredFit(api, app, "manual-limits", {
    twoRequirements: true,
    missingOwnership: true,
  });
  await saveOwnership(api);
  const payload = refreshPayload(await pendingRefresh(api), undefined, {
    max_model_calls: 1,
  });
  const before = app.external.calls.length;
  const run = await startRefresh(api, payload, "manual-fixed-limit");
  const selection = await modelCall(app, "fit.catalog-impact");
  selection.reply(
    impactPartition(selection, {
      [seed.requirements.requirements[0]!.requirement_id]: "unchanged",
      [seed.requirements.requirements[1]!.requirement_id]: "affected",
    }),
  );
  const failed = await terminal(api, run.runId);
  expect(failed).toMatchObject({
    status: "failed",
    errorCode: "fit_refresh_model_limit",
  });
  const limited = await operation(api, run.runId);
  expect(limited).toMatchObject({
    status: "limited",
    factual_published: false,
    counters: { model_calls: 1, requirements_assessed: 0 },
  });
  const replacement = await app.restartWorker();
  expect(replacement.current).not.toBe(replacement.previous);
  expect((await startRefresh(api, payload, "manual-fixed-limit")).runId).toBe(
    run.runId,
  );
  expect(await operation(api, run.runId)).toEqual(limited);
  expect(
    (await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`))
      .score,
  ).toEqual(seed.fit.score);
  expect(modelOperations(app, before)).toEqual(["fit.catalog-impact"]);
});

for (const changedSource of ["Profile", "posting", "catalog"] as const) {
  test(`a ${changedSource} change during the manual selector preserves accepted scores`, async ({
    api,
    app,
  }) => {
    const seed = await createScoredFit(
      api,
      app,
      `manual-stale-${changedSource.toLowerCase()}`,
    );
    const settings = await json<{ revision: number }>(
      api,
      "get",
      "/v1/settings",
    );
    await json(api, "patch", "/v1/settings", {
      expectedRevision: settings.revision,
      dailyBudgetUsd: 0,
    });
    await saveName(api, "Synthetic First Saved Change");
    const payload = refreshPayload(await pendingRefresh(api));
    const before = app.external.calls.length;
    const run = await startRefresh(
      api,
      payload,
      `manual-stale-${changedSource}`,
    );
    const held = await modelCall(app, "fit.catalog-impact");
    if (changedSource === "Profile")
      await saveName(api, "Synthetic Later Saved Change");
    if (changedSource === "posting")
      await json(api, "patch", `/v1/jobs/${seed.posting.job_id}`, {
        expectedRevision: seed.posting.revision,
        description: "Own a materially revised workflow recovery requirement.",
      });
    if (changedSource === "catalog") {
      const posting = await createPosting(api, "concurrent-catalog-addition");
      const extracting = api.post(`/v1/jobs/${posting.job_id}/requirements`, {
        data: {
          expected_posting_revision: posting.revision,
          expected_revision: 0,
        },
      });
      const call = await modelCall(app, "requirements.extract");
      const source = modelSources(call)[0]!;
      call.reply({
        status: "complete",
        requirements: [
          {
            local_id: "separate",
            text: source.text,
            definition: "Own a separate qualified operational responsibility",
            qualifiers: [
              { dimension: "domain", value: "separate synthetic service" },
            ],
            scope: "resume",
            tier: "must_have",
            weight: 1,
            support: "supported",
            spans: [{ start: 0, end: source.text.length, quote: source.text }],
          },
        ],
        reason:
          "Explicit distinct canonical addition from this current source.",
        citations: citeSources(call, [source.source_id]),
      });
      const matching = await modelCall(app, "requirements.match_catalog");
      matching.reply(
        catalogMatching(matching, { separate: { verdict: "new" } }),
      );
      const response = await extracting;
      expect(response.status(), await response.text()).toBe(200);
    }
    held.reply(
      impactPartition(held, {
        [seed.requirements.requirements[0]!.requirement_id]: "unchanged",
      }),
    );
    expect((await terminal(api, run.runId))["status"]).toBe("failed");
    const stale = await operation(api, run.runId);
    expect(stale.status).toBe("stale");
    expect(stale.factual_published).toBe(false);
    expect(
      (await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`))
        .score,
    ).toEqual(seed.fit.score);
    expect(
      modelOperations(app, before).filter((value) =>
        String(value).startsWith("fit."),
      ),
    ).toEqual(["fit.catalog-impact"]);
  });
}

test("a saved change while a manual refresh is queued refuses before any selector call", async ({
  api,
  app,
}) => {
  const seed = await createScoredFit(api, app, "manual-queued");
  const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", {
    expectedRevision: settings.revision,
    workerActivitySlots: 1,
  });
  const replacement = await app.restartWorker();
  expect(replacement.current).not.toBe(replacement.previous);
  await saveName(api, "Synthetic Reviewed Queued Change");
  const payload = refreshPayload(await pendingRefresh(api));
  const blockerPosting = await createPosting(api, "manual-queue-blocker");
  const before = app.external.calls.length;
  const blocker = await action(api, "requirements.refresh", {
    job_id: blockerPosting.job_id,
    expected_posting_revision: blockerPosting.revision,
    expected_revision: 0,
  });
  const held = await modelCall(app, "requirements.extract");
  const queued = await startRefresh(api, payload, "manual-queued-stamp");
  await expect
    .poll(
      async () =>
        (
          await json<{ status: string }>(
            api,
            "get",
            `/v1/action-runs/${queued.runId}`,
          )
        ).status,
    )
    .toBe("queued");
  await saveName(api, "Synthetic Newer Queued Change");
  held.reply({
    status: "complete",
    requirements: [],
    reason: "Explicit empty inventory for this controlled external boundary.",
    citations: citeSources(held, [modelSources(held)[0]!.source_id]),
  });
  await completed(api, blocker.runId);
  expect(await terminal(api, queued.runId)).toMatchObject({
    status: "failed",
    errorCode: "fit_refresh_stale",
  });
  expect(
    (await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`))
      .score,
  ).toEqual(seed.fit.score);
  expect(modelOperations(app, before)).toEqual(["requirements.extract"]);
});

test("one grouped achievement decision proposes one wording for its full requirement set and its own write never starts another run", async ({
  api,
  app,
}) => {
  const seed = await createScoredFit(api, app, "manual-grouped", {
    twoRequirements: true,
    sameAchievement: true,
  });
  const achievement = seed.library.roles[0]!.achievements[0]!;
  const ids = seed.requirements.requirements.map((row) => row.requirement_id);
  const before = app.external.calls.length;
  const run = await startRefresh(
    api,
    refreshPayload(await pendingRefresh(api)),
    "manual-grouped-original",
  );
  const grouped = await modelCall(app, "fit.wording-coverage-grouped");
  expect(
    (grouped.body["context"] as GroupedCoverageContext).binding.requirements
      .map((row) => row.requirement_id)
      .sort(),
  ).toEqual(ids.toSorted());
  grouped.reply(
    groupedCoverageDecision(grouped, {
      evidenceSourceId: `evidence:${achievement.source_refs[0]!.source_id}`,
      status: "not_covered",
      action: "propose_wording",
      gapRequirementIds: ids,
    }),
  );
  const authoring = await modelCall(app, "profile.wording_authoring");
  const wording =
    "Implemented durable workflow recovery with explicit operational change review ownership.";
  const context = authoring.body["context"] as {
    brief?: {
      origin_metadata?: { requirements?: { requirement_id: string }[] };
    };
    origin_metadata?: { requirements?: { requirement_id: string }[] };
  };
  const metadata = context.brief?.origin_metadata ?? context.origin_metadata;
  expect(
    metadata?.requirements?.map((row) => row.requirement_id).sort(),
  ).toEqual(ids.toSorted());
  authoring.reply({
    support: "supported",
    text: wording,
    rationale:
      "One proposal preserves the complete authored achievement and both supported requirements.",
    citations: citeSources(
      authoring,
      modelSources(authoring).map((row) => row.source_id),
    ),
  });
  await completed(api, run.runId);
  expect(await operation(api, run.runId)).toMatchObject({
    status: "completed",
    counters: {
      model_calls: 2,
      requirements_assessed: 0,
      qualifications_reused: 2,
      wording_proposals: 1,
    },
  });
  const library = await json<Library>(api, "get", "/v1/profile/wording");
  const proposed = library.variants.filter((row) => row.status === "pending");
  expect(proposed).toHaveLength(1);
  expect(proposed[0]!.text).toBe(wording);
  expect(proposed[0]!.achievement_id).toBe(achievement.achievement_id);
  expect(
    (await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`))
      .score,
  ).toEqual(seed.fit.score);
  const beforeUnchanged = app.external.calls.length;
  const unchanged = await startRefresh(
    api,
    refreshPayload(await pendingRefresh(api)),
    "manual-grouped-unchanged",
  );
  await completed(api, unchanged.runId);
  expect((await operation(api, unchanged.runId)).counters.model_calls).toBe(0);
  expect(modelOperations(app, beforeUnchanged)).toEqual([]);
  expect(modelOperations(app, before)).toEqual([
    "fit.wording-coverage-grouped",
    "profile.wording_authoring",
  ]);
});
