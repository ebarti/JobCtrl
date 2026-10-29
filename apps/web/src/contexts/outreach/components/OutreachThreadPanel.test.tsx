import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { http, HttpResponse } from "msw";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  acknowledgeOutreachRevision,
  makeOutreachDraft,
  makeOutreachThreadDetail,
  makeBlockedCandidateThread,
  makeCandidateThread,
  makeOutreachFollowUp,
  makeOutreachSendLog,
  makeOutreachThreadResponse,
} from "../../../test/fixtures/outreach.js";
import { server } from "../../../test/msw/server.js";
import { renderWithProviders } from "../../../test/render.js";
import { outreachKeys } from "../queryKeys.js";
import { OutreachThreadPanel } from "./OutreachThreadPanel.js";

describe("<OutreachThreadPanel>", () => {
  it("shows the approved draft, the candidate under review, and the full generation history (INV-5)", async () => {
    const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Approved message" })).toBeInTheDocument(),
    );
    expect(view.getByRole("heading", { name: "Draft under review" })).toBeInTheDocument();
    expect(view.getByRole("heading", { name: "Generation history" })).toBeInTheDocument();
    // The approved draft is retained (copyable) alongside a fresh candidate (INV-5).
    expect(view.getByRole("button", { name: "Copy approved message" })).toBeInTheDocument();
    // Every generation is represented by a status badge.
    expect(view.getAllByText("Under review").length).toBeGreaterThan(0);
    expect(view.getAllByText("Approved").length).toBeGreaterThan(0);
    expect(view.getAllByText("Superseded").length).toBeGreaterThan(0);
    // INV-2: claim -> fact provenance is rendered for the draft(s).
    expect(view.getAllByText(/I noticed you lead the platform team at Acme/).length).toBeGreaterThan(
      0,
    );
    expect(view.getAllByText("Profile grounded").length).toBeGreaterThan(0);
  });

  it("reveals the revise form when the user chooses to revise the candidate", async () => {
    const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Draft under review" })).toBeInTheDocument(),
    );
    fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
    expect(view.getByRole("textbox")).toBeInTheDocument();
  });

  it("lets an approved-only thread revise the approved draft without hiding it", async () => {
    const approvedOnlyThread = makeOutreachThreadDetail({
      drafts: [
        makeOutreachDraft({
          draftId: "draft-approved",
          generation: 1,
          status: "approved",
          approvedAt: "2026-07-06T00:05:00+00:00",
          bodyText: "Hi Dana,\n\nApproved message to revise.\n\nBest,\nJordan",
        }),
      ],
    });
    let submittedBody = "";
    server.use(
      http.get("*/v1/contacts/:contactId/outreach", () =>
        HttpResponse.json(makeOutreachThreadResponse(approvedOnlyThread)),
      ),
      http.post("*/v1/outreach/threads/:threadId/drafts", async ({ request }) => {
        const body = (await request.json()) as { editedBodyText?: string };
        submittedBody = body.editedBodyText ?? "";
        const revised = makeOutreachThreadResponse(makeOutreachThreadDetail({ ...approvedOnlyThread, drafts: [
          ...approvedOnlyThread.drafts,
          makeOutreachDraft({ draftId: "approved-revision", generation: 2, bodyText: submittedBody }),
        ] }));
        return HttpResponse.json(acknowledgeOutreachRevision(revised, "approved-revision"));
      }),
    );
    const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Approved message" })).toBeInTheDocument(),
    );

    fireEvent.click(view.getByRole("button", { name: "Revise approved message" }));
    expect(view.getByRole("textbox", { name: "Edit message" })).toHaveValue(
      "Hi Dana,\n\nApproved message to revise.\n\nBest,\nJordan",
    );
    fireEvent.change(view.getByRole("textbox", { name: "Edit message" }), {
      target: { value: "Hi Dana,\n\nEdited approved message.\n\nBest,\nJordan" },
    });
    fireEvent.click(view.getByRole("button", { name: "Revise draft" }));

    await waitFor(() =>
      expect(submittedBody).toBe("Hi Dana,\n\nEdited approved message.\n\nBest,\nJordan"),
    );
    expect(view.getByRole("heading", { name: "Approved message" })).toBeInTheDocument();
  });

  it("offers a generate action and an empty message when there is no thread yet", async () => {
    server.use(
      http.get("*/v1/contacts/:contactId/outreach", () =>
        HttpResponse.json(makeOutreachThreadResponse(null)),
      ),
    );
    const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
    await waitFor(() => expect(view.getByText(/No outreach drafts yet/i)).toBeInTheDocument());
    expect(view.getByRole("button", { name: "Generate draft" })).toBeInTheDocument();
  });

  it("shows the send history and a log-a-send control when an approved draft exists (INV-1)", async () => {
    const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
    await waitFor(() => expect(view.getByRole("heading", { name: "Sends" })).toBeInTheDocument());
    // Default thread has an approved draft (draft-2) and no recorded sends yet.
    expect(view.getByText("No sends recorded yet.")).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "Log a send" }));
    // The recording control is explicit that JobCtrl does not send.
    expect(view.getByText(/JobCtrl only records that you sent it/i)).toBeInTheDocument();
  });

  it("lists a recorded send with its channel and generation", async () => {
    server.use(
      http.get("*/v1/contacts/:contactId/outreach", () =>
        HttpResponse.json(
          makeOutreachThreadResponse(
            makeOutreachThreadDetail({ sendLogs: [makeOutreachSendLog()], isSent: true }),
          ),
        ),
      ),
    );
    const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
    await waitFor(() =>
      expect(view.getByRole("list", { name: "Recorded sends" })).toBeInTheDocument(),
    );
    const recorded = within(view.getByRole("list", { name: "Recorded sends" }));
    expect(recorded.getByText("email")).toBeInTheDocument();
    expect(recorded.getByText("gen 2")).toBeInTheDocument();
  });

  it("hides the log-a-send control when there is no approved draft", async () => {
    server.use(
      http.get("*/v1/contacts/:contactId/outreach", () =>
        HttpResponse.json(makeOutreachThreadResponse(makeCandidateThread())),
      ),
    );
    const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
    await waitFor(() => expect(view.getByRole("heading", { name: "Sends" })).toBeInTheDocument());
    expect(view.queryByRole("button", { name: "Log a send" })).toBeNull();
  });

  it("renders the follow-up as a surfaced-only reminder that never sends (INV-1)", async () => {
    const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Follow-up" })).toBeInTheDocument(),
    );
    expect(view.getByText(/JobCtrl never sends it or acts on it/i)).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Schedule follow-up" })).toBeInTheDocument();
  });

  it("disables approval until the truthfulness gates pass", async () => {
    server.use(
      http.get("*/v1/contacts/:contactId/outreach", () =>
        HttpResponse.json(makeOutreachThreadResponse(makeBlockedCandidateThread())),
      ),
    );
    const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
    // The blocked banner renders for the candidate under review and again in the
    // generation history entry for the same draft, so match all occurrences.
    await waitFor(() =>
      expect(view.getAllByText("Truthfulness gates blocked this draft").length).toBeGreaterThan(0),
    );
    expect(view.getByRole("button", { name: "Approve draft" })).toBeDisabled();
    expect(
      view.getByText(/Approval is disabled until the truthfulness gates pass/i),
    ).toBeInTheDocument();
  });

  it("holds competing draft decisions while a delayed revision is pending", async () => {
    const candidateThread = makeCandidateThread();
    let revisionRequests = 0;
    let resolveRevision: (response: Response) => void = () => {};
    server.use(
      http.get("*/v1/contacts/:contactId/outreach", () =>
        HttpResponse.json(makeOutreachThreadResponse(candidateThread)),
      ),
      http.post("*/v1/outreach/threads/:threadId/drafts", () => {
        revisionRequests += 1;
        return new Promise<Response>((resolve) => {
          resolveRevision = resolve;
        });
      }),
    );
    const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Draft under review" })).toBeInTheDocument(),
    );

    fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
    const approve = view.getByRole("button", { name: "Approve draft" });
    const reject = view.getByRole("button", { name: "Reject draft" });
    const submitRevision = view.getByRole("button", { name: "Revise draft" });
    expect(approve).toBeDisabled();
    expect(reject).toBeDisabled();

    fireEvent.click(submitRevision);
    fireEvent.click(submitRevision);
    await waitFor(() => expect(revisionRequests).toBe(1));
    expect(view.getByRole("button", { name: "Cancel revision" })).toBeDisabled();

    const revised = makeOutreachThreadResponse(makeOutreachThreadDetail({ ...candidateThread, drafts: [
      ...candidateThread.drafts,
      makeOutreachDraft({ draftId: "published", generation: 2, bodyText: candidateThread.drafts[0]!.bodyText }),
    ] }));
    resolveRevision(HttpResponse.json(acknowledgeOutreachRevision(revised, "published")));
    await waitFor(() =>
      expect(view.queryByRole("textbox", { name: "Edit message" })).toBeNull(),
    );
    await waitFor(() => expect(approve).toBeEnabled());
    expect(reject).toBeEnabled();
  });

  it("admits only the first immediate candidate decision", async () => {
    const candidateThread = makeCandidateThread();
    let approvalRequests = 0;
    let rejectionRequests = 0;
    let resolveApproval: (response: Response) => void = () => {};
    server.use(
      http.get("*/v1/contacts/:contactId/outreach", () =>
        HttpResponse.json(makeOutreachThreadResponse(candidateThread)),
      ),
      http.post("*/v1/outreach/threads/:threadId/drafts/:draftId/approve", () => {
        approvalRequests += 1;
        return new Promise<Response>((resolve) => {
          resolveApproval = resolve;
        });
      }),
      http.post("*/v1/outreach/threads/:threadId/drafts/:draftId/reject", () => {
        rejectionRequests += 1;
        return HttpResponse.json(makeOutreachThreadResponse(candidateThread));
      }),
    );
    const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Draft under review" })).toBeInTheDocument(),
    );

    const approve = view.getByRole("button", { name: "Approve draft" });
    const reject = view.getByRole("button", { name: "Reject draft" });
    fireEvent.click(approve);
    fireEvent.click(reject);

    await waitFor(() => expect(approvalRequests).toBe(1));
    expect(rejectionRequests).toBe(0);

    resolveApproval(HttpResponse.json(makeOutreachThreadResponse(candidateThread)));
    await waitFor(() => expect(view.getByRole("button", { name: "Approve draft" })).toBeEnabled());
  });

  it("restores a candidate decision after a delayed approval failure", async () => {
    const candidateThread = makeCandidateThread();
    let approvalRequests = 0;
    let resolveApproval: (response: Response) => void = () => {};
    server.use(
      http.get("*/v1/contacts/:contactId/outreach", () =>
        HttpResponse.json(makeOutreachThreadResponse(candidateThread)),
      ),
      http.post("*/v1/outreach/threads/:threadId/drafts/:draftId/approve", () => {
        approvalRequests += 1;
        return new Promise<Response>((resolve) => {
          resolveApproval = resolve;
        });
      }),
    );
    const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Draft under review" })).toBeInTheDocument(),
    );

    fireEvent.click(view.getByRole("button", { name: "Approve draft" }));
    await waitFor(() => expect(approvalRequests).toBe(1));
    await waitFor(() => expect(view.queryByRole("button", { name: "Approve draft" })).toBeNull());

    resolveApproval(new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }));
    await waitFor(() => expect(view.getByRole("button", { name: "Approve draft" })).toBeEnabled());
    expect(view.getByRole("button", { name: "Reject draft" })).toBeEnabled();
  });
});

