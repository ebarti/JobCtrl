import { fireEvent, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { ContactForm } from "./contact-form.js";

describe("<ContactForm> creation", () => {
  it("rejects overlong new facts and submits a value at the trimmed limit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const view = renderWithProviders(<ContactForm submitLabel="add contact" pending={false} onSubmit={onSubmit} />);
    await user.type(view.getByLabelText("Employer"), "Synthetic employer");
    const value = view.getByLabelText("Value");
    fireEvent.change(value, { target: { value: "X".repeat(2001) } });
    await user.click(view.getByRole("button", { name: "add contact" }));
    expect(view.getByText(/2000/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(value, { target: { value: `${"X".repeat(2000)} ` } });
    await user.click(view.getByRole("button", { name: "add contact" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      attributes: [{ kind: "name", value: "X".repeat(2000) }],
    }));
  });
});
