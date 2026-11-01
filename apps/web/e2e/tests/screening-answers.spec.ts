import { expect, test } from "@playwright/test";
import { QA_PLATFORM_JOB_ID } from "../fixtures/e2e-state.js";

// Browser contract double proves rendered workflow only. Actual worker execution,
// SQLite source fences and registered RPC/CLI are covered by worker integration tests.
test("screening drafts, explicit review and manual-use history in Apply Review", async ({ page }) => {
  const jobId = QA_PLATFORM_JOB_ID;
  const binding = { profileVersion: 1, profileHash: "a".repeat(64), postingHash: "b".repeat(64), destination: "https://example.test/apply", posting: "Synthetic posting", materials: [], facts: [], sensitiveFactIds: [], question: "Synthetic question", context: "Synthetic context", applicationId: "attempt" };
  type State = { questionId: string; jobId: string; applicationId: string; revision: number; question: string; context: string; captureBinding: typeof binding; draft: null | { answerId: string; text: string; uncertainty: string; binding: typeof binding; question: string; context: string; determinationIds: string[]; libraryId: null; reviewId?: string }; accepted: State["draft"]; action: string; snapshotId: string; recordedAt: string; manualUse?: { useId: string; answerId: string; reviewId: string; text: string; attested: true; changed: boolean } };
  let state: State | null = null;
  const history: State[] = [];
  await page.route(`**/v1/jobs/${jobId}/screening-answers`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { ok: true, jobId, questions: state ? [state] : [], history, library: [], facts: [], sourceBinding: binding, sourceFailure: null, determinations: [], failures: [] } });
      return;
    }
    const command = route.request().postDataJSON();
    if (command.action === "capture") state = { questionId: "question", jobId, applicationId: command.applicationId, revision: 1, question: command.question, context: command.context, captureBinding: binding, draft: null, accepted: null, action: "capture", snapshotId: "captured", recordedAt: "2026-10-08" };
    else if (state) {
      state = { ...state, revision: state.revision + 1, action: command.action, snapshotId: command.action };
      if (command.action === "draft") state.draft = { answerId: "answer", text: "Synthetic browser draft", uncertainty: "", binding, question: state.question, context: state.context, determinationIds: ["a".repeat(64), "b".repeat(64), "c".repeat(64)], libraryId: null };
      if (command.action === "review" && state.draft) state.accepted = { ...state.draft, reviewId: "review" };
      if (command.action === "use" && state.accepted) state.manualUse = { useId: "use", answerId: "answer", reviewId: "review", text: command.text, attested: true, changed: command.text !== state.accepted.text };
    }
    if (!state) throw new Error("Synthetic state missing");
    history.push(structuredClone(state));
    await route.fulfill({ json: { ok: true, jobId, state } });
  });
  await page.goto(`/apply-review?jobKey=${jobId}`);
  const panel = page.getByRole("region", { name: "Screening answers" }).first();
  await panel.getByRole("button", { name: "Open screening answers" }).click();
  await expect(panel.getByRole("button", { name: "Capture question" })).toBeEnabled();
  await panel.getByLabel("Application attempt identifier").fill("attempt");
  await panel.getByLabel("Exact screening question").fill("Synthetic question");
  await panel.getByLabel("Question context and constraints").fill("Synthetic context");
  await panel.getByRole("button", { name: "Capture question" }).click();
  await panel.getByRole("button", { name: "Generate answer draft" }).click();
  await expect(panel.getByRole("heading", { name: "Draft awaiting review" })).toBeVisible();
  await panel.getByRole("button", { name: "Approve reviewed answer" }).click();
  await expect(panel.getByRole("button", { name: "Record manual use" })).toBeDisabled();
  await panel.getByLabel("Actual manually used text").fill("Changed manually used text");
  await panel.getByLabel("I manually used the exact text above for this application attempt").check();
  await panel.getByRole("button", { name: "Record manual use" }).click();
  await panel.getByText("Application-bound history", { exact: true }).click();
  await expect(panel.locator("details").filter({ has: page.getByText("Application-bound history", { exact: true }) }).locator("pre").filter({ hasText: /^Changed manually used text$/ })).toBeVisible();
  await page.reload();
  await panel.getByRole("button", { name: "Open screening answers" }).click();
  await panel.getByText("Application-bound history", { exact: true }).click();
  await expect(panel.locator("details").filter({ has: page.getByText("Application-bound history", { exact: true }) }).locator("pre").filter({ hasText: /^Changed manually used text$/ })).toBeVisible();
});