it.each(["replacement", "removed"])("keeps the editor and conflict checks when refresh leaves the original card %s", async (change) => {
  const { act } = await import("react");
  const { outreachKeys } = await import("../queryKeys.js");
  const { makeOutreachPublicationConflict } = await import("../../../test/fixtures/outreach.js");
  let current = makeOutreachThreadResponse(makeCandidateThread());
  let settle: (response: Response) => void = () => {};
  server.use(
    http.get("*/v1/contacts/:contactId/outreach", () => HttpResponse.json(current)),
    http.post("*/v1/outreach/threads/:threadId/drafts", () => new Promise<Response>((resolve) => { settle = resolve; })),
  );
  const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
  await waitFor(() => expect(view.getByRole("heading", { name: "Draft under review" })).toBeInTheDocument());
  fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
  fireEvent.change(view.getByRole("textbox"), { target: { value: "My retained message" } });
  fireEvent.click(view.getAllByRole("button", { name: "Revise draft" })[0]!);
  await waitFor(() => expect(view.getByRole("button", { name: "Revising…" })).toBeDisabled());
  current = makeOutreachThreadResponse(change === "removed" ? null : makeOutreachThreadDetail({ drafts: [makeOutreachDraft({ status: "approved", approvedAt: "2026-10-24", bodyText: "Newer accepted message" })] }));
  await act(async () => {
    view.queryClient.setQueryData(outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null), current);
  });
  expect(view.getByRole("textbox")).toHaveValue("My retained message");
  await waitFor(() => expect(view.queryByRole("heading", { name: "Draft under review" })).not.toBeInTheDocument());
  settle(HttpResponse.json(makeOutreachPublicationConflict(), { status: 409 }));
  await waitFor(() => expect(view.getByRole("group", { name: "Unpublished revision" })).toBeInTheDocument());
  expect(view.getByRole("textbox")).toHaveValue("My retained message");
  expect(view.getByText(/synthetic-quality-review/)).toBeInTheDocument();
  expect(view.getByRole("button", { name: "Revise draft" })).toBeDisabled();
  if (change === "replacement") expect(view.getAllByText("Newer accepted message")).toHaveLength(2);
});

