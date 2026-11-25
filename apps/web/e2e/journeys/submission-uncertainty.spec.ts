import { createHash } from "node:crypto";
import {
  test,
  expect,
  json,
  action,
  completed,
  terminal,
} from "../harness/fixtures.js";
import {
  acceptBaseline,
  createBaseline,
  createPosting,
  qualifyPosting,
} from "./core-data.js";

type Payload = {
  payloadId: string;
  payloadSha256: string;
  sources: { resume: { pdf: { sha256: string } } };
};
type Application = {
  version: number;
  status: string;
  payload: Payload;
  intent: { intentId: string; runId: string; payloadId: string } | null;
  receipt: unknown;
  runs: { runId: string; status: string }[];
};

test("Apply restores the exact failed rehearsal after a browser reload", async ({ api, app, page }) => {
  const { profile } = await createBaseline(api);
  const posting = await createPosting(api, "rehearsal-reload");
  const peer = await json<{ job_id: string }>(api, "post", "/v1/jobs/capture", {
    url: "https://example.com/jobs/rehearsal-reload-peer",
    title: "Synthetic Unrelated Engineer",
    company: "Synthetic Peer Company",
    description: "Maintain an independent application queue.",
  });
  await acceptBaseline(api, posting.job_id, profile.profileVersion);
  await json(api, "post", `/v1/jobs/${posting.job_id}/application/preparation`, {
    expectedVersion: 0,
    idempotencyKey: "prepare-email-for-rehearsal-reload",
    mode: "email",
    recipient: "hiring@example.com",
    subject: "Synthetic rehearsal subject",
    body: "Synthetic rehearsal email.",
  });
  const route = (id: string) => `/apply-review?jobKey=${encodeURIComponent(id)}&tab=application`;
  await page.goto(route(posting.job_id));
  const controls = page.getByRole("region", { name: "Application execution controls", exact: true });
  const rehearse = page.getByRole("button", { name: "Run application rehearsal", exact: true });
  await expect(rehearse).toBeEnabled();

  // The preserved payload binds the old Profile revision. A rehearsal of it
  // must fail without submission after a legitimate change to that source.
  await json(api, "patch", "/v1/profile", {
    expectedProfileVersion: profile.profileVersion,
    profile: { ...profile.profile, personal: { ...profile.profile.personal, city: "Synthetic Updated City" } },
  });
  const receipt = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/v1/actions/applications.rehearse" && response.request().method() === "POST");
  await rehearse.click();
  const admitted = await receipt;
  expect(admitted.status()).toBe(202);
  const { runId } = await admitted.json() as { runId: string };
  expect(await terminal(api, runId)).toMatchObject({ status: "failed", errorCode: "application_resume_sources_changed" });
  await expect(controls).toContainText(runId);
  await expect(controls).toContainText("Action failed: application_resume_sources_changed");
  await page.reload();
  await expect(controls).toContainText(runId);
  await expect(controls).toContainText("Action failed: application_resume_sources_changed");
  expect(app.external.sends).toHaveLength(0);

  await page.goto(route(peer.job_id));
  await expect(controls).toBeVisible();
  await expect(controls).not.toContainText(runId);
});

