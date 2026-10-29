import { expect, test as base, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { createRequire } from "node:module";

import { buildApp } from "../../../api/src/server.js";
import { loadE2eDbPath } from "../fixtures/e2e-state.js";

interface OwnedWorkspace {
  appDir: string;
  [key: string]: unknown;
}

const require = createRequire(import.meta.url);
const { workspaceEnvironment } = require("../fixtures/owned-workspace.cjs") as {
  workspaceEnvironment(workspace: OwnedWorkspace): NodeJS.ProcessEnv;
};
const { createPaginationWorkspace, cleanupPaginationWorkspace } = require("../fixtures/learning-pagination-workspace.cjs") as {
  createPaginationWorkspace(environment: NodeJS.ProcessEnv): Promise<{ workspace?: OwnedWorkspace; stopped: boolean; error?: Error }>;
  cleanupPaginationWorkspace(options: {
    workspace: OwnedWorkspace | undefined;
    app: ReturnType<typeof buildApp> | undefined;
    page: Page;
    seedStopped: boolean;
    verifyShared(): void;
  }): Promise<void>;
};

const recommendationId = (index: number) =>
  `learning-recommendation:${index.toString(16).padStart(64, "0")}`;
const acceptedReviewId = `learning-recommendation-review:${"e".repeat(64)}`;
const jobs = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const recordedAt = "2026-10-25T10:00:00.000Z";

type PaginationFixture = { dbPath: string; acceptReview: () => void };

const test = base.extend<{ pagination: PaginationFixture }>({
  pagination: async ({ page }, use) => {
    const sharedDbPath = loadE2eDbPath();
    const sharedBefore = snapshotSharedLearning(sharedDbPath);
    let workspace: OwnedWorkspace | undefined;
    let seedStopped = false;
    let app: ReturnType<typeof buildApp> | undefined;
    try {
      const result = await createPaginationWorkspace(process.env);
      workspace = result.workspace;
      seedStopped = result.stopped;
      if (result.error) throw result.error;
      if (!workspace) throw new Error("Synthetic learning workspace was not allocated.");
      const environment = { ...process.env, ...workspaceEnvironment(workspace) };
      const dbPath = environment.JOBCTRL_E2E_DB_PATH!;
      seedPaginationRecords(dbPath);
      const unavailable = async () => { throw new Error("Outside the learning pagination fixture"); };
      app = buildApp({
        appDir: workspace.appDir,
        dbPath,
        configPath: environment.JOBCTRL_E2E_CONFIG_PATH!,
        runtimeEnvironment: environment,
        credentialStore: { list: unavailable, set: unavailable, delete: unavailable, applyBatch: unavailable },
        providerDispatcher: { call: unavailable, close: async () => {} },
        pythonRuntime: { id: "learning-pagination-deny-subprocess", resolve: () => { throw new Error("Outside the learning pagination fixture"); } },
      });
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      // Forward only learning reads to the real API backed by this private DB.
      await page.route("**/v1/learning/recommendations**", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const url = new URL(route.request().url());
        const response = await fetch(`${origin}${url.pathname}${url.search}`, { signal: AbortSignal.timeout(10_000) });
        await route.fulfill({ status: response.status, contentType: response.headers.get("content-type") ?? "application/json", body: await response.text() });
      });
      await use({
        dbPath,
        acceptReview: () => appendAcceptedReview(dbPath),
      });
    } finally {
      await cleanupPaginationWorkspace({
        workspace,
        app,
        page,
        seedStopped,
        verifyShared: () => expect(snapshotSharedLearning(sharedDbPath)).toEqual(sharedBefore),
      });
    }
  },
});

