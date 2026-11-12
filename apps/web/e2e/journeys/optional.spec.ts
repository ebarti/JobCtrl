import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  test,
  expect,
  json,
  modelCall,
  action,
  completed,
} from "../harness/fixtures.js";
import { createBaseline, createPosting } from "./core-data.js";
import {
  sources,
  type Contact,
  type DeterminationAudit,
  type Learning,
  type Offer,
  type SendLog,
  type Thread,
} from "./optional-data.js";

test("reviewed outreach records a manual send once and preserves its receipt after sources change", async ({
  app,
  api,
  page,
}) => {
  await createBaseline(api);
  await page.goto("/outreach");
  await expect(
    page.getByRole("heading", { name: "Contacts", exact: true }),
  ).toBeVisible();

  const { contact } = await json<{ contact: Contact }>(
    api,
    "post",
    "/v1/contacts",
    {
      employer: "Synthetic Co",
      role: "recruiter",
      attributes: [{ kind: "name", value: "Synthetic Recruiter" }],
    },
  );
  const contactSource = `contact:${contact.attributes[0]!.attributeId}`;
  expect(contact.attributes[0]!.provenance.userConfirmed).toBe(true);
  const eventsBeforeHead = await json<{
    events: { type: string; eventId: string }[];
  }>(api, "get", "/v1/events");
  for (const url of [
    "/v1/contacts",
    `/v1/contacts/${contact.contactId}`,
    "/v1/contacts/research",
  ]) {
    expect((await api.head(url)).status()).toBe(200);
  }
  expect(
    (
      await json<{ contact: Contact }>(
        api,
        "get",
        `/v1/contacts/${contact.contactId}`,
      )
    ).contact,
  ).toEqual(contact);
  expect(
    (await json<{ items: unknown[] }>(api, "get", "/v1/contacts/research"))
      .items,
  ).toEqual([]);
  const eventsAfterHead = await json<{
    events: { type: string; eventId: string }[];
  }>(api, "get", "/v1/events");
  const contactEvents = (value: {
    events: { type: string; eventId: string }[];
  }) => value.events.filter((event) => event.type.startsWith("Contact"));
  expect(contactEvents(eventsAfterHead)).toEqual(
    contactEvents(eventsBeforeHead),
  );
  // A second client committed this change; the open UI must receive it.
  await expect(page.getByText("Synthetic Recruiter")).toBeVisible();
  await page.goto(`/outreach/${contact.contactId}`);
  await expect(
    page.getByRole("heading", { name: "Synthetic Recruiter" }),
  ).toBeVisible();
  const generate = page.getByRole("button", { name: "Generate draft" });
  await expect(generate).toBeEnabled();
  await generate.click();
  const compose = await modelCall(app, "outreach.compose");
  expect(sources(compose.body)).toContainEqual(
    expect.objectContaining({
      source_id: contactSource,
      text: "Synthetic Recruiter",
    }),
  );
  compose.reply({
    lines: [
      {
        line_id: "greeting",
        text: "Hello, Synthetic Recruiter.",
        evidence_ids: [contactSource],
        transform_type: "grounded_synthesis",
        reason: "Address the confirmed contact.",
      },
    ],
  });
  const claims = await modelCall(app, "outreach.claims");
  expect(sources(claims.body)).toContainEqual(
    expect.objectContaining({
      source_id: "draft:greeting",
      text: "Hello, Synthetic Recruiter.",
    }),
  );
  claims.reply({
    verdict: "pass",
    rationale: "The name comes from the confirmed contact.",
    lines: [
      {
        line_id: "greeting",
        claims: [
          {
            quote: "Hello",
            kind: "non_factual",
            support: "not_applicable",
            evidence: [],
            rationale: "Greeting.",
          },
          {
            quote: "Synthetic Recruiter",
            kind: "recipient_fact",
            support: "supported",
            evidence: [
              { source_id: contactSource, quote: "Synthetic Recruiter" },
            ],
            rationale: "Confirmed contact name.",
          },
        ],
      },
    ],
  });
  const quality = await modelCall(app, "outreach.quality");
  quality.reply({
    verdict: "pass",
    score: 1.0,
    rationale: "The greeting is clear and restrained.",
    findings: [],
  });
  await expect(
    page.getByRole("button", { name: "Approve draft" }),
  ).toBeEnabled();
  let thread = (
    await json<{ thread: Thread }>(
      api,
      "get",
      `/v1/contacts/${contact.contactId}/outreach`,
    )
  ).thread;
  const draft = thread.drafts[0]!;
  expect(draft.status).toBe("candidate");
  expect(draft.gateResults.passed).toBe(true);
  expect(draft.reviewAuthorityVerified).toBe(true);

  const audit = await json<DeterminationAudit>(
    api,
    "get",
    `/v1/outreach/threads/${thread.threadId}/drafts/${draft.draftId}/determinations`,
  );
  expect(audit.complete).toBe(true);
  expect(audit.authorityVerified).toBe(true);
  expect(audit.records.map((record) => record.determinationId)).toEqual(
    draft.gateResults.determinationIds,
  );
  expect(audit.records.map((record) => record.operation)).toEqual([
    "outreach.compose",
    "outreach.claims",
    "outreach.quality",
  ]);
  for (const [record, request] of audit.records.map(
    (record, index) => [record, [compose, claims, quality][index]!] as const,
  )) {
    expect(record).toMatchObject({
      available: true,
      verified: true,
      provenance: { receipt_id: record.determinationId, lane: "contact" },
    });
    expect(record.instructions).toBe(request.body["instructions"]);
    expect(record.sources).toEqual(request.body["sources"]);
    expect(record.responseSchema).toEqual(request.body["response_schema"]);
    expect(record.context).toEqual(request.body["context"]);
  }

  const staleApproval = await api.post(
    `/v1/outreach/threads/${thread.threadId}/drafts/${draft.draftId}/approve`,
    { data: { expectedFingerprint: "stale" } },
  );
  expect(staleApproval.status()).toBe(409);
  await page.getByRole("button", { name: "Approve draft" }).click();
  await expect(
    page.getByRole("heading", { name: "Approved message" }),
  ).toBeVisible();
  thread = (
    await json<{ thread: Thread }>(
      api,
      "get",
      `/v1/outreach/threads/${thread.threadId}`,
    )
  ).thread;
  expect(thread.approvedDraftId).toBe(draft.draftId);
  const approvedArea = page
    .getByRole("heading", { name: "Approved message" })
    .locator("..");
  await approvedArea
    .getByText("Provenance and gate results", { exact: true })
    .click();
  await approvedArea
    .getByText("Inspect prompts, model results and sources", { exact: true })
    .click();
  await expect(
    approvedArea.getByText(
      "Recorded model receipts and source bindings verified.",
    ),
  ).toBeVisible();
  const composeAudit = audit.records.find(
    (record) => record.operation === "outreach.compose",
  )!;
  await expect(
    approvedArea
      .getByRole("region", { name: `Review ${composeAudit.determinationId}` })
      .getByText(contactSource, { exact: false }),
  ).toBeVisible();
  const copy = await json<{ bodyText: string }>(
    api,
    "post",
    `/v1/outreach/threads/${thread.threadId}/drafts/${draft.draftId}/copy`,
    { expectedFingerprint: thread.fingerprint },
  );
  expect(copy.bodyText).toBe("Hello, Synthetic Recruiter.");

  // A malformed external response must not replace the accepted message.
  const revision = api.post(`/v1/outreach/threads/${thread.threadId}/drafts`, {
    data: {
      expectedFingerprint: thread.fingerprint,
      sourceDraftId: draft.draftId,
      editedBodyText: "Hello again.",
    },
  });
  (await modelCall(app, "outreach.claims")).invalidJson();
  expect((await revision).ok()).toBe(false);
  const afterFailure = (
    await json<{ thread: Thread }>(
      api,
      "get",
      `/v1/outreach/threads/${thread.threadId}`,
    )
  ).thread;
  expect(afterFailure.approvedDraftId).toBe(draft.draftId);
  expect(afterFailure.drafts).toHaveLength(1);

  const payload = {
    requestId: randomUUID(),
    draftId: draft.draftId,
    channel: "email",
    sentAt: "2026-11-01",
  };
  const receipt = (
    await json<{ sendLog: SendLog }>(
      api,
      "post",
      `/v1/outreach/threads/${thread.threadId}/send-logs`,
      payload,
    )
  ).sendLog;
  thread = (
    await json<{ thread: Thread }>(
      api,
      "get",
      `/v1/outreach/threads/${thread.threadId}`,
    )
  ).thread;
  thread = (
    await json<{ thread: Thread }>(
      api,
      "post",
      `/v1/outreach/threads/${thread.threadId}/follow-up/schedule`,
      { expectedFingerprint: thread.fingerprint, dueAt: "2000-01-01" },
    )
  ).thread;
  const due = await json<{ followUps: { threadId: string }[] }>(
    api,
    "get",
    "/v1/outreach/follow-ups/due",
  );
  expect(due.followUps.map((item) => item.threadId)).toContain(thread.threadId);
  thread = (
    await json<{ thread: Thread }>(
      api,
      "post",
      `/v1/outreach/threads/${thread.threadId}/follow-up/complete`,
      { expectedFingerprint: thread.fingerprint },
    )
  ).thread;
  expect(thread.followUp?.state).toBe("completed");

  const staleContact = await api.patch(`/v1/contacts/${contact.contactId}`, {
    data: { expectedFingerprint: "stale", employer: "Changed Co" },
  });
  expect(staleContact.status()).toBe(409);
  await json(api, "patch", `/v1/contacts/${contact.contactId}`, {
    expectedFingerprint: contact.fingerprint,
    employer: "Updated Synthetic Co",
  });
  const beforeRetry = (
    await json<{ thread: Thread }>(
      api,
      "get",
      `/v1/outreach/threads/${thread.threadId}`,
    )
  ).thread;
  expect(beforeRetry.drafts[0]!.sourcesCurrent).toBe(false);
  const staleCopy = await api.post(
    `/v1/outreach/threads/${thread.threadId}/drafts/${draft.draftId}/copy`,
    { data: { expectedFingerprint: beforeRetry.fingerprint } },
  );
  expect(staleCopy.status()).toBe(409);
  const replay = (
    await json<{ sendLog: SendLog }>(
      api,
      "post",
      `/v1/outreach/threads/${thread.threadId}/send-logs`,
      payload,
    )
  ).sendLog;
  expect(replay).toEqual(receipt);
  const wrongReplay = await api.post(
    `/v1/outreach/threads/${thread.threadId}/send-logs`,
    { data: { ...payload, channel: "phone_call" } },
  );
  expect(wrongReplay.status()).toBe(409);
  const afterRetry = (
    await json<{ thread: Thread }>(
      api,
      "get",
      `/v1/outreach/threads/${thread.threadId}`,
    )
  ).thread;
  expect(afterRetry.revision).toBe(beforeRetry.revision);
  expect(afterRetry.sendLogs).toEqual([receipt]);
  expect(afterRetry.followUp?.state).toBe("completed");
  expect(app.external.sends).toHaveLength(0);

  await page.goto(`/outreach/${contact.contactId}`);
  await expect(
    page.getByRole("heading", { name: "Synthetic Recruiter" }),
  ).toBeVisible();
  const currentApproved = page
    .getByRole("heading", { name: "Approved message" })
    .locator("..");
  await expect(
    currentApproved.getByText("Hello, Synthetic Recruiter.", { exact: true }),
  ).toBeVisible();
  await expect(
    currentApproved.getByRole("button", { name: "Copy approved message" }),
  ).toBeDisabled();
});

