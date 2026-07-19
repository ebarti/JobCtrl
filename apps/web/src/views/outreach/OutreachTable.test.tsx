import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeContactListResponse } from "../../test/fixtures/contacts.js";
import { renderWithProviders } from "../../test/render.js";
import { OutreachTable } from "./OutreachTable.js";

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

describe("<OutreachTable>", () => {
  afterEach(() => setViewportWidth(1024));

  it("renders contacts with a provenance summary", () => {
    renderWithProviders(
      <OutreachTable
        data={makeContactListResponse()}
        loading={false}
        onOpenContact={() => {}}
      />,
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
    await user.click(
      screen.getByRole("button", { name: "Open contact Dana Reyes" }),
    );
    expect(onOpenContact).toHaveBeenCalledWith("contact-1");
  });

  it("keeps identity, role, employer, and provenance together on mobile", async () => {
    setViewportWidth(390);
    renderWithProviders(
      <OutreachTable
        data={makeContactListResponse()}
        loading={false}
        onOpenContact={() => {}}
      />,
    );

    const list = await screen.findByRole("list", { name: "Contacts" });
    expect(within(list).getByText("Dana Reyes")).toBeInTheDocument();
    expect(within(list).getAllByText("Acme")).toHaveLength(2);
    expect(
      within(list).getByText("1 of 3 facts confirmed"),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole("button", { name: "Open contact Dana Reyes" }),
    ).not.toHaveClass("row-activation-focus-only");
  });
});
