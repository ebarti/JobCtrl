import { fireEvent, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { DemoFeatureFlagAdapter } from "../../../demo/ports.js";
import { makeOutreachThreadResponse } from "../../../test/fixtures/outreach.js";
import { server } from "../../../test/msw/server.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { ReviseDraftForm } from "./revise-draft-form.js";

describe("<ReviseDraftForm>", () => {
  it("fails closed in the public demo before processing a message revision", () => {
    const reviseOutreachDraft = vi.fn();
    const ports = buildTestPorts({ api: { reviseOutreachDraft } });
    ports.featureFlags = new DemoFeatureFlagAdapter();
    const view = renderWithProviders(
      <ReviseDraftForm
        threadId="thread-1"
        contactId="contact-1"
        initialBodyText="Synthetic draft"
      />,
      { ports },
    );

    const textarea = view.getByRole("textbox", { name: "Edit message" });
    const submit = view.getByRole("button", { name: "Revise draft" });
    expect(textarea).toBeDisabled();
    expect(submit).toBeDisabled();
    expect(submit).toHaveAccessibleDescription(
      /Draft revision is available in the local app.*does not process message edits/i,
    );
    fireEvent.submit(view.container.querySelector("form")!);
    expect(reviseOutreachDraft).not.toHaveBeenCalled();
  });

  it("settles a delayed failed revision without an unhandled rejection and preserves a retryable edit", async () => {
    let settleFailure: (response: Response) => void = () => {};
    const onRevised = vi.fn();
    const onUnhandledRejection = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    server.use(
      http.post("*/v1/outreach/threads/:threadId/drafts", () =>
        new Promise<Response>((resolve) => {
          settleFailure = resolve;
        }),
      ),
    );

    try {
      const view = renderWithProviders(
        <ReviseDraftForm
          threadId="thread-1"
          contactId="contact-1"
          initialBodyText="Hi Dana,\n\nOriginal message.\n\nBest,\nJordan"
          onRevised={onRevised}
        />,
      );
      const textarea = view.getByRole("textbox", { name: "Edit message" });
      const submit = view.getByRole("button", { name: "Revise draft" });
      const editedBodyText = "Hi Dana,\n\nEdited message to retry.\n\nBest,\nJordan";

      fireEvent.change(textarea, { target: { value: editedBodyText } });
      fireEvent.click(submit);
      await waitFor(() => expect(submit).toHaveTextContent("Revising…"));

      settleFailure(
        HttpResponse.json({ message: "Revision service is temporarily unavailable." }, { status: 500 }),
      );

      await waitFor(() =>
        expect(view.getByText("Revision service is temporarily unavailable.")).toBeInTheDocument(),
      );
      expect(textarea).toHaveValue(editedBodyText);
      expect(submit).toBeEnabled();
      expect(onRevised).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onUnhandledRejection).not.toHaveBeenCalled();

      server.use(
        http.post("*/v1/outreach/threads/:threadId/drafts", () =>
          HttpResponse.json(makeOutreachThreadResponse()),
        ),
      );
      fireEvent.click(submit);
      await waitFor(() => expect(onRevised).toHaveBeenCalledTimes(1));
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    }
  });
});