test("interview notes and learning activity preserve source ownership; the digest is reviewed in the UI", async ({
  app,
  api,
  page,
  allowRequestFailure,
}) => {
  await createBaseline(api);
  const job = await createPosting(api, "career");
  const profileBefore = await json(api, "get", "/v1/profile");
  const fitBefore = await json(api, "get", `/v1/jobs/${job.job_id}/fit`);
  const question = await json<{ question: { id: string } }>(
    api,
    "get",
    "/v1/interviews/questions/B01",
  );
  expect(question.question.id).toBe("B01");
  const notePath = `/v1/jobs/${job.job_id}/interview-notes`;
  const note = {
    questionId: "B01",
    expectedRevision: 0,
    noteText: "A synthetic example to prepare.",
    factualSupport: "unverified_user_statement",
  };
  await json(api, "post", notePath, note);
  const stale = await api.post(notePath, {
    data: { ...note, noteText: "A stale edit." },
  });
  expect(stale.status()).toBe(409);
  await json(api, "post", notePath, {
    ...note,
    expectedRevision: 1,
    noteText: "A revised synthetic example.",
  });
  const history = await json<{
    notes: { revision: number; noteText: string; factualSupport: string }[];
  }>(api, "get", `${notePath}?questionId=B01&history=true`);
  expect(history.notes.map((item) => item.revision)).toEqual([2, 1]);
  expect(history.notes[0]).toMatchObject({
    noteText: "A revised synthetic example.",
    factualSupport: "unverified_user_statement",
  });

  const path = "/v1/evidence-map/learning";
  const preview = await json<Learning>(api, "post", path, {
    action: "preview",
    jobIds: [job.job_id],
  });
  expect(preview.preview?.analyzedCount).toBe(1);
  const openLearning = async () => {
    await expect(
      page.getByRole("heading", { name: "Review a selected-job cohort" }),
    ).toBeVisible();
  };
  const chooseJob = async () => {
    await page
      .getByRole("checkbox", {
        name: "Synthetic Reliability Engineer · Synthetic Hiring Company",
      })
      .check();
  };
  await page.goto("/learning");
  await openLearning();
  await page.getByLabel("Cohort name").fill("Synthetic cohort");
  await page.getByLabel("Selection date").fill("2026-11-06");
  await page
    .getByLabel("Your aspirations (separate from demonstrated capability)")
    .fill("Learn how recovery is designed.");
  await chooseJob();
  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("link", { name: "Jobs", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("link", { name: "My profile", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "My profile sections", exact: true })
    .getByRole("link", { name: "Learning", exact: true })
    .click();
  await expect(page.getByLabel("Cohort name")).toHaveValue("Synthetic cohort");
  await expect(
    page.getByLabel("Your aspirations (separate from demonstrated capability)"),
  ).toHaveValue("Learn how recovery is designed.");
  await expect(
    page.getByRole("checkbox", {
      name: "Synthetic Reliability Engineer · Synthetic Hiring Company",
    }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Review selected cohort" }).click();
  await expect(
    page.getByText("Review selected cohort before model comparison"),
  ).toBeVisible();
  const isCompare = (request: import("@playwright/test").Request) =>
    request.method() === "POST" &&
    new URL(request.url()).pathname === path &&
    request.postDataJSON()?.action === "compare";
  let deliveredStatus: number | undefined;
  await page.route(
    `**${path}`,
    async (route) => {
      const response = await route.fetch();
      deliveredStatus = response.status();
      await route.abort("failed");
    },
    { times: 1 },
  );
  const sent = page.waitForRequest(isCompare);
  await page.getByRole("button", { name: "Compare reviewed postings" }).click();
  const browserRequest = await sent;
  const compareInput = browserRequest.postDataJSON() as Record<string, unknown>;
  const requestId = browserRequest.headers()["idempotency-key"]!;
  expect(requestId).toBeTruthy();
  expect(compareInput).toMatchObject({
    title: "Synthetic cohort",
    jobIds: [job.job_id],
    expectedSnapshotFingerprint: preview.preview!.fingerprint,
  });
  const call = await modelCall(app, "learning.career_demand_comparison");
  expect(sources(call.body)).toContainEqual(
    expect.objectContaining({
      source_id: `posting:${job.job_id}`,
      text: "Implement and maintain durable workflow recovery.",
    }),
  );
  const storageKey = `jobctrl:request-recovery:local:${encodeURIComponent(JSON.stringify(["local", "learning.execute", "learning"]))}`;
  const readIdentity = () =>
    page.evaluate((key) => sessionStorage.getItem(key), storageKey);
  const rawIdentity = await readIdentity();
  expect(rawIdentity).toBeTruthy();
  const identity = JSON.parse(rawIdentity!) as Record<string, unknown>;
  expect(identity).toMatchObject({
    version: 1,
    requestId,
    operation: "learning.execute",
    requestKind: "compare",
    sourceFingerprint: preview.preview!.fingerprint,
  });
  expect(identity["fingerprint"]).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.keys(identity).sort()).toEqual(
    [
      "databaseInstanceId",
      "fingerprint",
      "operation",
      "requestId",
      "requestKind",
      "sourceFingerprint",
      "version",
      "workspaceId",
    ].sort(),
  );
  expect(rawIdentity).not.toContain("Synthetic cohort");
  expect(rawIdentity).not.toContain("Learn how recovery is designed.");
  expect(rawIdentity).not.toContain(job.job_id);
  // Forward the real comparison, then drop only its response at the browser
  // transport boundary. Navigation alone need not abort an in-flight request.
  const dropped = page.waitForEvent("requestfailed", {
    predicate: (request) => request === browserRequest,
  });
  call.reply({
    demands: [
      {
        demand_id: "d1",
        skill: "Durable workflow recovery",
        mentions: [
          {
            source_id: `posting:${job.job_id}`,
            quote: "durable workflow recovery",
            exact_values: [],
          },
        ],
        capability: "not_evidenced",
        evidence: [],
        rationale: "No confirmed evidence was supplied for this demand.",
        uncertainty: "The selected posting is not a market-wide sample.",
      },
    ],
    proposals: [
      {
        proposal_id: "p1",
        demand_id: "d1",
        kind: "learning",
        title: "Study recovery",
        action: "Review a synthetic recovery design.",
        completion_criterion: "Write a short design note.",
        rationale: "A bounded activity for this demand.",
      },
    ],
    uncertainty: "This comparison covers one selected posting.",
  });
  const failedRequest = await dropped;
  expect(failedRequest.headers()["idempotency-key"]).toBe(requestId);
  allowRequestFailure(failedRequest, "net::ERR_FAILED");
  expect(deliveredStatus).toBe(200);
  await page.reload();
  expect(await readIdentity()).toBe(rawIdentity);
  await openLearning();
  await expect(
    page.getByText("Recorded request status: complete."),
  ).toBeVisible();
  await page
    .getByLabel("Cohort name")
    .fill("A different unconfirmed comparison");
  await chooseJob();
  await expect(
    page.getByRole("button", { name: "Review selected cohort" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Compare reviewed postings" }),
  ).toBeDisabled();
  let savedResult: Learning | undefined;
  await expect
    .poll(
      async () => {
        const response = await api.get(`${path}/request-status`, {
          headers: { "Idempotency-Key": requestId },
        });
        expect(response.ok(), await response.text()).toBe(true);
        const status = (await response.json()) as {
          state: string;
          result?: Learning;
        };
        savedResult = status.result;
        return status.state;
      },
      {
        timeout: 30_000,
        message: "The server must settle the disconnected comparison",
      },
    )
    .toBe("complete");
  const modelCalls = app.external.calls.filter(
    (item) => item.body?.["operation"] === "learning.career_demand_comparison",
  ).length;
  expect(modelCalls).toBe(1);
  const replay = await api.post(path, {
    headers: { "Idempotency-Key": requestId },
    data: compareInput,
  });
  expect(replay.ok(), await replay.text()).toBe(true);
  const replayed = (await replay.json()) as Learning;
  expect(replayed).toEqual(savedResult);
  const conflict = await api.post(path, {
    headers: { "Idempotency-Key": requestId },
    data: { ...compareInput, title: "Different input" },
  });
  expect(conflict.status()).toBe(409);
  expect(
    ((await conflict.json()) as { error: { code: string } }).error.code,
  ).toBe("idempotency_conflict");
  expect(
    app.external.calls.filter(
      (item) =>
        item.body?.["operation"] === "learning.career_demand_comparison",
    ),
  ).toHaveLength(modelCalls);
  const checkPrevious = page.getByRole("button", {
    name: "Check previous request",
  });
  await expect(checkPrevious).toBeEnabled();
  await checkPrevious.click();
  await expect(
    page.getByText("The saved result of the earlier request was recovered."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Synthetic cohort" }),
  ).toBeVisible();
  expect(await readIdentity()).toBeNull();
  const cohort = replayed.cohorts[0]!;
  expect(cohort.comparison.demands[0]?.capability).toBe("not_evidenced");
  const chosen = await json<Learning>(api, "post", path, {
    action: "choose",
    cohortId: cohort.cohortId,
    expectedRevision: cohort.revision,
    determinationId: cohort.determinationId,
    proposalId: "p1",
  });
  const milestone = chosen.milestones[0]!;
  const updated = await json<Learning>(api, "post", path, {
    action: "update",
    milestoneId: milestone.milestoneId,
    expectedRevision: milestone.revision,
    status: "completed",
    completionEvidence: "Wrote a synthetic design note.",
  });
  expect(updated.milestones[0]).toMatchObject({
    status: "completed",
    completionEvidence: "Wrote a synthetic design note.",
  });
  expect(updated.milestones[0]!.history.map((item) => item.status)).toEqual([
    "completed",
    "planned",
  ]);
  const invalidComparison = api.post(path, {
    data: {
      ...compareInput,
      cohortId: cohort.cohortId,
      expectedRevision: cohort.revision,
    },
  });
  const invalidLearning = await modelCall(
    app,
    "learning.career_demand_comparison",
  );
  invalidLearning.reply({
    demands: [
      {
        demand_id: "d2",
        skill: "Unsupported demand",
        mentions: [
          {
            source_id: `posting:${job.job_id}`,
            quote: "A quotation absent from the posting.",
            exact_values: [],
          },
        ],
        capability: "not_evidenced",
        evidence: [],
        rationale: "Controlled invalid source citation.",
        uncertainty: "Unverified.",
      },
    ],
    proposals: [],
    uncertainty: "Unverified.",
  });
  expect((await invalidComparison).status()).toBe(502);
  const retainedLearning = await json<Learning>(api, "get", path);
  expect(retainedLearning.cohorts[0]?.determinationId).toBe(
    cohort.determinationId,
  );
  expect(retainedLearning.milestones[0]?.status).toBe("completed");
  expect(await json(api, "get", "/v1/profile")).toEqual(profileBefore);
  expect(await json(api, "get", `/v1/jobs/${job.job_id}/fit`)).toEqual(
    fitBefore,
  );

  await page.goto("/learning");
  await expect(
    page.getByRole("heading", { name: "Synthetic cohort" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Study recovery", level: 4 }),
  ).toBeVisible();
  const milestoneEditor = page.getByRole("article", {
    name: "Milestone Study recovery",
    exact: true,
  });
  const completion = milestoneEditor.getByRole("textbox", {
    name: "Completion evidence or artifact reference",
    exact: true,
  });
  await completion.fill("Unsaved synthetic milestone notes.");
  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("link", { name: "Jobs", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("link", { name: "My profile", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "My profile sections", exact: true })
    .getByRole("link", { name: "Learning", exact: true })
    .click();
  await expect(completion).toHaveValue("Unsaved synthetic milestone notes.");
  const competingActivity = await json<Learning>(api, "post", path, {
    action: "update",
    milestoneId: milestone.milestoneId,
    expectedRevision: updated.milestones[0]!.revision,
    status: "in_progress",
    completionEvidence: "Saved activity from another editor.",
  });
  await expect(milestoneEditor.getByRole("alert")).toContainText(
    "This milestone changed since the draft began.",
  );
  await expect(completion).toHaveValue("Unsaved synthetic milestone notes.");
  await expect(
    milestoneEditor.getByRole("button", {
      name: "Save milestone activity",
      exact: true,
    }),
  ).toBeDisabled();
  await milestoneEditor
    .getByRole("button", {
      name: "Keep my draft against this saved version",
      exact: true,
    })
    .click();
  await milestoneEditor
    .getByRole("button", { name: "Save milestone activity", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await json<Learning>(api, "get", path)).milestones[0]!.revision,
    )
    .toBe(competingActivity.milestones[0]!.revision + 1);
  expect(
    (await json<Learning>(api, "get", path)).milestones[0]!.completionEvidence,
  ).toBe("Unsaved synthetic milestone notes.");

  // A provider disconnect leaves an unknown model outcome. After a reload the
  // UI must retain only the request identity and refuse a fresh comparison.
  const priorCalls = app.external.calls.filter(
    (item) => item.body?.["operation"] === "learning.career_demand_comparison",
  ).length;
  await page.getByLabel("Cohort name").fill("Unresolved synthetic cohort");
  await page
    .getByLabel("Your aspirations (separate from demonstrated capability)")
    .fill("Unresolved private input canary");
  await chooseJob();
  await page.getByRole("button", { name: "Review selected cohort" }).click();
  await expect(
    page.getByText("Review selected cohort before model comparison"),
  ).toBeVisible();
  let unresolvedStatus: number | undefined;
  await page.route(
    `**${path}`,
    async (route) => {
      const response = await route.fetch();
      unresolvedStatus = response.status();
      await route.abort("failed");
    },
    { times: 1 },
  );
  const sentUnresolved = page.waitForRequest(isCompare);
  await page.getByRole("button", { name: "Compare reviewed postings" }).click();
  const unresolvedRequest = await sentUnresolved;
  const unresolvedId = unresolvedRequest.headers()["idempotency-key"]!;
  const unresolvedModel = await modelCall(
    app,
    "learning.career_demand_comparison",
  );
  const unresolvedIdentity = await readIdentity();
  expect(unresolvedIdentity).toBeTruthy();
  expect(
    JSON.parse(unresolvedIdentity!) as Record<string, unknown>,
  ).toMatchObject({
    requestId: unresolvedId,
    operation: "learning.execute",
    requestKind: "compare",
  });
  expect(unresolvedId).not.toBe(requestId);
  expect(unresolvedIdentity).not.toContain("Unresolved synthetic cohort");
  expect(unresolvedIdentity).not.toContain("Unresolved private input canary");
  const droppedUnresolved = page.waitForEvent("requestfailed", {
    predicate: (request) => request === unresolvedRequest,
  });
  unresolvedModel.disconnect();
  const failedUnresolvedRequest = await droppedUnresolved;
  expect(failedUnresolvedRequest.headers()["idempotency-key"]).toBe(
    unresolvedId,
  );
  allowRequestFailure(failedUnresolvedRequest, "net::ERR_FAILED");
  expect(unresolvedStatus).toBe(409);
  await page.reload();
  await openLearning();
  await expect
    .poll(
      async () => {
        const response = await api.get(`${path}/request-status`, {
          headers: { "Idempotency-Key": unresolvedId },
        });
        expect(response.ok(), await response.text()).toBe(true);
        return ((await response.json()) as { state: string }).state;
      },
      { timeout: 30_000 },
    )
    .toBe("unresolved");
  const checkUnresolved = page.getByRole("button", {
    name: "Check previous request",
  });
  await expect(checkUnresolved).toBeEnabled();
  await checkUnresolved.click();
  await expect(
    page.getByText("Recorded request status: unresolved."),
  ).toBeVisible();
  await expect(
    page.getByText(/The earlier model attempt remains unconfirmed/),
  ).toBeVisible();
  expect(await readIdentity()).toBe(unresolvedIdentity);
  await page.getByLabel("Cohort name").fill("Another comparison");
  await chooseJob();
  await expect(
    page.getByRole("button", { name: "Review selected cohort" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Compare reviewed postings" }),
  ).toBeDisabled();
  expect(
    app.external.calls.filter(
      (item) =>
        item.body?.["operation"] === "learning.career_demand_comparison",
    ),
  ).toHaveLength(priorCalls + 1);
  await page.goto("/interviews");
  await expect(
    page.getByRole("heading", { name: "Interviews", exact: true }),
  ).toBeVisible();

  const digest = await json<{ generatedAt: string; since: string | null }>(
    api,
    "get",
    "/v1/digest",
  );
  expect(digest.since).toBeNull();
  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { name: "Daily digest" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Mark reviewed" }).click();
  await expect
    .poll(
      async () =>
        (await json<{ since: string | null }>(api, "get", "/v1/digest")).since,
    )
    .not.toBeNull();
  expect(await json(api, "get", "/v1/profile")).toEqual(profileBefore);
  expect(await json(api, "get", `/v1/jobs/${job.job_id}/fit`)).toEqual(
    fitBefore,
  );
});

test("offer terms retain unknowns, corrections and explicit compensation source permissions", async ({
  api,
  page,
}) => {
  await createBaseline(api);
  const job = await createPosting(api, "offer");
  const path = `/v1/jobs/${job.job_id}/offer`;
  const initial = await json<Offer>(api, "get", path);
  expect(initial.currentTerms).toBeNull();
  expect(initial.currentDecision).toBeNull();
  const source = {
    reference: "synthetic offer",
    quote: "EUR 90000 per year",
    capturedAt: "2026-11-06T12:00:00Z",
    userConfirmed: true,
  };
  const terms = {
    source,
    cash: [
      {
        component: "base_salary",
        amount: 90000,
        currency: "EUR",
        period: "year",
        source,
      },
    ],
    equity: null,
    benefits: null,
    decisionDeadline: null,
  };
  const first = await json<Offer>(api, "post", `${path}/terms`, {
    expectedRevisionId: null,
    terms,
  });
  expect(first.currentTerms?.terms).toMatchObject({
    cash: [{ amount: 90000 }],
    equity: null,
    benefits: null,
    decisionDeadline: null,
  });
  const firstRevision = first.currentTerms!.revisionId;
  const stale = await api.post(`${path}/terms`, {
    data: { expectedRevisionId: null, terms, correctionReason: "stale" },
  });
  expect(stale.status()).toBe(409);
  const correctedSource = { ...source, quote: "EUR 95000 per year" };
  const correctedTerms = {
    ...terms,
    source: correctedSource,
    cash: [{ ...terms.cash[0]!, amount: 95000, source: correctedSource }],
  };
  const corrected = await json<Offer>(api, "post", `${path}/terms`, {
    expectedRevisionId: firstRevision,
    terms: correctedTerms,
    correctionReason: "Corrected the recorded base salary.",
  });
  expect(
    corrected.termsHistory.map((item) => item.terms.cash[0]!.amount),
  ).toEqual([90000, 95000]);
  expect(corrected.currentTerms?.terms).toMatchObject({
    equity: null,
    benefits: null,
    decisionDeadline: null,
  });
  const decision = await json<Offer>(api, "post", `${path}/decisions`, {
    expectedDecisionId: null,
    termsRevisionId: corrected.currentTerms!.revisionId,
    decision: "accepted",
    occurredAt: "2026-11-06T12:00:00Z",
    source: correctedSource,
  });
  const decisionCorrection = await json<Offer>(
    api,
    "post",
    `${path}/decisions`,
    {
      expectedDecisionId: decision.currentDecision!.decisionId,
      termsRevisionId: corrected.currentTerms!.revisionId,
      decision: "declined",
      occurredAt: "2026-11-06T12:00:00Z",
      source: correctedSource,
      correctionReason: "Corrected the recorded decision.",
    },
  );
  expect(decisionCorrection.decisions.map((item) => item.decision)).toEqual([
    "accepted",
    "declined",
  ]);
  expect(decisionCorrection.currentDecision?.correctionReason).toBe(
    "Corrected the recorded decision.",
  );
  const staleDecision = await api.post(`${path}/decisions`, {
    data: {
      expectedDecisionId: decision.currentDecision!.decisionId,
      termsRevisionId: corrected.currentTerms!.revisionId,
      decision: "accepted",
      occurredAt: "2026-11-06T12:00:00Z",
      source: correctedSource,
      correctionReason: "stale",
    },
  });
  expect(staleDecision.status()).toBe(409);
  expect((await json<Offer>(api, "get", path)).decisions).toEqual(
    decisionCorrection.decisions,
  );

  const settings = await json<{
    revision: number;
    sources: { sourceId: string; control: { enabled: boolean } }[];
  }>(api, "get", "/v1/compensation/sources");
  expect(
    settings.sources.find((item) => item.sourceId === "levels_fyi")?.control
      .enabled,
  ).toBe(false);
  const permission = {
    sourceId: "levels_fyi",
    enabled: true,
    accessMode: "public_markdown",
    europeCoverageConfirmed: false,
    expectedRevision: settings.revision,
  };
  const enabled = await json<typeof settings>(
    api,
    "patch",
    "/v1/compensation/sources",
    permission,
  );
  expect(
    enabled.sources.find((item) => item.sourceId === "levels_fyi")?.control
      .enabled,
  ).toBe(true);
  expect(
    (
      await api.patch("/v1/compensation/sources", { data: permission })
    ).status(),
  ).toBe(409);
  const disabled = await json<typeof settings>(
    api,
    "patch",
    "/v1/compensation/sources",
    { ...permission, enabled: false, expectedRevision: enabled.revision },
  );
  expect(
    disabled.sources.find((item) => item.sourceId === "levels_fyi")?.control
      .enabled,
  ).toBe(false);
  const compensation = await json<{
    summary: {
      posted: { recordStatus: string };
      market: { recordStatus: string };
    };
  }>(api, "get", `/v1/jobs/${job.job_id}/compensation`);
  expect(compensation.summary.posted.recordStatus).toBe("not_recorded");
  expect(compensation.summary.market.recordStatus).toBe("not_requested");
  await page.goto(`/jobs/${job.job_id}?jobTab=offer`);
  await expect(page.getByText("Offer decision: declined")).toBeVisible();
  await page.getByText("Offer history", { exact: true }).click();
  await expect(
    page.getByText("Corrected the recorded base salary."),
  ).toBeVisible();
});

test("contact research requires confirmation and distinguishes invalid output from an empty result", async ({
  app,
  api,
  page,
}) => {
  await createBaseline(api);
  const job = await createPosting(api, "contact-research");
  type Research = { taskId: string; runId: string; status: string };
  type Detail = {
    task: {
      status: string;
      revision: number;
      reviewAuthorityVerified: boolean;
      sourceAttempts: {
        outcome: string;
        determinationId: string;
        authorityVerified: boolean;
      }[];
      candidates: {
        candidateId: string;
        status: string;
        authorityVerified: boolean;
        attributes: { value: string; provenance: { userConfirmed: boolean } }[];
      }[];
    };
  };
  const research = (suffix: string) => ({
    employer: "Synthetic Research Co",
    jobId: job.job_id,
    sources: [
      {
        category: "public_web_page",
        url: `https://research.example/${suffix}`,
        label: "Team",
      },
    ],
  });
  async function pageAndModel(suffix: string) {
    const pending = api.post("/v1/contacts/research", {
      data: research(suffix),
    });
    const external = await app.external.next();
    expect(external.path).toBe("/model");
    expect(external.body).toMatchObject({
      operation: "contacts.page",
      method: "GET",
      url: `https://research.example/${suffix}`,
    });
    external.respond({
      status: 200,
      final_url: `https://research.example/${suffix}`,
      body: "<p>Synthetic Recruiter</p>",
      robots_allowed: true,
    });
    const model = await modelCall(app, "contacts.extract");
    const source = sources(model.body)[0]!;
    expect(source.text).toContain("Synthetic Recruiter");
    return { pending, model, source };
  }
  const first = await pageAndModel("people");
  const start = first.source.text.indexOf("Synthetic Recruiter");
  const extraction = {
    source_id: first.source.source_id,
    candidates: [
      {
        name: {
          source_id: first.source.source_id,
          start,
          end: start + "Synthetic Recruiter".length,
        },
        title: null,
        email: null,
        profileUrl: null,
        role: "recruiter",
        confidence: 1.0,
      },
    ],
  };
  first.model.reply(extraction);
  const result = await first.pending;
  expect(result.ok(), await result.text()).toBe(true);
  const firstRun = (await result.json()) as Research;
  await completed(api, firstRun.runId);
  const taskId = firstRun.taskId;
  const before = await json<Detail>(
    api,
    "get",
    `/v1/contacts/research/${taskId}`,
  );
  expect(before.task.candidates[0]).toMatchObject({
    status: "needs_review",
    authorityVerified: true,
    attributes: [
      { value: "Synthetic Recruiter", provenance: { userConfirmed: false } },
    ],
  });
  expect(before.task.reviewAuthorityVerified).toBe(true);
  const researchAudit = await json<DeterminationAudit>(
    api,
    "get",
    `/v1/contacts/research/${taskId}/determinations`,
  );
  expect(researchAudit).toMatchObject({
    complete: true,
    authorityVerified: true,
  });
  expect(researchAudit.records).toHaveLength(1);
  const researchRecord = researchAudit.records[0]!;
  expect(researchRecord).toMatchObject({
    determinationId: before.task.sourceAttempts[0]!.determinationId,
    available: true,
    verified: true,
    accepted: true,
    operation: "contacts.extract",
    provenance: { lane: "contact" },
  });
  expect(researchRecord.provenance.receipt_id).toBe(
    researchRecord.determinationId,
  );
  expect(researchRecord.instructions).toBe(first.model.body["instructions"]);
  expect(researchRecord.sources).toEqual(first.model.body["sources"]);
  expect(researchRecord.responseSchema).toEqual(
    first.model.body["response_schema"],
  );
  expect(researchRecord.context).toEqual(first.model.body["context"]);
  expect(researchRecord.result).toEqual(extraction);
  const candidate = before.task.candidates[0]!;
  const beforeConfirmation = await json<{ items: Contact[] }>(
    api,
    "get",
    "/v1/contacts?employer=Synthetic%20Research%20Co",
  );
  expect(beforeConfirmation.items).toEqual([]);
  await page.goto(`/jobs/${job.job_id}?jobTab=people`);
  const researchPanel = page.getByRole("region", { name: "Contact research" });
  await expect(
    researchPanel.getByRole("button", { name: "Confirm contact" }),
  ).toBeEnabled();
  await researchPanel
    .getByText("Inspect research prompts, model results and sources", {
      exact: true,
    })
    .click();
  await expect(
    researchPanel.getByText(
      "Recorded model receipts and source bindings verified.",
    ),
  ).toBeVisible();
  await expect(
    researchPanel
      .getByRole("region", { name: `Review ${researchRecord.determinationId}` })
      .getByText(first.source.source_id, { exact: false }),
  ).toBeVisible();
  const confirmedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `/v1/contacts/research/${taskId}/candidates/${candidate.candidateId}/confirm`,
  );
  await researchPanel.getByRole("button", { name: "Confirm contact" }).click();
  const confirmed = await confirmedResponse;
  expect(confirmed.status()).toBe(200);
  expect(
    ((await confirmed.json()) as { contact: Contact }).contact.attributes[0]!
      .provenance.userConfirmed,
  ).toBe(true);

  const empty = await pageAndModel("empty");
  empty.model.reply({ source_id: empty.source.source_id, candidates: [] });
  const emptyResponse = await empty.pending;
  expect(emptyResponse.ok(), await emptyResponse.text()).toBe(true);
  const emptyRun = (await emptyResponse.json()) as Research;
  await completed(api, emptyRun.runId);
  const emptyTask = emptyRun.taskId;
  const emptyDetail = await json<Detail>(
    api,
    "get",
    `/v1/contacts/research/${emptyTask}`,
  );
  expect(emptyDetail.task.sourceAttempts[0]?.outcome).toBe("no_candidates");
  const emptyAudit = await json<DeterminationAudit>(
    api,
    "get",
    `/v1/contacts/research/${emptyTask}/determinations`,
  );
  expect(emptyAudit).toMatchObject({
    complete: true,
    authorityVerified: true,
    records: [
      {
        available: true,
        verified: true,
        accepted: true,
        result: { candidates: [] },
      },
    ],
  });

  const invalid = await pageAndModel("invalid");
  invalid.model.reply({
    source_id: invalid.source.source_id,
    candidates: [
      {
        name: { source_id: invalid.source.source_id, start: 0, end: 9999 },
        title: null,
        email: null,
        profileUrl: null,
        role: "recruiter",
        confidence: 1.0,
      },
    ],
  });
  const invalidResponse = await invalid.pending;
  expect(invalidResponse.ok(), await invalidResponse.text()).toBe(true);
  const failedTask = (await invalidResponse.json()) as Research;
  await completed(api, failedTask.runId);
  const invalidDetail = await json<Detail>(
    api,
    "get",
    `/v1/contacts/research/${failedTask.taskId}`,
  );
  expect(invalidDetail.task.status).toBe("failed");
  expect(invalidDetail.task.sourceAttempts[0]?.outcome).toBe("invalid_output");
  expect(invalidDetail.task.candidates).toEqual([]);
  const invalidAudit = await json<DeterminationAudit>(
    api,
    "get",
    `/v1/contacts/research/${failedTask.taskId}/determinations`,
  );
  expect(invalidAudit).toMatchObject({
    complete: true,
    authorityVerified: true,
    records: [{ available: true, verified: true, accepted: false }],
  });

  const beforeProtected = app.external.calls.filter(
    (call) => call.body?.["operation"] === "contacts.page",
  ).length;
  const protectedTask = await json<Research>(
    api,
    "post",
    "/v1/contacts/research",
    {
      employer: "Synthetic Research Co",
      sources: [
        {
          category: "public_web_page",
          url: "https://research.example/login",
          label: "Protected",
        },
      ],
    },
  );
  await completed(api, protectedTask.runId);
  const protectedDetail = await json<Detail>(
    api,
    "get",
    `/v1/contacts/research/${protectedTask.taskId}`,
  );
  expect(protectedDetail.task.sourceAttempts[0]?.outcome).toBe(
    "manual_capture_required",
  );
  expect(
    app.external.calls.filter(
      (call) => call.body?.["operation"] === "contacts.page",
    ),
  ).toHaveLength(beforeProtected);
});

test.describe("independent Discovery and Companies", () => {
// Remove orchestration while retaining the recorded-data owners used by Job Detail.
test.use({ features: "profile,jobs,requirements,fit,resumes,discovery,companies" });

test("Discovery ingests a controlled provider page and Companies retains a sourced briefing on failed refresh", async ({
  app,
  api,
  page,
}) => {
  const settings = {
    queries: ["Synthetic Engineer"],
    locations: [{ location: "Madrid", remote: false }],
    boards: ["linkedin"],
    resultsPerSite: 5,
    hoursOld: 0,
    newJobLimit: 5,
  };
  type DiscoverySettings = {
    revision: number;
    policyRevision: number;
    settings: typeof settings & {
      applyApprovalRequired: boolean;
      autoApply: boolean;
      minFitScore: number;
    };
    effectiveSettings: {
      applyApprovalRequired: {
        value: boolean;
        locked: boolean;
        editable: boolean;
      };
    };
  };
  const initialSettings = await json<DiscoverySettings>(
    api,
    "get",
    "/v1/discovery/settings",
  );
  expect(initialSettings.settings.applyApprovalRequired).toBe(true);
  expect(initialSettings.effectiveSettings.applyApprovalRequired).toMatchObject(
    { value: true, locked: true, editable: false },
  );
  const saved = await json<DiscoverySettings>(
    api,
    "patch",
    "/v1/discovery/settings",
    { ...settings, expectedRevision: initialSettings.revision },
  );
  expect(saved.settings).toMatchObject(settings);
  expect(saved.settings.autoApply).toBe(initialSettings.settings.autoApply);
  const forgedApproval = await api.patch("/v1/discovery/settings", {
    data: {
      expectedRevision: saved.revision,
      expectedPolicyRevision: saved.policyRevision,
      applyApprovalRequired: false,
    },
  });
  expect(forgedApproval.status()).toBe(409);
  const stalePolicy = await api.patch("/v1/discovery/settings", {
    data: {
      expectedRevision: saved.revision,
      expectedPolicyRevision: saved.policyRevision - 1,
      minFitScore: saved.settings.minFitScore === 7 ? 8 : 7,
    },
  });
  expect(stalePolicy.status()).toBe(409);
  const retainedSettings = await json<DiscoverySettings>(
    api,
    "get",
    "/v1/discovery/settings",
  );
  expect(retainedSettings.revision).toBe(saved.revision);
  expect(retainedSettings.settings).toEqual(saved.settings);
  const staleSettings = await api.patch("/v1/discovery/settings", {
    data: {
      ...settings,
      queries: ["stale change"],
      expectedRevision: initialSettings.revision,
    },
  });
  expect(staleSettings.status()).toBe(409);
  await page.goto("/discovery");
  await page
    .locator("summary")
    .filter({ hasText: /^Search plans, schedules and source behavior$/ })
    .click();
  await page
    .locator("summary")
    .filter({ hasText: /^One-off search with temporary criteria$/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Discovery runs" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Explicit search targets" }),
  ).toBeVisible();
  const planPanel = page.getByRole("region", { name: "Profile search plan" });
  await planPanel.getByRole("button", { name: /Profile search plan/ }).click();
  await expect(
    planPanel.getByText("No search plan has been saved yet."),
  ).toBeVisible();
  await expect(
    planPanel.getByRole("button", { name: "Refresh search plan" }),
  ).toBeDisabled();
  const queuedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/v1/actions/discovery.search",
  );
  await page.getByRole("button", { name: "Run discovery" }).click();
  const queued = await queuedResponse;
  expect(queued.status()).toBe(202);
  const search = (await queued.json()) as { runId: string };
  const provider = await app.external.next();
  expect(provider.method).toBe("POST");
  expect(provider.path).toBe("/discovery");
  expect(provider.body["request"]).toMatchObject({
    query: "Synthetic Engineer",
    location: "Madrid",
    remote_only: false,
    sites: ["linkedin"],
  });
  provider.respond({
    jobs: [
      {
        job_key: "synthetic-provider-job",
        url: "https://example.com/jobs/discovered",
        title: "Synthetic Engineer",
        company: "Synthetic Hiring Company",
        description: "Maintain durable workflows.",
        location: "Madrid",
      },
    ],
    cursor: null,
    complete: true,
  });
  await completed(api, search.runId);
  await expect(page.locator(".discovery-runs-panel").getByRole("region", { name: "Job search progress", exact: true })).toContainText("Search completed");
  await expect(page.locator(".discovery-runs-panel").getByRole("region", { name: "Job search progress", exact: true })).toContainText("Initial fit assessment is unavailable in this application.");
  const sourceRegistry = await json<{
    sources: { sourceId: string; recommendedState: string }[];
  }>(api, "get", "/v1/discovery/sources");
  expect(sourceRegistry.sources).toContainEqual(
    expect.objectContaining({ sourceId: "jobstreaming:linkedin" }),
  );
  const listing = await json<{ jobs: { job_id: string; title: string }[] }>(
    api,
    "get",
    "/v1/jobs",
  );
  const job = listing.jobs.find((item) => item.title === "Synthetic Engineer");
  expect(job).toBeTruthy();
  const jobId = job!.job_id;
  expect(
    await json<null>(api, "get", `/v1/jobs/${jobId}/company-briefing`),
  ).toBeNull();

  const configured = await app.cli([
    "company-briefing",
    "configure",
    jobId,
    "--company-url",
    "https://company.example/",
    "--source",
    "https://company.example/about",
    "--confirm-identity",
    "--json",
  ]);
  expect(configured.exitCode, configured.stderr).toBe(0);
  expect(JSON.parse(configured.stdout)).toMatchObject({ status: "missing" });
  const refresh = await action(api, "companies.refresh", {
    job_id: jobId,
    allow_public_fetch: true,
  });
  const sourcePage = await app.external.next();
  expect(sourcePage.method).toBe("GET");
  expect(sourcePage.path).toBe("/company-page");
  expect(sourcePage.headers["x-jobctrl-source-url"]).toBe(
    "https://company.example/about",
  );
  sourcePage.raw(
    "<html><body>Synthetic Hiring Company builds workflow tools.</body></html>",
    { headers: { "Content-Type": "text/html" } },
  );
  const model = await modelCall(app, "companies.briefing");
  const companySource = sources(model.body)[0]!;
  expect(companySource.text).toContain(
    "Synthetic Hiring Company builds workflow tools.",
  );
  const citation = {
    source_id: companySource.source_id,
    quote: "Synthetic Hiring Company builds workflow tools.",
    exact_values: [],
  };
  model.reply({
    identity: "confirmed",
    identity_reason: "The selected page identifies the named company.",
    identity_citations: [citation],
    claims: [
      {
        kind: "company_fact",
        text: "The company says it builds workflow tools.",
        uncertainty: "Based on the selected company page.",
        event_date: null,
        citations: [citation],
      },
    ],
  });
  await completed(api, refresh.runId);
  type Briefing = {
    status: string;
    accepted: {
      determinationId: string;
      result: { claims: { text: string }[] };
    } | null;
    lastAttempt: { failureCode: string | null } | null;
  };
  const accepted = await json<Briefing>(
    api,
    "get",
    `/v1/jobs/${jobId}/company-briefing`,
  );
  expect(accepted.status).toBe("current");
  expect(accepted.accepted?.result.claims[0]?.text).toBe(
    "The company says it builds workflow tools.",
  );
  await page.goto(`/jobs/${jobId}`);
  await expect(
    page.getByRole("heading", { name: "Synthetic Engineer" }),
  ).toBeVisible();
  await expect(
    page.getByText("The company says it builds workflow tools."),
  ).toBeVisible();

  const failed = await action(api, "companies.refresh", {
    job_id: jobId,
    allow_public_fetch: true,
    force: true,
  });
  const failedPage = await app.external.next();
  expect(failedPage.path).toBe("/company-page");
  failedPage.raw("Service unavailable", { status: 503 });
  await expect
    .poll(
      async () =>
        (
          await json<{ status: string }>(
            api,
            "get",
            `/v1/action-runs/${failed.runId}`,
          )
        ).status,
      { timeout: 40_000 },
    )
    .toBe("failed");
  const retained = await json<Briefing>(
    api,
    "get",
    `/v1/jobs/${jobId}/company-briefing`,
  );
  expect(retained.accepted?.determinationId).toBe(
    accepted.accepted?.determinationId,
  );
  expect(retained.lastAttempt?.failureCode).toBeTruthy();
  await expect(
    page.getByText("The company says it builds workflow tools."),
  ).toBeVisible();
});
});

test("compensation evidence cites the posting and an explicit manual report and survives a failed refresh", async ({
  app,
  api,
  page,
}) => {
  const job = await json<{ job_id: string }>(api, "post", "/v1/jobs/capture", {
    url: "https://example.com/jobs/pay",
    title: "Senior Software Engineer",
    company: "Synthetic Pay Company",
    location: "Madrid, Spain",
    description: "Develop software.",
    salary: "Base salary EUR 80000 to EUR 100000 per year.",
  });
  // This is an explicitly selected import file, not a database seed or a recorded model output.
  const observationsPath = path.join(app.workspace, "synthetic-pay.json");
  await writeFile(
    observationsPath,
    JSON.stringify([
      {
        source: "manual",
        company: "Synthetic Pay Company",
        role: "Senior Software Engineer",
        location: "Madrid, Spain",
        level: "senior",
        currency: "EUR",
        period: "year",
        component: "total_compensation",
        min: 85000,
        max: 110000,
        sampleCount: 5,
        releaseYear: 2026,
        attribution: "Synthetic report",
      },
    ]),
  );
  const refreshPath = `/v1/jobs/${job.job_id}/actions/refresh-compensation`;
  const options = {
    observationsJsonPath: observationsPath,
    includeEuroTopTech: false,
  };
  const submitted = await api.post(refreshPath, { data: options });
  expect(submitted.status(), await submitted.text()).toBe(202);
  const run = (await submitted.json()) as { runId: string };
  const pay = await modelCall(app, "compensation.posted_pay");
  const postingSource = sources(pay.body)[0]!;
  expect(postingSource.text).toBe(
    "Base salary EUR 80000 to EUR 100000 per year.",
  );
  pay.reply({
    parse_state: "parsed_range",
    currency: "EUR",
    period: "year",
    component: "base_salary",
    minimum_amount: 80000,
    maximum_amount: 100000,
    confidence: "high",
    warnings: [],
    citations: [
      { source_id: postingSource.source_id, quote: postingSource.text },
    ],
    rationale: "The posting states this annual base range.",
  });
  // Each explicit classification is bound to the actual posting or report row.
  for (const kind of ["posting", "report"] as const) {
    const call = await modelCall(app, "compensation.classification");
    const source = sources(call.body)[0]!;
    expect(source.source_id).toContain(
      kind === "posting"
        ? `posting:${job.job_id}`
        : "manual_reported_compensation:",
    );
    expect(source.text).toContain("Senior Software Engineer");
    expect(source.text).toContain("Madrid, Spain");
    const roleCitation = [
      { source_id: source.source_id, quote: "Senior Software Engineer" },
    ];
    const companyCitation = [
      { source_id: source.source_id, quote: "Synthetic Pay Company" },
    ];
    const locationCitation = [
      { source_id: source.source_id, quote: "Madrid, Spain" },
    ];
    call.reply({
      occupation: {
        value: "software_engineering",
        citations: roleCitation,
        rationale: "The cited role is software engineering.",
      },
      seniority: {
        value: "senior",
        citations: roleCitation,
        rationale: "The role states senior.",
      },
      countries: [
        {
          value: "ES",
          citations: locationCitation,
          rationale: "The selected location is in Spain.",
        },
      ],
      geography_scope: {
        value: "locality",
        citations: locationCitation,
        rationale: "The source specifies a city within Spain.",
      },
      locality: {
        value: "Madrid",
        citations: locationCitation,
        rationale: "The selected locality is Madrid.",
      },
      market_scope: {
        value: "company",
        citations: companyCitation,
        rationale: "The source names one company.",
      },
      company_tier: {
        value: "unknown",
        citations: companyCitation,
        rationale: "No tier is stated.",
      },
    });
  }
  await completed(api, run.runId);
  type Compensation = {
    summary: {
      posted: {
        recordStatus: string;
        range: { minimumAmount: number; maximumAmount: number } | null;
      };
      market: {
        recordStatus: string;
        range: { minimumAmount: number; maximumAmount: number } | null;
      };
    };
    audit: {
      posted: { determination: { receipt_id: string } };
      market: { estimate: { sourceCount: number } };
    };
  };
  const accepted = await json<Compensation>(
    api,
    "get",
    `/v1/jobs/${job.job_id}/compensation`,
  );
  expect(accepted.summary.posted).toMatchObject({
    recordStatus: "recorded",
    range: { minimumAmount: 80000, maximumAmount: 100000 },
  });
  expect(accepted.summary.market).toMatchObject({
    recordStatus: "recorded",
    range: { minimumAmount: 85000, maximumAmount: 110000 },
  });
  expect(accepted.audit.posted.determination.receipt_id).toBeTruthy();
  expect(accepted.audit.market.estimate.sourceCount).toBe(1);
  await page.goto(`/jobs/${job.job_id}`);
  await expect(
    page.getByRole("region", { name: "Compensation evidence" }),
  ).toBeVisible();

  const failure = await api.post(refreshPath, { data: options });
  expect(failure.status(), await failure.text()).toBe(202);
  const failedRun = (await failure.json()) as { runId: string };
  (await modelCall(app, "compensation.posted_pay")).invalidJson();
  await expect
    .poll(
      async () =>
        (
          await json<{ status: string }>(
            api,
            "get",
            `/v1/action-runs/${failedRun.runId}`,
          )
        ).status,
      { timeout: 40_000 },
    )
    .toBe("failed");
  const retained = await json<Compensation>(
    api,
    "get",
    `/v1/jobs/${job.job_id}/compensation`,
  );
  expect(retained.audit.posted.determination.receipt_id).toBe(
    accepted.audit.posted.determination.receipt_id,
  );
  expect(retained.summary).toEqual(accepted.summary);
});

test("interview preparation honors an explicit empty evidence selection and retains the accepted preparation on failure", async ({
  app,
  api,
}) => {
  const { profile } = await createBaseline(api);
  const job = await createPosting(api, "interview-preparation");
  const card = await json<{
    catalogBinding: { catalogRevision: string; catalogDigest: string };
    question: { id: string; title: string };
  }>(api, "get", "/v1/interviews/questions/B01");
  const selection = {
    selectedQuestionIds: ["B01"],
    catalogBinding: card.catalogBinding,
    evidenceSelections: [{ questionId: "B01", evidenceIds: [] }],
    evidenceProfileVersion: profile.profileVersion,
  };
  const notePath = `/v1/jobs/${job.job_id}/interview-notes`;
  await json(api, "post", notePath, {
    questionId: "B01",
    expectedRevision: 0,
    noteText: "A separate synthetic note.",
    factualSupport: "unverified_user_statement",
  });
  const submit = async () => {
    const response = await api.post(
      `/v1/jobs/${job.job_id}/actions/generate-interview-prep`,
      { data: selection },
    );
    expect(response.status(), await response.text()).toBe(202);
    return (await response.json()) as { runId: string };
  };
  // Repeat the explicit choices against each new request's actual source IDs;
  // this is not a saved provider-output fixture or a semantic matcher.
  const respondToPreparation = async (qualityVerdict: "pass" | "fail") => {
    const plan = await modelCall(app, "interviews.preparation");
    expect((plan.body["response_schema"] as { title: string }).title).toBe(
      "InterviewPlan",
    );
    const planMessages = JSON.parse(sources(plan.body)[0]!.text) as {
      content: string;
    }[];
    const planData = JSON.parse(planMessages[0]!.content) as {
      sources: { source_id: string; text: string }[];
    };
    expect(planData.sources).toContainEqual(
      expect.objectContaining({
        source_id: "card:B01",
        text: expect.stringContaining(card.question.title),
      }),
    );
    plan.reply({
      questions: [
        {
          question_id: "B01",
          rationale: "Selected by the user.",
          citations: [
            {
              source_id: "card:B01",
              quote: card.question.title,
              exact_values: [],
            },
          ],
          evidence: [],
          requirement_ids: [],
        },
      ],
    });
    const draft = await modelCall(app, "interviews.preparation");
    expect((draft.body["response_schema"] as { title: string }).title).toBe(
      "QuestionPrepCandidate",
    );
    const draftMessages = JSON.parse(sources(draft.body)[0]!.text) as {
      content: string;
    }[];
    expect(draftMessages[0]!.content).toContain('"selected_evidence": []');
    draft.reply({
      items: [
        {
          question_id: "B01",
          outline: [
            {
              heading: "Approach",
              text: "I would clarify the relevant tradeoffs.",
              evidence_ids: [],
              requirement_ids: [],
              factual_support: "hypothetical",
              transform_type: "hypothetical",
              reason: "No evidence was selected.",
            },
          ],
          gaps: [
            {
              prompt: "What relevant example could you share?",
              reason: "No personal evidence was selected.",
            },
          ],
          probes: [],
          rationale: "Ask for a grounded example.",
        },
      ],
    });
    const review = await modelCall(app, "interviews.preparation");
    const reviewMessages = JSON.parse(sources(review.body)[0]!.text) as {
      content: string;
    }[];
    const reviewData = JSON.parse(reviewMessages[0]!.content) as {
      context: { lines: { line_id: string; allowed_evidence_ids: string[] }[] };
    };
    expect(reviewData.context.lines.length).toBeGreaterThan(0);
    expect(
      reviewData.context.lines.every(
        (line) => line.allowed_evidence_ids.length === 0,
      ),
    ).toBe(true);
    review.reply({
      verdict: "pass",
      lines: reviewData.context.lines.map((line) => ({
        line_id: line.line_id,
        verdict: "pass",
        served_requirements: [],
        source_evidence: [],
        claims: [],
        findings: [],
      })),
      rationale: "The preparation makes no personal factual claims.",
    });
    const quality = await modelCall(app, "interviews.preparation");
    expect((quality.body["response_schema"] as { title: string }).title).toBe(
      "ArtifactQuality",
    );
    quality.reply({
      verdict: qualityVerdict,
      score: 0.8,
      findings: [],
      evidence_corrections: [],
      rationale:
        qualityVerdict === "pass"
          ? "Useful preparation with a focused clarification gap."
          : "The preparation needs another review.",
    });
  };
  const run = await submit();
  await respondToPreparation("pass");
  const result = await completed(api, run.runId);
  expect(result["result"]).toMatchObject({ status: "accepted", itemCount: 1 });
  type Prep = {
    generation: number;
    status: string;
    generationContext: {
      selectedQuestions: { selectedEvidenceIds: string[] }[];
    };
    items: { generatedText: string; evidenceIds: string[] }[];
  };
  const latestPath = `/v1/jobs/${job.job_id}/interview-prep`;
  const accepted = (await json<{ prep: Prep }>(api, "get", latestPath)).prep;
  expect(
    accepted.generationContext.selectedQuestions[0]?.selectedEvidenceIds,
  ).toEqual([]);
  expect(accepted.items[0]?.evidenceIds).toEqual([]);
  expect(accepted.items[0]?.generatedText).toContain(
    "What relevant example could you share?",
  );
  const provenance = await json<{
    receipts: {
      receipt_id: string;
      provider: string;
      model: string;
      lane: string;
      input_fingerprint: string;
    }[];
    determinations: { determinationId: string; receiptId: string }[];
  }>(
    api,
    "get",
    `/v1/jobs/${job.job_id}/interview-prep/${accepted.generation}/provenance`,
  );
  expect(provenance.receipts).toHaveLength(4);
  expect(provenance.determinations).toHaveLength(3);
  const receiptIds = new Set(
    provenance.receipts.map((receipt) => receipt.receipt_id),
  );
  expect(
    provenance.receipts.every(
      (receipt) =>
        receipt.lane === "interview" &&
        Boolean(receipt.provider) &&
        Boolean(receipt.model) &&
        /^[a-f0-9]{64}$/.test(receipt.input_fingerprint),
    ),
  ).toBe(true);
  expect(
    provenance.determinations.every(
      (item) => Boolean(item.determinationId) && receiptIds.has(item.receiptId),
    ),
  ).toBe(true);

  const failed = await submit();
  // This is an accounted, valid failure judgment, so a later deliberate retry
  // is admissible under the real spend preflight.
  await respondToPreparation("fail");
  const failedResult = await completed(api, failed.runId);
  expect(failedResult["result"]).toMatchObject({ status: "failed" });
  const retained = (await json<{ prep: Prep }>(api, "get", latestPath)).prep;
  expect(retained.generation).toBe(accepted.generation);
  const history = await json<{ generations: Prep[] }>(
    api,
    "get",
    `/v1/jobs/${job.job_id}/interview-prep/history`,
  );
  expect(history.generations.map((item) => item.status)).toEqual([
    "failed",
    "accepted",
  ]);
  const notes = await json<{ notes: { noteText: string }[] }>(
    api,
    "get",
    notePath,
  );
  expect(notes.notes[0]?.noteText).toBe("A separate synthetic note.");
  const retry = await submit();
  await respondToPreparation("pass");
  const retried = await completed(api, retry.runId);
  expect(retried["result"]).toMatchObject({ status: "accepted", itemCount: 1 });
  const latest = (await json<{ prep: Prep }>(api, "get", latestPath)).prep;
  expect(latest.generation).toBeGreaterThan(accepted.generation);
  expect(
    latest.generationContext.selectedQuestions[0]?.selectedEvidenceIds,
  ).toEqual([]);
  const callsBeforeInvalid = app.external.calls.filter(
    (item) => item.body?.["operation"] === "interviews.preparation",
  ).length;
  const invalid = await submit();
  const invalidPlan = await modelCall(app, "interviews.preparation");
  expect((invalidPlan.body["response_schema"] as { title: string }).title).toBe(
    "InterviewPlan",
  );
  invalidPlan.reply({
    questions: [
      {
        question_id: "B01",
        rationale: "Selected by the user.",
        citations: [
          {
            source_id: "card:B01",
            quote: "A quote absent from the selected card.",
            exact_values: [],
          },
        ],
        evidence: [],
        requirement_ids: [],
      },
    ],
  });
  expect((await completed(api, invalid.runId))["result"]).toMatchObject({
    status: "failed",
  });
  expect(
    (await json<{ prep: Prep }>(api, "get", latestPath)).prep.generation,
  ).toBe(latest.generation);
  expect(
    app.external.calls.filter(
      (item) => item.body?.["operation"] === "interviews.preparation",
    ),
  ).toHaveLength(callsBeforeInvalid + 1);
});

test.describe("without optional Discovery and Companies", () => {
  test.use({ features: "profile,jobs,requirements,fit,resumes" });

  test("manual Jobs remain available in the reduced Python composition", async ({
    api,
  }) => {
    const job = await createPosting(api, "manual-without-optional-features");
    const duplicate = await createPosting(
      api,
      "manual-without-optional-features",
    );
    expect(duplicate.job_id).toBe(job.job_id);
    const saved = await json<{ job_id: string; title: string }>(
      api,
      "get",
      `/v1/jobs/${job.job_id}`,
    );
    expect(saved.title).toBe("Synthetic Reliability Engineer");
    expect((await api.get("/v1/discovery/settings")).status()).toBe(404);
    expect(
      (await api.get(`/v1/jobs/${job.job_id}/company-briefing`)).status(),
    ).toBe(404);
  });
});
