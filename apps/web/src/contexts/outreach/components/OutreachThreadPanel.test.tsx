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
    expect(view.getByRole("button", { name: "copy approved message" })).toBeInTheDocument();
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
    fireEvent.click(view.getByRole("button", { name: "revise draft" }));
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

    fireEvent.click(view.getByRole("button", { name: "revise approved message" }));
    expect(view.getByRole("textbox", { name: "Edit message" })).toHaveValue(
      "Hi Dana,\n\nApproved message to revise.\n\nBest,\nJordan",
    );
    fireEvent.change(view.getByRole("textbox", { name: "Edit message" }), {
      target: { value: "Hi Dana,\n\nEdited approved message.\n\nBest,\nJordan" },
    });
    fireEvent.click(view.getByRole("button", { name: "revise draft" }));

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
    expect(view.getByRole("button", { name: "generate draft" })).toBeInTheDocument();
  });

  it("shows the send history and a log-a-send control when an approved draft exists (INV-1)", async () => {
    const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
    await waitFor(() => expect(view.getByRole("heading", { name: "Sends" })).toBeInTheDocument());
    // Default thread has an approved draft (draft-2) and no recorded sends yet.
    expect(view.getByText("No sends recorded yet.")).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "log a send" }));
    // The recording control is explicit that JobHunter does not send.
    expect(view.getByText(/JobHunter only records that you sent it/i)).toBeInTheDocument();
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
    expect(view.queryByRole("button", { name: "log a send" })).toBeNull();
  });

  it("renders the follow-up as a surfaced-only reminder that never sends (INV-1)", async () => {
    const view = renderWithProviders(<OutreachThreadPanel contactId="contact-1" />);
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Follow-up" })).toBeInTheDocument(),
    );
    expect(view.getByText(/JobHunter never sends it or acts on it/i)).toBeInTheDocument();
    expect(view.getByRole("button", { name: "schedule follow-up" })).toBeInTheDocument();
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
    expect(view.getByRole("button", { name: "approve draft" })).toBeDisabled();
    expect(
      view.getByText(/Approval is disabled until the truthfulness gates pass/i),
    ).toBeInTheDocument();
  });
});
