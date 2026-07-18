import { http, HttpResponse } from "msw";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  makeOutreachDraft,
  makeOutreachThreadDetail,
  makeBlockedCandidateThread,
  makeCandidateThread,
  makeOutreachSendLog,
  makeOutreachThreadResponse,
} from "../../../test/fixtures/outreach.js";
import { server } from "../../../test/msw/server.js";
import { renderWithProviders } from "../../../test/render.js";
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
        return HttpResponse.json(makeOutreachThreadResponse(approvedOnlyThread));
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

    resolveRevision(HttpResponse.json(makeOutreachThreadResponse(candidateThread)));
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
