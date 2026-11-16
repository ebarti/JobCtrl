import { test, expect, json, action, terminal } from "../harness/fixtures.js";

test.use({ features: "jobs" });

test("posting fetch refusals retain safe typed evidence and accepted sources without model calls or implicit retries", async ({ api, app }, testInfo) => {
  const posting = await json<{ job_id: string; revision: number }>(api, "post", "/v1/jobs/capture", {
    url: "https://example.com/jobs/source-fetch-evidence",
    title: "Synthetic Source Recovery Engineer",
    company: "Synthetic Source Company",
    description: "Retain the accepted operational source while a later fetch needs review.",
  });
  type History = { snapshots: unknown[]; observations: unknown[]; attempts: { failure_code: string; data: Record<string, unknown> }[] };
  const accepted = await json<History>(api, "get", `/v1/jobs/${posting.job_id}/snapshots`);
  const remoteBody = "Private remote diagnostic text must not be copied into acquisition evidence.";
  const cases = [
    { status: 429, code: "posting_fetch_blocked", kind: "blocked", reason_code: "rate_limited" },
    { status: 503, code: "posting_fetch_unavailable", kind: "unavailable", reason_code: "unknown" },
    { status: null, code: "posting_fetch_failed", kind: "unknown", reason_code: "unknown" },
  ] as const;
  const evidence: Record<string, unknown>[] = [];
  for (const [index, expected] of cases.entries()) {
    const started = await action(api, "jobs.refresh", { job_id: posting.job_id, expectedRevision: posting.revision });
    const fetch = await app.external.next();
    expect(fetch.path).toBe("/posting-page");
    expect(fetch.body).toEqual({ url: "https://example.com/jobs/source-fetch-evidence" });
    if (expected.status === null) fetch.disconnect();
    else fetch.respond({ error: remoteBody }, expected.status);
    expect(await terminal(api, started.runId)).toMatchObject({ status: "failed", errorCode: expected.code });
    const retained = await json<History>(api, "get", `/v1/jobs/${posting.job_id}/snapshots`);
    expect(retained.snapshots).toEqual(accepted.snapshots);
    expect(retained.observations).toEqual(accepted.observations);
    expect(retained.attempts).toHaveLength(index + 1);
    const attempt = retained.attempts[0]!;
    expect(attempt.failure_code).toBe(expected.code);
    expect(attempt.data).toEqual({ captureEvidence: null, captureFailure: {
      stage: "posting_fetch", kind: expected.kind, reason_code: expected.reason_code,
    } });
    expect(JSON.stringify(attempt.data)).not.toContain(remoteBody);
    expect(app.external.calls.filter((call) => call.path === "/posting-page")).toHaveLength(index + 1);
    expect(app.external.calls.filter((call) => call.path === "/model")).toHaveLength(0);
    evidence.push({ runId: started.runId, code: attempt.failure_code, data: attempt.data });
  }
  const beforeReads = app.external.calls.length;
  await json(api, "get", `/v1/jobs/${posting.job_id}`);
  await json(api, "get", `/v1/jobs/${posting.job_id}/snapshots`);
  expect(app.external.calls).toHaveLength(beforeReads);
  await testInfo.attach("posting-fetch-failure-evidence", { contentType: "application/json",
    body: Buffer.from(JSON.stringify({ jobId: posting.job_id, modelCalls: 0, attempts: evidence }, null, 2)) });
});
