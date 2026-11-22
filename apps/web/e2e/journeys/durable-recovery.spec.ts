import { createHash } from "node:crypto";
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
import { acceptBaseline, createBaseline, createPosting } from "./core-data.js";
import { catalogMatching, typedExtraction } from "./requirements-data.js";

type Source = { source_id: string; text: string };
type Requirements = {
  revision: number;
  requirements: { requirement_id: string }[];
};
const sources = (call: ExternalCall) => call.body["sources"] as Source[];
const citations = (values: Source[]) =>
  values.map((source) => ({ source_id: source.source_id, quote: source.text }));
function extracted(call: ExternalCall) {
  const source = sources(call)[0]!;
  return typedExtraction(call, { requirements: [{ localId: "recovery", text: source.text, definition: "Implement durable workflow recovery" }] });
}

test("cancellation survives an actual worker kill and its replacement resumes durable work without losing accepted artifacts", async ({
  api,
  app,
}) => {
  const { library } = await createBaseline(api);
  const posting = await createPosting(api, "recovery");
  const first = api.post(`/v1/jobs/${posting.job_id}/requirements`, {
    data: { expected_posting_revision: posting.revision, expected_revision: 0 },
  });
  const extraction = await modelCall(app, "requirements.extract");
  extraction.reply(extracted(extraction));
  const matching = await modelCall(app, "requirements.match_catalog");
  matching.reply(catalogMatching(matching, { recovery: { verdict: "new" } }));
  const initialResponse = await first;
  expect(initialResponse.status(), await initialResponse.text()).toBe(200);
  const accepted: Requirements = await initialResponse.json();
  const resume = await acceptBaseline(
    api,
    posting.job_id,
    library.profileVersion,
  );
  const exported = async () =>
    (
      await api.get(
        `/v1/resumes/${resume.resume_id}/export?format=pdf&accepted=true`,
      )
    ).body();
  const before = createHash("sha256")
    .update(await exported())
    .digest("hex");

  const cancelledRun = await action(api, "requirements.refresh", {
    job_id: posting.job_id,
    expected_posting_revision: posting.revision,
    expected_revision: accepted.revision,
    force: true,
  });
  const held = await modelCall(app, "requirements.extract");
  await json(api, "post", `/v1/action-runs/${cancelledRun.runId}/cancel`, {});
  const replacement = await app.restartWorker();
  expect(replacement.current).not.toBe(replacement.previous);
  await expect
    .poll(() => held.closed, {
      message: "killed worker must release its external request",
    })
    .toBe(true);
  await expect
    .poll(
      async () =>
        (
          await json<{ status: string }>(
            api,
            "get",
            `/v1/action-runs/${cancelledRun.runId}`,
          )
        ).status,
      {
        timeout: 45_000,
        message:
          "recorded cancellation must terminalize on the replacement worker",
      },
    )
    .toBe("cancelled");
  const retained = await json<Requirements>(
    api,
    "get",
    `/v1/jobs/${posting.job_id}/requirements`,
  );
  expect(retained.requirements).toEqual(accepted.requirements);
  expect(retained.revision).toBe(accepted.revision);
  expect(
    createHash("sha256")
      .update(await exported())
      .digest("hex"),
  ).toBe(before);

  // The killed external call has unknown cost. A finite budget must reject
  // further dispatch; cancellation must not invent a free provider receipt.
  const callsBeforeRefusal = app.external.calls.length;
  const denied = await action(api, "requirements.refresh", {
    job_id: posting.job_id,
    expected_posting_revision: posting.revision,
    expected_revision: accepted.revision,
    force: true,
  });
  const deniedResult = await terminal(api, denied.runId);
  expect(deniedResult["status"]).toBe("failed");
  expect(deniedResult["errorCode"]).toBe("spend_accounting_unresolved");
  expect(app.external.calls).toHaveLength(callsBeforeRefusal);
  const health = await json<{ llmSpend: { accountingComplete: boolean; costStatus: string; unresolvedCalls: number; costUsd: number | null } }>(
    api,
    "get",
    "/v1/health",
  );
  expect(health.llmSpend.accountingComplete).toBe(false);
  expect(health.llmSpend).toMatchObject({ costStatus: "unresolved", unresolvedCalls: 1, costUsd: null, accountingBlocked: true });

  // Explicitly select the public unlimited-money policy to exercise fresh
  // work on the replacement. Unknown prior accounting remains visible; lane
  // and token custody remain active. This is not the fixture's default policy.
  const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", {
    expectedRevision: settings.revision,
    dailyBudgetUsd: 0,
  });
  const resumed = await action(api, "requirements.refresh", {
    job_id: posting.job_id,
    expected_posting_revision: posting.revision,
    expected_revision: accepted.revision,
    force: true,
  });
  expect(resumed.runId).not.toBe(cancelledRun.runId);
  expect(resumed.runId).not.toBe(denied.runId);
  const refreshed = await modelCall(app, "requirements.extract");
  refreshed.reply(extracted(refreshed));
  const comparison = await modelCall(app, "requirements.match_catalog");
  comparison.reply(
    catalogMatching(comparison, {
      recovery: {
        verdict: "equivalent",
        requirementId: accepted.requirements[0]!.requirement_id,
      },
    }),
  );
  const completedRun = await completed(api, resumed.runId);
  expect(completedRun["runId"]).toBe(resumed.runId);
  const final = await json<Requirements>(
    api,
    "get",
    `/v1/jobs/${posting.job_id}/requirements`,
  );
  expect(final.requirements[0]!.requirement_id).toBe(
    accepted.requirements[0]!.requirement_id,
  );
  expect(
    (
      await json<{ llmSpend: { accountingComplete: boolean } }>(
        api,
        "get",
        "/v1/health",
      )
    ).llmSpend.accountingComplete,
  ).toBe(false);
  expect(
    createHash("sha256")
      .update(await exported())
      .digest("hex"),
  ).toBe(before);
});
