import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";

import { loadE2eDbPath } from "../fixtures/e2e-state.js";

const STYLE_RECOMMENDATION_ID = `learning-recommendation:${"a".repeat(64)}`;
const FACTUAL_RECOMMENDATION_ID = `learning-recommendation:${"b".repeat(64)}`;
const ACCEPTED_REVIEW_ID = `learning-recommendation-review:${"c".repeat(64)}`;
const REJECTED_REVIEW_ID = `learning-recommendation-review:${"d".repeat(64)}`;
const ACCEPTED_AT = "2026-05-04T11:20:00.000Z";
const REJECTED_AT = "2026-05-04T11:21:00.000Z";
const ROLLED_BACK_AT = "2026-05-04T11:22:00.000Z";

test("Dashboard learning review keeps evidence, terminal decisions, and policy rollback auditable", async ({
  page,
}) => {
  const dbPath = loadE2eDbPath();
  await installDeterministicLearningWrites(page, dbPath);

  const initialRecommendations = page.waitForResponse(
    (response) =>
      response.url().includes("/v1/learning/recommendations") &&
      response.request().method() === "GET",
  );
  const initialPolicyHistory = page.waitForResponse(
    (response) =>
      response.url().includes("/v1/learning/policies/materials") &&
      response.request().method() === "GET",
  );
  await page.goto("/dashboard");
  expect((await initialRecommendations).status()).toBe(200);
  expect((await initialPolicyHistory).status()).toBe(200);

  const recommendations = page.locator(".learning-review-panel");
  const policyHistory = page.locator(".tailoring-policy-history-panel");
  const styleRecommendation = recommendations.getByRole("article", {
    name: "style_guidance → preserve_user_edit_pattern",
  });
  const factualRecommendation = recommendations.getByRole("article", {
    name: "fact_handling → require_source_match",
  });

  await expect(styleRecommendation).toBeVisible({ timeout: 30_000 });
  await expect(factualRecommendation).toBeVisible();
  await expect(
    styleRecommendation.getByText("3 of 3 required accepted signals across 2 of 2 required jobs"),
  ).toBeVisible();
  await expect(policyHistory.getByRole("article", { name: "Version 1" })).toBeVisible();
  await expect(
    policyHistory.getByRole("button", { name: "Restore tailoring policy version 1" }),
  ).toHaveCount(0);

  await styleRecommendation
    .getByRole("button", { name: "Inspect evidence for style_guidance → preserve_user_edit_pattern" })
    .click();
  const evidence = styleRecommendation.getByRole("list", {
    name: "Evidence for style_guidance → preserve_user_edit_pattern",
  });
  await expect(evidence.getByText("tailoring-feedback:qa-learning-style-1:1")).toBeVisible();
  await expect(
    evidence.getByText(/revision 1 · job abaf847c-43cd-40ad-8dc3-76685694ff29/i),
  ).toHaveCount(2);
  await expect(
    evidence.getByText(/revision 1 · job 1b34c69a-9c9f-4f67-8bd1-9682a6ff492a/i),
  ).toHaveCount(1);

  await styleRecommendation
    .getByRole("button", {
      name: "Accept learning recommendation style_guidance → preserve_user_edit_pattern",
    })
    .click();
  await expect(styleRecommendation).toHaveCount(0);
  const acceptedRecommendations = page.waitForResponse(
    (response) =>
      response.url().includes("/v1/learning/recommendations") &&
      response.request().method() === "GET",
  );
  const acceptedHistory = page.waitForResponse(
    (response) =>
      response.url().includes("/v1/learning/policies/materials") &&
      response.request().method() === "GET",
  );
  await page.reload();
  expect((await acceptedRecommendations).status()).toBe(200);
  expect((await acceptedHistory).status()).toBe(200);
  const acceptedPolicy = policyHistory.getByRole("article", { name: "Version 2" });
  await expect(acceptedPolicy).toBeVisible();
  await expect(acceptedPolicy.getByText("Current")).toBeVisible();
  await expect(
    acceptedPolicy.getByText(`Accepted recommendation ${STYLE_RECOMMENDATION_ID}`),
  ).toBeVisible();
  await expect(acceptedPolicy.getByText(`Review ${ACCEPTED_REVIEW_ID}`)).toBeVisible();

  await factualRecommendation
    .getByRole("button", {
      name: "Reject learning recommendation fact_handling → require_source_match",
    })
    .click();
  await expect(factualRecommendation).toHaveCount(0);
  expect(currentPolicyVersion(dbPath)).toBe(2);

  const rejectedRecommendations = page.waitForResponse(
    (response) =>
      response.url().includes("/v1/learning/recommendations") &&
      response.request().method() === "GET",
  );
  const rejectedHistory = page.waitForResponse(
    (response) =>
      response.url().includes("/v1/learning/policies/materials") &&
      response.request().method() === "GET",
  );
  await page.reload();
  expect((await rejectedRecommendations).status()).toBe(200);
  expect((await rejectedHistory).status()).toBe(200);
  await expect(recommendations.getByText("No learning recommendations to review.")).toBeVisible();
  await expect(policyHistory.getByRole("article", { name: "Version 2" })).toBeVisible();
  await expect(policyHistory.getByRole("article", { name: "Version 3" })).toHaveCount(0);

  const rollbackHistory = page.waitForResponse(
    (response) =>
      response.url().includes("/v1/learning/policies/materials") &&
      response.request().method() === "GET",
  );
  await policyHistory
    .getByRole("button", { name: "Restore tailoring policy version 1" })
    .click();
  expect((await rollbackHistory).status()).toBe(200);
  const rolledBackPolicy = policyHistory.getByRole("article", { name: "Version 3" });
  await expect(rolledBackPolicy).toBeVisible();
  await expect(rolledBackPolicy.getByText("Current")).toBeVisible();
  await expect(rolledBackPolicy.getByText("Restored from version 1")).toBeVisible();
  await expect(rolledBackPolicy.getByText("Reason: user requested")).toBeVisible();
  await expect(
    policyHistory.getByRole("button", { name: "Restore tailoring policy version 3" }),
  ).toHaveCount(0);
});