it.each(["recipient", "job"])("suspends a retained revision when the selected %s changes and restores it only for its own target", async (change) => {
  const { makeOutreachPublicationConflict } = await import("../../../test/fixtures/outreach.js");
  const jobA = "00000000-0000-4000-8000-000000000001";
  const jobB = "00000000-0000-4000-8000-000000000002";
  const contactB = change === "recipient" ? "contact-2" : "contact-1";
  const nextJob = change === "job" ? jobB : jobA;
  const a = makeOutreachThreadResponse(makeOutreachThreadDetail({ ...makeCandidateThread(), threadId: "thread-A", contactId: "contact-1", jobId: jobA, drafts: [makeOutreachDraft({ threadId: "thread-A", draftId: "draft-A", generation: 1, status: "candidate" })] }));
  const b = makeOutreachThreadResponse(makeOutreachThreadDetail({ ...makeCandidateThread(), threadId: "thread-B", contactId: contactB, jobId: nextJob, drafts: [makeOutreachDraft({ threadId: "thread-B", draftId: "draft-B", generation: 1, status: "candidate" })] }));
  const requests: string[] = [];
  server.use(
    http.get("*/v1/contacts/:contactId/outreach", ({ params, request }) => HttpResponse.json(params.contactId === contactB && new URL(request.url).searchParams.get("jobId") === nextJob ? b : a)),
    http.post("*/v1/outreach/threads/:threadId/drafts", ({ params }) => {
      requests.push(String(params.threadId));
      return HttpResponse.json({ ...makeOutreachPublicationConflict("Retained edit for A"), threadId: "thread-A" }, { status: 409 });
    }),
  );
  const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" jobId={jobA} />);
  view.queryClient.setQueryData(outreachKeys.threadForContact(LOCAL_TENANT, contactB, nextJob), b);
  await view.findByRole("heading", { name: "Draft under review" });
  fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
  fireEvent.change(view.getByRole("textbox"), { target: { value: "Retained edit for A" } });
  fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
  await view.findByRole("group", { name: "Unpublished revision" });
  view.rerender(<OutreachThreadPanel contactId={contactB} jobId={nextJob} />);
  await view.findByRole("heading", { name: "Draft under review" });
  expect(view.queryByRole("textbox", { name: "Edit message" })).not.toBeInTheDocument();
  expect(view.queryByRole("group", { name: "Unpublished revision" })).not.toBeInTheDocument();
  expect(view.queryByRole("checkbox", { name: /I compared the current thread/ })).not.toBeInTheDocument();
  expect(requests).toEqual(["thread-A"]);
  view.rerender(<OutreachThreadPanel contactId="contact-1" jobId={jobA} />);
  expect(await view.findByRole("textbox", { name: "Edit message" })).toHaveValue("Retained edit for A");
  const proposal = view.getByRole("group", { name: "Unpublished revision" });
  fireEvent.click(within(proposal).getByRole("checkbox", { name: /I compared the current thread/ }));
  fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
  await waitFor(() => expect(requests).toEqual(["thread-A", "thread-A"]));
});