test("learning pages retain accepted and tombstoned authority through failed reads and retries", async ({ page, pagination }, testInfo) => {
  const { dbPath } = pagination;

  // Preserve the production read routes and database. Only the review write and
  // two transient transport failures are controlled by this isolated fixture.
  await page.route("**/v1/learning/recommendations/*/reviews", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) ?? "");
    expect(id).toBe(recommendationId(0));
    expect(route.request().postDataJSON()).toEqual({ decision: "accepted" });
    pagination.acceptReview();
    await route.fulfill({ json: {
      ok: true, reviewId: acceptedReviewId, recommendationId: id, revision: 1,
      decision: "accepted", context: "materials", policyKind: "tailoring_rule",
      policyVersion: 2, reviewedAt: recordedAt,
    } });
  });
  let listFailures = 2;
  let evidenceFailures = 2;
  await page.route("**/v1/learning/recommendations**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.searchParams.get("page") === "2") {
      if (url.pathname.endsWith("/evidence") && evidenceFailures-- > 0) {
        await route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
        return;
      }
      if (url.pathname === "/v1/learning/recommendations" && listFailures-- > 0) {
        await route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
        return;
      }
    }
    await route.fallback();
  });

  await page.goto("/dashboard");
  const panel = page.locator(".learning-review-panel");
  const listPages = panel.getByRole("navigation", { name: "Learning recommendations pages" });
  await expect(listPages).toContainText("Page 1 of 2 · Showing 50 of 53 review items");
  await panel.getByRole("button", { name: "Accept learning recommendation qa_page_0 → review" }).click();
  await expect(listPages).toContainText("Page 1 of 2 · Showing 50 of 52 review items");
  await expect(panel.getByText("qa_page_0 → review")).toHaveCount(0);
  for (let index = 1; index <= 50; index++) {
    await expect(panel.getByText(`qa_page_${index} → review`, { exact: true })).toHaveCount(1);
  }
  await listPages.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("recommendation-pages.png") });

  const inspected = panel.getByRole("article", { name: "qa_page_1 → review" });
  await inspected.getByRole("button", { name: "Inspect evidence for qa_page_1 → review" }).click();
  const evidencePages = inspected.getByRole("navigation", { name: "Evidence for qa_page_1 → review pages" });
  await expect(evidencePages).toContainText("Page 1 of 2 · Showing 100 of 102 evidence links");
  for (let signal = 0; signal < 100; signal++) {
    await expect(inspected.getByText(`qa-pagination-signal-1-${signal.toString().padStart(3, "0")}`, { exact: true })).toHaveCount(1);
  }
  await evidencePages.getByRole("button", { name: "Next page" }).click();
  await expect(evidencePages.getByText("Could not load page 2")).toBeVisible();
  await expect(evidencePages).toContainText("Page 1 of 2 · Showing 100 of 102 evidence links");
  await expect(inspected.getByText("qa-pagination-signal-1-000")).toBeVisible();
  await evidencePages.getByRole("button", { name: "Retry page 2" }).click();
  await expect(evidencePages).toContainText("Page 2 of 2 · Showing 2 of 102 evidence links");
  await expect(inspected.getByText("qa-pagination-signal-1-100")).toHaveCount(2);
  await expect(inspected.getByText(new RegExp(`revision 1 · job ${jobs[0]}`))).toBeVisible();
  await expect(inspected.getByText(new RegExp(`revision 1 · job ${jobs[1]}`))).toBeVisible();
  await evidencePages.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("evidence-pages.png") });

  await listPages.getByRole("button", { name: "Next page" }).click();
  await expect(listPages.getByText("Could not load page 2")).toBeVisible();
  await expect(listPages).toContainText("Page 1 of 2 · Showing 50 of 52 review items");
  await expect(inspected).toBeVisible();
  await expect(panel.getByText("qa_page_0 → review")).toHaveCount(0);
  await listPages.getByRole("button", { name: "Retry page 2" }).click();
  await expect(listPages).toContainText("Page 2 of 2 · Showing 2 of 52 review items");
  await expect(panel.getByText("style_guidance → preserve_user_edit_pattern")).toBeVisible();
  await expect(panel.getByText("fact_handling → require_source_match")).toBeVisible();
  await listPages.getByRole("button", { name: "Previous page" }).click();
  const tombstoned = panel.getByRole("article", { name: "qa_page_50 → review" });
  await expect(tombstoned.getByText(/source evidence was tombstoned/)).toBeVisible();
  await expect(tombstoned.getByRole("button", { name: "Accept learning recommendation qa_page_50 → review" })).toBeDisabled();
  await expect(panel.getByText("qa_page_0 → review")).toHaveCount(0);

  const db = new Database(dbPath, { readonly: true });
  try {
    expect(db.prepare("SELECT decision, policy_version AS policyVersion FROM learning_recommendation_reviews WHERE review_id = ?").get(acceptedReviewId))
      .toEqual({ decision: "accepted", policyVersion: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM learning_recommendation_tombstones WHERE recommendation_id = ?").get(recommendationId(50)))
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM learning_recommendations").get()).toEqual({ count: 53 });
  } finally {
    db.close();
  }
});

test("pagination fixture leaves the shared event stream available", async ({ page }) => {
  await page.goto("/dashboard");
  const streamResult = await page.evaluate(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch("/v1/events/stream?since=0", { signal: controller.signal });
      if (!response.ok || !response.body) return `HTTP ${response.status}`;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) return "stream ended";
        text += decoder.decode(value, { stream: true });
        if (text.includes("event: error")) return text;
        if (text.includes("event: QaInfo")) return "replayed seeded event";
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  });
  expect(streamResult).toBe("replayed seeded event");
  await expect(page.getByText("The workspace database changed.", { exact: false })).toHaveCount(0);
  const response = await page.request.get("/v1/learning/recommendations");
  expect(response.status()).toBe(200);
});

