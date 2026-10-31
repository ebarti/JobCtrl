import type { ContactMutationResponse } from "@jobctrl/contracts";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { makeContactMutationResponse } from "../../../test/fixtures/contacts.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { ContactCreateButton } from "./ContactCreateButton.js";

describe("contact save sessions", () => {
  it("pauses creation input and dismissal until the submitted contact is acknowledged", async () => {
    const user = userEvent.setup();
    let resolve!: (value: ContactMutationResponse) => void;
    const save = vi.fn(() => new Promise<ContactMutationResponse>((done) => { resolve = done; }));
    const ports = buildTestPorts({ api: { createContact: save } });
    renderWithProviders(<ContactCreateButton />, { ports });
    await user.click(screen.getByRole("button", { name: "New contact" }));
    const employer = screen.getByLabelText("Employer");
    await user.clear(employer);
    await user.type(employer, "Synthetic submitted employer");
    await user.type(screen.getByLabelText("Value"), "Synthetic contact");
    await user.click(screen.getByRole("button", { name: "add contact" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(employer).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Role" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.type(employer, " newer input");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(employer).toHaveValue("Synthetic submitted employer");
    await act(async () => resolve(makeContactMutationResponse()));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