it.each(["delayed generation", "competing first creation"])("recovers %s through the normal generation caller and current contact read", async (scenario) => {
  const { act } = await import("react");
  const { makeOutreachPublicationConflict } = await import("../../../test/fixtures/outreach.js");
  const accepted = makeOutreachThreadDetail({ drafts: [makeOutreachDraft({ status: "approved", approvedAt: "2026-10-24", bodyText: "Current accepted message" })] });
  let current = makeOutreachThreadResponse(scenario === "competing first creation" ? null : accepted);
  let finish: (response: Response) => void = () => {};
  const calls: { contact: string; body: unknown }[] = [];
  const proposal = { ...makeOutreachPublicationConflict("Unpublished generated message"), threadId: scenario === "competing first creation" ? "unpublished-competing-thread" : accepted.threadId };
  server.use(
    http.get("*/v1/contacts/:contactId/outreach", () => HttpResponse.json(current)),
    http.post("*/v1/contacts/:contactId/outreach/drafts", async ({ request, params }) => {
      calls.push({ contact: String(params.contactId), body: await request.json() });
      if (calls.length === 1) return new Promise<Response>((resolve) => { finish = resolve; });
      return HttpResponse.json(current);
    }),
  );
  const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
  await waitFor(() => expect(view.queryClient.getQueryState(outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null))?.status).toBe("success"));
  fireEvent.click(view.getByRole("button", { name: "Generate draft" }));
  await waitFor(() => expect(calls).toHaveLength(1));
  current = makeOutreachThreadResponse({ ...accepted, threadId: "winner-thread" });
  await act(async () => {
    await view.queryClient.invalidateQueries({ queryKey: outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null) });
  });
  await view.findByRole("heading", { name: "Approved message" });
  finish(HttpResponse.json(proposal, { status: 409 }));
  const group = await view.findByRole("group", { name: "Unpublished draft" });
  expect(group).toHaveTextContent("Unpublished generated message");
  expect(group).toHaveTextContent("synthetic-quality-review");
  expect(view.getAllByText("Current accepted message")).toHaveLength(2);
  expect(view.getByRole("button", { name: "Generate draft" })).toBeDisabled();
  fireEvent.click(within(group).getByRole("checkbox", { name: /I compared the current thread/ }));
  fireEvent.click(view.getByRole("button", { name: "Generate draft" }));
  await waitFor(() => expect(calls).toEqual([{ contact: "contact-1", body: {} }, { contact: "contact-1", body: {} }]));
  await waitFor(() => expect(view.queryByRole("group", { name: "Unpublished draft" })).not.toBeInTheDocument());
  console.info(JSON.stringify({ scenario, calls, acceptedThread: current.thread?.threadId, conflictThread: proposal.threadId, retainedProposal: proposal.unpublishedDraft }));
});