function seedPaginationRecords(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.transaction(() => {
      assertPaginationFixtureIsAbsent(db);
      const evidence = db.prepare(`INSERT INTO learning_recommendation_evidence
        (tenant_id, recommendation_id, signal_id, evidence_role, source_kind, source_id, source_revision, recorded_at)
        VALUES ('local', ?, ?, 'supporting', 'tailoring_feedback_signal', ?, 1, ?)`);
      const evidenceJob = db.prepare(`INSERT INTO learning_recommendation_evidence_jobs
        (tenant_id, recommendation_id, signal_id, job_id) VALUES ('local', ?, ?, ?)`);
      const recommendationJob = db.prepare(`INSERT INTO learning_recommendation_jobs
        (tenant_id, recommendation_id, job_id) VALUES ('local', ?, ?)`);
      const recommendation = db.prepare(`INSERT INTO learning_recommendations
        (tenant_id, recommendation_id, derivation_version, evaluation_fixture_version,
         context, policy_kind, signal_kind, rule_key, rule_value, allowlist_version,
         status, observed_signal_count, observed_job_count, minimum_signal_count,
         minimum_job_count, confidence_limit, input_fingerprint, derived_at)
        VALUES ('local', ?, 1, 1, 'materials', 'tailoring_rule', 'style_preference', ?,
          'review', 1, 'pending', ?, 2, 3, 2, 'sample_gated_no_population_inference', ?, ?)`);
      for (let index = 0; index < 51; index++) {
        const id = recommendationId(index);
        const count = index === 1 ? 101 : 3;
        for (let signal = 0; signal < count; signal++) {
          const signalId = `qa-pagination-signal-${index}-${signal.toString().padStart(3, "0")}`;
          evidence.run(id, signalId, signalId, recordedAt);
          evidenceJob.run(id, signalId, jobs[signal % 2]);
          if (index === 1 && signal === 100) evidenceJob.run(id, signalId, jobs[1]);
        }
        for (const job of jobs) recommendationJob.run(id, job);
        recommendation.run(id, `qa_page_${index}`, count, (index + 200).toString(16).padStart(64, "0"), recordedAt);
      }
      db.prepare(`INSERT INTO learning_recommendation_tombstones
        (tenant_id, tombstone_id, recommendation_id, affected_signal_id, affected_source_revision,
         reason_code, derivation_version, tombstoned_at, rederived_at, replacement_recommendation_id)
        VALUES ('local', 'qa-pagination-tombstone', ?, 'qa-pagination-signal-50-000', 1,
          'source_deleted', 1, ?, ?, NULL)`).run(recommendationId(50), recordedAt, recordedAt);
    })();
  } finally {
    db.close();
  }
}

const recommendationTables = [
  "learning_recommendation_evidence_jobs",
  "learning_recommendation_jobs",
  "learning_recommendation_evidence",
  "learning_recommendation_tombstones",
  "learning_recommendation_reviews",
  "learning_recommendations",
] as const;

function snapshotSharedLearning(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return JSON.stringify({
      schemaVersion: db.pragma("schema_version", { simple: true }),
      rows: [...recommendationTables, "tailoring_policies"].map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
    });
  } finally {
    db.close();
  }
}

function assertPaginationFixtureIsAbsent(db: Database.Database): void {
  const ids = Array.from({ length: 51 }, (_, index) => recommendationId(index));
  const placeholders = ids.map(() => "?").join(", ");
  for (const table of recommendationTables) {
    const result = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id = 'local' AND recommendation_id IN (${placeholders})`).get(...ids) as { count: number };
    if (result.count !== 0) throw new Error(`Pagination fixture overlaps existing ${table} rows.`);
  }
  const conflicts = db.prepare(`SELECT
    (SELECT COUNT(*) FROM tailoring_policies WHERE tenant_id = 'local' AND version = 2) +
    (SELECT COUNT(*) FROM learning_recommendation_reviews WHERE tenant_id = 'local' AND review_id = ?) +
    (SELECT COUNT(*) FROM learning_recommendation_tombstones WHERE tenant_id = 'local' AND tombstone_id = 'qa-pagination-tombstone') AS count`)
    .get(acceptedReviewId) as { count: number };
  if (conflicts.count !== 0) throw new Error("Pagination fixture overlaps existing policy or review data.");
}

function appendAcceptedReview(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.transaction(() => {
      db.prepare(`INSERT INTO tailoring_policies
        (tenant_id, version, prompt_version, schema_version, judge_schema_version,
         prompt_fingerprint, config_fingerprint, profile_policy_fingerprint, custom_prompt_fingerprint,
         generator_settings_json, judge_settings_json, runtime_settings_json, rollback_of_version,
         rollback_reason, created_at, created_from_event_id)
        VALUES ('local', 2, 'tailor.v2', 'resume.v1', 'judge.v1', 'qa-prompt', 'qa-pagination-config',
          'qa-profile', 'qa-custom', '{}', '{}', '{}', NULL, '', ?, NULL)`).run(recordedAt);
      db.prepare(`INSERT INTO learning_recommendation_reviews
        (tenant_id, review_id, recommendation_id, revision, decision, context, policy_kind, policy_version, reviewed_at)
        VALUES ('local', ?, ?, 1, 'accepted', 'materials', 'tailoring_rule', 2, ?)`)
        .run(acceptedReviewId, recommendationId(0), recordedAt);
    })();
  } finally {
    db.close();
  }
}