test("uncertain submission keeps one durable intent and never sends twice after a real worker restart", async ({
  api,
  app,
  page,
}, testInfo) => {
  const { library } = await createBaseline(api);
  const posting = await createPosting(api, "uncertain-email");
  await qualifyPosting(api, app, posting, library);
  const resume = await acceptBaseline(
    api,
    posting.job_id,
    library.profileVersion,
  );
  const pdf = await (
    await api.get(
      `/v1/resumes/${resume.resume_id}/export?format=pdf&accepted=true`,
    )
  ).body();
  const prepared = await json<{ application: Application }>(
    api,
    "post",
    `/v1/jobs/${posting.job_id}/application/preparation`,
    {
      expectedVersion: 0,
      idempotencyKey: "prepare-reviewed-email",
      mode: "email",
      recipient: "hiring@example.com",
      subject: "Synthetic application review",
      body: "Please review my synthetic application.",
    },
  );
  let payload = prepared.application.payload;
  expect(payload.sources.resume.pdf.sha256).toBe(
    createHash("sha256").update(pdf).digest("hex"),
  );
  const rehearsed = await action(api, "applications.rehearse", {
    jobId: posting.job_id,
    payloadId: payload.payloadId,
  });
  const rehearsal = await completed(api, rehearsed.runId);
  expect(
    (rehearsal["result"] as { rehearsal: { coverage: string } }).rehearsal
      .coverage,
  ).toBe("full");
  expect(app.external.sends).toHaveLength(0);

  // Inspect the already-recorded synthetic rehearsal before any email action.
  // This is a read-only route and opens its retained result for both layouts.
  await page.goto(`/jobs/${encodeURIComponent(posting.job_id)}/run/${encodeURIComponent(rehearsed.runId)}`);
  const timeline = page.getByRole("region", { name: "Application action history", exact: true });
  await expect(timeline.getByRole("list", { name: "Application run timeline", exact: true })).toBeVisible();
  await expect(timeline).toContainText(rehearsed.runId);
  await timeline.getByText("Recorded application result", { exact: true }).click();
  await expect(timeline.locator("details > pre")).toBeVisible();
  const originalViewport = page.viewportSize();
  expect(originalViewport).not.toBeNull();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(timeline.locator("details > pre")).toBeVisible();
    await testInfo.attach(`application-rehearsal-timeline-expanded-${width}`, {
      contentType: "image/png",
      body: await page.screenshot({ fullPage: true, animations: "disabled" }),
    });
  }
  await page.setViewportSize(originalViewport!);
  expect(app.external.sends).toHaveLength(0);

  const afterRehearsal = (
    await json<{ application: Application }>(
      api,
      "get",
      `/v1/jobs/${posting.job_id}/application`,
    )
  ).application;
  let approved = await json<{
    decision: { decisionId: string };
    application: Application;
  }>(api, "post", `/v1/jobs/${posting.job_id}/apply-review`, {
    expectedVersion: afterRehearsal.version,
    idempotencyKey: "approve-reviewed-email",
    decision: "approve_submit",
    payloadId: payload.payloadId,
    payloadSha256: payload.payloadSha256,
    rehearsalId: rehearsed.runId,
  });
  const oldCommand = {
    jobId: posting.job_id,
    payloadId: payload.payloadId,
    approvalId: approved.decision.decisionId,
  };
  const changed = await json<{ application: Application }>(
    api,
    "post",
    `/v1/jobs/${posting.job_id}/application/preparation`,
    {
      expectedVersion: approved.application.version,
      idempotencyKey: "prepare-changed-reviewed-email",
      mode: "email",
      recipient: "hiring@example.com",
      subject: "Synthetic application review",
      body: "Please review the revised synthetic application.",
    },
  );
  const stale = await action(api, "applications.execute", oldCommand);
  expect((await terminal(api, stale.runId))["status"]).toBe("failed");
  expect(app.external.sends).toHaveLength(0);
  expect(
    (
      await json<{ application: Application }>(
        api,
        "get",
        `/v1/jobs/${posting.job_id}/application`,
      )
    ).application.intent,
  ).toBeNull();
  payload = changed.application.payload;
  const renewedRehearsal = await action(api, "applications.rehearse", {
    jobId: posting.job_id,
    payloadId: payload.payloadId,
  });
  await completed(api, renewedRehearsal.runId);
  const current = (
    await json<{ application: Application }>(
      api,
      "get",
      `/v1/jobs/${posting.job_id}/application`,
    )
  ).application;
  approved = await json<{
    decision: { decisionId: string };
    application: Application;
  }>(api, "post", `/v1/jobs/${posting.job_id}/apply-review`, {
    expectedVersion: current.version,
    idempotencyKey: "approve-revised-email",
    decision: "approve_submit",
    payloadId: payload.payloadId,
    payloadSha256: payload.payloadSha256,
    rehearsalId: renewedRehearsal.runId,
  });
  const command = {
    jobId: posting.job_id,
    payloadId: payload.payloadId,
    approvalId: approved.decision.decisionId,
  };
  const executing = await action(api, "applications.execute", command);
  const mail = await app.external.next();
  expect(mail.method).toBe("POST");
  expect(mail.path).toBe("/gmail/v1/messages/send");
  const mime = Buffer.from(mail.body["raw"] as string, "base64url").toString(
    "utf8",
  );
  expect(mime).toContain("To: hiring@example.com");
  expect(mime).toContain("Synthetic application review");
  expect(mime).toContain("Content-Type: application/pdf");
  const sending = (
    await json<{ application: Application }>(
      api,
      "get",
      `/v1/jobs/${posting.job_id}/application`,
    )
  ).application;
  expect(sending.intent?.runId).toBe(executing.runId);
  expect(sending.intent?.payloadId).toBe(payload.payloadId);
  expect(sending.receipt).toBeNull();
  expect(app.external.sends).toHaveLength(1);

  // The synthetic external service has received the actual MIME send. Kill the
  // worker before any acknowledgement exists; the replacement must not resend.
  const replacement = await app.restartWorker();
  expect(replacement.current).not.toBe(replacement.previous);
  await expect.poll(() => mail.closed).toBe(true);
  const original = await completed(api, executing.runId);
  expect((original["result"] as { status: string }).status).toBe(
    "needs_verification",
  );
  const uncertain = (
    await json<{ application: Application }>(
      api,
      "get",
      `/v1/jobs/${posting.job_id}/application`,
    )
  ).application;
  expect(uncertain.status).toBe("needs_verification");
  expect(uncertain.intent).toEqual(sending.intent);
  expect(uncertain.receipt).toBeNull();

  const retry = await action(api, "applications.execute", command);
  const retried = await completed(api, retry.runId);
  expect((retried["result"] as { status: string }).status).toBe(
    "needs_verification",
  );
  const reset = await api.post(
    `/v1/jobs/${posting.job_id}/application/control`,
    {
      data: {
        expectedVersion: uncertain.version,
        idempotencyKey: "refuse-unsafe-reset",
        action: "reset",
      },
    },
  );
  expect(reset.status()).toBe(409);
  const final = (
    await json<{ application: Application }>(
      api,
      "get",
      `/v1/jobs/${posting.job_id}/application`,
    )
  ).application;
  expect(final.intent).toEqual(sending.intent);
  expect(final.runs).toHaveLength(1);
  expect(final.runs[0]!.runId).toBe(executing.runId);
  expect(app.external.sends).toHaveLength(1);
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
  ).toBe(createHash("sha256").update(pdf).digest("hex"));
  await page.goto(`/jobs/${posting.job_id}?jobTab=application`);
  await expect(
    page.getByText(/needs.verification|Needs verification/i).first(),
  ).toBeVisible();
});