it.each(["success", "conflict"])("keeps a revision's late %s bound to its original recipient after switching away", async (outcome) => {
  const { makeOutreachPublicationConflict } = await import("../../../test/fixtures/outreach.js");
  let a = makeOutreachThreadResponse({ ...makeCandidateThread(), threadId: "thread-A", contactId: "contact-A" });
  const b = makeOutreachThreadResponse({ ...makeCandidateThread(), threadId: "thread-B", contactId: "contact-B" });
  let finish: (response: Response) => void = () => {};
  const requests: string[] = [];
  server.use(
    http.get("*/v1/contacts/:contactId/outreach", ({ params }) => HttpResponse.json(params.contactId === "contact-A" ? a : b)),
    http.post("*/v1/outreach/threads/:threadId/drafts", ({ params }) => {
      requests.push(String(params.threadId));
      return new Promise<Response>((resolve) => { finish = resolve; });
    }),
  );
  const view = renderWithProviders(<OutreachThreadPanel contactId="contact-A" />);
  view.queryClient.setQueryData(outreachKeys.threadForContact(LOCAL_TENANT, "contact-B", null), b);
  await view.findByRole("button", { name: "Revise draft" });
  fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
  fireEvent.change(view.getByRole("textbox"), { target: { value: "Pending edit for A" } });
  fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
  await waitFor(() => expect(requests).toEqual(["thread-A"]));
  view.rerender(<OutreachThreadPanel contactId="contact-B" />);
  expect(view.queryByRole("textbox")).not.toBeInTheDocument();
  if (outcome === "success") {
    a = makeOutreachThreadResponse({ ...a.thread!, drafts: [
      ...a.thread!.drafts,
      makeOutreachDraft({ draftId: "saved-A", threadId: "thread-A", generation: 4, bodyText: "Pending edit for A" }),
    ] });
  }
  finish(outcome === "success" ? HttpResponse.json(acknowledgeOutreachRevision(a, "saved-A")) : HttpResponse.json({ ...makeOutreachPublicationConflict("Pending edit for A"), threadId: "thread-A" }, { status: 409 }));
  await waitFor(() => expect(view.queryClient.isMutating()).toBe(0));
  expect(view.queryByRole("textbox")).not.toBeInTheDocument();
  expect(view.queryByRole("group", { name: "Unpublished revision" })).not.toBeInTheDocument();
  view.rerender(<OutreachThreadPanel contactId="contact-A" />);
  if (outcome === "conflict") {
    expect(await view.findByRole("textbox")).toHaveValue("Pending edit for A");
    expect(view.getByRole("group", { name: "Unpublished revision" })).toBeInTheDocument();
  } else {
    await waitFor(() => expect(view.queryByRole("textbox")).not.toBeInTheDocument());
  }
  expect(requests).toEqual(["thread-A"]);
});

