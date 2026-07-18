import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeOutreachDraft } from "../../../test/fixtures/outreach.js";
import { renderWithProviders } from "../../../test/render.js";
import { CopyDraftButton } from "./CopyDraftButton.js";

describe("<CopyDraftButton>", () => {
  it("copies the approved draft body via the clipboard port only (INV-1: no send)", async () => {
    const approved = makeOutreachDraft({ status: "approved", bodyText: "  Copy this approved message.\n" });
    const view = renderWithProviders(<CopyDraftButton draft={approved} />);
    fireEvent.click(view.getByRole("button", { name: "Copy approved message" }));
    await waitFor(() =>
      expect(view.ports.clipboard.write).toHaveBeenCalledWith("Copy this approved message."),
    );
  });

  it("is disabled for a draft that is not approved (INV-1: only approved drafts leave)", () => {
    const candidate = makeOutreachDraft({ status: "candidate" });
    const view = renderWithProviders(<CopyDraftButton draft={candidate} />);
    expect(view.getByRole("button", { name: "Copy approved message" })).toBeDisabled();
  });
});
