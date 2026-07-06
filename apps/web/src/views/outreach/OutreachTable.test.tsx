import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeContactListResponse } from "../../test/fixtures/contacts.js";
import { renderWithProviders } from "../../test/render.js";
import { OutreachTable } from "./OutreachTable.js";

describe("<OutreachTable>", () => {
  it("renders contacts with a provenance summary", () => {
    renderWithProviders(
      <OutreachTable data={makeContactListResponse()} loading={false} onOpenContact={() => {}} />,
    );
    expect(screen.getByText("Dana Reyes")).toBeInTheDocument();
    expect(screen.getByText("1 of 3 facts confirmed")).toBeInTheDocument();
  });

  it("opens a contact when its activation control is used", async () => {
    const user = userEvent.setup();
    const onOpenContact = vi.fn();
    renderWithProviders(
      <OutreachTable
        data={makeContactListResponse()}
        loading={false}
        onOpenContact={onOpenContact}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open contact Dana Reyes" }));
    expect(onOpenContact).toHaveBeenCalledWith("contact-1");
  });
});