it.each(["success", "failure", "conflict"])("retains and can deliberately submit newer typing after a pending revision returns %s", async (outcome) => {
  const { makeOutreachPublicationConflict } = await import("../../../test/fixtures/outreach.js");
  const submitted = "Submitted synthetic revision A";
  const later = "New synthetic edit B while waiting";
  const original = makeOutreachThreadDetail({ sendLogs: [makeOutreachSendLog()], followUp: makeOutreachFollowUp() });
  let current = makeOutreachThreadResponse(original);
  let finish: (response: Response) => void = () => {};
  const requests: string[] = [];
  function publish(bodyText: string) {
    const previous = current.thread!;
    const drafts = [
      ...previous.drafts.map((draft) => draft.status === "candidate" ? { ...draft, status: "superseded" as const } : draft),
      makeOutreachDraft({ draftId: `published-${requests.length}`, generation: previous.latestGeneration + 1, bodyText }),
    ];
    current = makeOutreachThreadResponse(makeOutreachThreadDetail({ drafts, sendLogs: previous.sendLogs, followUp: previous.followUp }));
    return acknowledgeOutreachRevision(current, `published-${requests.length}`);
  }
  server.use(
    http.get("*/v1/contacts/:contactId/outreach", () => HttpResponse.json(current)),
    http.post("*/v1/outreach/threads/:threadId/drafts", async ({ request }) => {
      requests.push(((await request.json()) as { editedBodyText: string }).editedBodyText);
      if (requests.length === 1) return new Promise<Response>((resolve) => { finish = resolve; });
      return HttpResponse.json(publish(later));
    }),
  );
  const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
  fireEvent.click(await view.findByRole("button", { name: "Revise draft" }));
  const input = view.getByRole("textbox", { name: "Edit message" });
  fireEvent.change(input, { target: { value: submitted } });
  fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
  await waitFor(() => expect(requests).toEqual([submitted]));
  fireEvent.change(input, { target: { value: later } });
  if (outcome === "success") {
    finish(HttpResponse.json(publish(submitted)));
  } else if (outcome === "conflict") {
    finish(HttpResponse.json(makeOutreachPublicationConflict(submitted), { status: 409 }));
  } else {
    finish(HttpResponse.json({ message: "Synthetic provider failure" }, { status: 503 }));
  }
  await waitFor(() => expect(view.queryClient.isMutating()).toBe(0));
  expect(view.getByRole("textbox", { name: "Edit message" })).toHaveValue(later);
  expect(requests).toEqual([submitted]);
  if (outcome === "success") {
    expect(await view.findByText(/newer edits remain here and have not been verified/i)).toBeInTheDocument();
  } else if (outcome === "conflict") {
    const proposal = await view.findByRole("group", { name: "Unpublished revision" });
    expect(proposal).toHaveTextContent(submitted);
    expect(proposal).toHaveTextContent("synthetic-claim-review");
    expect(view.getByRole("button", { name: "Revise draft" })).toBeDisabled();
    fireEvent.click(within(proposal).getByRole("checkbox", { name: /I compared the current thread/ }));
  } else {
    const unconfirmed = await view.findByRole("group", { name: "Unconfirmed revision" });
    expect(unconfirmed).toHaveTextContent(submitted);
    expect(view.getByRole("button", { name: "Revise draft" })).toBeDisabled();
    fireEvent.click(within(unconfirmed).getByRole("checkbox", { name: /I checked the current thread/ }));
  }
  await waitFor(() => expect(view.getByRole("button", { name: "Revise draft" })).toBeEnabled());
  fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
  await waitFor(() => expect(requests).toEqual([submitted, later]));
  await waitFor(() => expect(view.queryByRole("textbox", { name: "Edit message" })).not.toBeInTheDocument());
  await waitFor(() => expect(view.queryClient.getQueryData(outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null))).toEqual(current));
  expect(current.thread?.sendLogs).toEqual(original.sendLogs);
  expect(current.thread?.followUp).toEqual(original.followUp);
  expect(current.thread?.drafts.find((draft) => draft.status === "approved")).toEqual(original.drafts.find((draft) => draft.status === "approved"));
  expect(current.thread?.drafts.at(-1)?.bodyText).toBe(later);
});