async function installDeterministicLearningWrites(page: Page, dbPath: string): Promise<void> {
  await page.route("**/v1/learning/recommendations/*/reviews", async (route) => {
    const request = route.request();
    const recommendationId = decodeURIComponent(
      new URL(request.url()).pathname.split("/").at(-2) ?? "",
    );
    const body = request.postDataJSON() as { decision?: string };
    if (recommendationId === STYLE_RECOMMENDATION_ID && body.decision === "accepted") {
      appendAcceptedRecommendation(dbPath);
      await route.fulfill({
        json: {
          ok: true,
          reviewId: ACCEPTED_REVIEW_ID,
          recommendationId,
          revision: 1,
          decision: "accepted",
          context: "materials",
          policyKind: "tailoring_rule",
          policyVersion: 2,
          reviewedAt: ACCEPTED_AT,
        },
      });
      return;
    }
    if (recommendationId === FACTUAL_RECOMMENDATION_ID && body.decision === "rejected") {
      appendRejectedRecommendation(dbPath);
      await route.fulfill({
        json: {
          ok: true,
          reviewId: REJECTED_REVIEW_ID,
          recommendationId,
          revision: 1,
          decision: "rejected",
          context: "materials",
          policyKind: "tailoring_rule",
          policyVersion: null,
          reviewedAt: REJECTED_AT,
        },
      });
      return;
    }
    throw new Error(`Unexpected learning review request for ${recommendationId}.`);
  });

  await page.route("**/v1/learning/policies/materials/rollbacks", async (route) => {
    const body = route.request().postDataJSON() as { targetVersion?: number };
    if (body.targetVersion !== 1) {
      throw new Error(`Unexpected tailoring policy rollback target ${body.targetVersion}.`);
    }
    appendRollback(dbPath);
    await route.fulfill({
      json: {
        ok: true,
        context: "materials",
        policyKind: "tailoring_rule",
        version: 3,
        status: "current",
        learnedRules: [],
        sourceReviewId: null,
        sourceRecommendationId: null,
        rollbackOfVersion: 1,
        rollbackReasonCode: "user_requested",
        createdAt: ROLLED_BACK_AT,
      },
    });
  });
}

function appendAcceptedRecommendation(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.transaction(() => {
      insertPolicy(db, {
        version: 2,
        learnedRules: { style_guidance: "preserve_user_edit_pattern" },
        createdAt: ACCEPTED_AT,
      });
      db.prepare(
        `INSERT INTO learning_recommendation_reviews (
          tenant_id, review_id, recommendation_id, revision, decision,
          context, policy_kind, policy_version, reviewed_at
        ) VALUES ('local', ?, ?, 1, 'accepted', 'materials', 'tailoring_rule', 2, ?)`,
      ).run(ACCEPTED_REVIEW_ID, STYLE_RECOMMENDATION_ID, ACCEPTED_AT);
    })();
  } finally {
    db.close();
  }
}

function appendRejectedRecommendation(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO learning_recommendation_reviews (
        tenant_id, review_id, recommendation_id, revision, decision,
        context, policy_kind, policy_version, reviewed_at
      ) VALUES ('local', ?, ?, 1, 'rejected', 'materials', 'tailoring_rule', NULL, ?)`,
    ).run(REJECTED_REVIEW_ID, FACTUAL_RECOMMENDATION_ID, REJECTED_AT);
  } finally {
    db.close();
  }
}

function appendRollback(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    insertPolicy(db, {
      version: 3,
      learnedRules: {},
      createdAt: ROLLED_BACK_AT,
      rollbackOfVersion: 1,
      rollbackReason: "user_requested",
    });
  } finally {
    db.close();
  }
}

function insertPolicy(
  db: Database.Database,
  input: {
    version: number;
    learnedRules: Record<string, string>;
    createdAt: string;
    rollbackOfVersion?: number;
    rollbackReason?: string;
  },
): void {
  db.prepare(
    `INSERT INTO tailoring_policies (
      tenant_id, version, prompt_version, schema_version, judge_schema_version,
      prompt_fingerprint, config_fingerprint, profile_policy_fingerprint,
      custom_prompt_fingerprint, generator_settings_json, judge_settings_json,
      runtime_settings_json, rollback_of_version, rollback_reason, created_at,
      created_from_event_id
    ) VALUES ('local', ?, 'tailor.v2', 'resume.v1', 'judge.v1',
              'qa-prompt', ?, 'qa-profile', 'qa-custom', '{}', '{}', ?, ?, ?, ?, NULL)`,
  ).run(
    input.version,
    `qa-config-${input.version}`,
    JSON.stringify({ learned_tailoring_rules: input.learnedRules }),
    input.rollbackOfVersion ?? null,
    input.rollbackReason ?? "",
    input.createdAt,
  );
}

function currentPolicyVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT MAX(version) AS version FROM tailoring_policies WHERE tenant_id = 'local'")
      .get() as { version: number | null } | undefined;
    return Number(row?.version);
  } finally {
    db.close();
  }
}