it("lets the user discard newer typing after the submitted revision succeeds", async () => {
  let finish: (response: Response) => void = () => {};
  const requests: string[] = [];
  const accepted = makeOutreachThreadResponse(makeOutreachThreadDetail({ drafts: [
    ...makeCandidateThread().drafts,
    makeOutreachDraft({ draftId: "saved-A", generation: 4, bodyText: "Submitted A" }),
  ] }));
  server.use(
    http.get("*/v1/contacts/:contactId/outreach", () => HttpResponse.json(accepted)),
    http.post("*/v1/outreach/threads/:threadId/drafts", async ({ request }) => {
      requests.push(((await request.json()) as { editedBodyText: string }).editedBodyText);
      return new Promise<Response>((resolve) => { finish = resolve; });
    }),
  );
  const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
  fireEvent.click(await view.findByRole("button", { name: "Revise draft" }));
  const input = view.getByRole("textbox", { name: "Edit message" });
  fireEvent.change(input, { target: { value: "Submitted A" } });
  fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
  await waitFor(() => expect(requests).toEqual(["Submitted A"]));
  fireEvent.change(input, { target: { value: "Discardable later edit B" } });
  finish(HttpResponse.json(acknowledgeOutreachRevision(accepted, "saved-A")));
  expect(await view.findByText(/newer edits remain here/i)).toBeInTheDocument();
  fireEvent.click(view.getByRole("button", { name: "Discard revision" }));
  expect(view.queryByRole("textbox", { name: "Edit message" })).not.toBeInTheDocument();
  expect(requests).toEqual(["Submitted A"]);
  await waitFor(() => expect(view.queryClient.getQueryData(outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null))).toEqual(accepted));
});

it("clears a resolved conflict when its retry succeeds but preserves an edit made during that retry", async () => {
  const { makeOutreachPublicationConflict } = await import("../../../test/fixtures/outreach.js");
  const requests: string[] = [];
  let finishRetry: (response: Response) => void = () => {};
  let thread = makeOutreachThreadResponse(makeCandidateThread());
  function publish(bodyText: string) {
    thread = makeOutreachThreadResponse(makeOutreachThreadDetail({ drafts: [
      ...thread.thread!.drafts,
      makeOutreachDraft({ draftId: `saved-${requests.length}`, generation: requests.length + 1, bodyText }),
    ] }));
    return acknowledgeOutreachRevision(thread, `saved-${requests.length}`);
  }
  server.use(
    http.get("*/v1/contacts/:contactId/outreach", () => HttpResponse.json(thread)),
    http.post("*/v1/outreach/threads/:threadId/drafts", async ({ request }) => {
      requests.push(((await request.json()) as { editedBodyText: string }).editedBodyText);
      if (requests.length === 1) return HttpResponse.json(makeOutreachPublicationConflict("Conflicted A"), { status: 409 });
      if (requests.length === 2) return new Promise<Response>((resolve) => { finishRetry = resolve; });
      return HttpResponse.json(publish("Later edit C"));
    }),
  );
  const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
  fireEvent.click(await view.findByRole("button", { name: "Revise draft" }));
  const input = view.getByRole("textbox", { name: "Edit message" });
  fireEvent.change(input, { target: { value: "Conflicted A" } });
  fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
  const proposal = await view.findByRole("group", { name: "Unpublished revision" });
  fireEvent.change(input, { target: { value: "Retried B" } });
  fireEvent.click(within(proposal).getByRole("checkbox", { name: /I compared the current thread/ }));
  fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
  await waitFor(() => expect(requests).toEqual(["Conflicted A", "Retried B"]));
  fireEvent.change(input, { target: { value: "Later edit C" } });
  finishRetry(HttpResponse.json(publish("Retried B")));
  expect(await view.findByText(/newer edits remain here/i)).toBeInTheDocument();
  expect(view.getByRole("textbox", { name: "Edit message" })).toHaveValue("Later edit C");
  expect(view.queryByRole("group", { name: "Unpublished revision" })).not.toBeInTheDocument();
  expect(requests).toEqual(["Conflicted A", "Retried B"]);
  await waitFor(() => expect(view.getByRole("button", { name: "Revise draft" })).toBeEnabled());
  fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
  await waitFor(() => expect(requests).toEqual(["Conflicted A", "Retried B", "Later edit C"]));
  await waitFor(() => expect(view.queryByRole("textbox", { name: "Edit message" })).not.toBeInTheDocument());
});
