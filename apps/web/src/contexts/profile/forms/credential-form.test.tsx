import { JobCtrlApiError } from "@jobctrl/api-client";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { CredentialForm } from "./credential-form.js";

describe("<CredentialForm>", () => {
  it("keeps the credential identity, secret input, and contextual actions in one field row", () => {
    renderWithProviders(
      <CredentialForm
        credentialKey="OPENAI_API_KEY"
        label="OpenAI API key"
        configured={false}
      />,
    );

    const input = screen.getByLabelText("OpenAI API key");
    const form = input.closest("form");
    expect(form).not.toBeNull();
    expect(form?.children).toHaveLength(3);
    expect(form?.children[0]).toHaveClass("credential-row-status");
    expect(form?.children[1]).toHaveClass("credential-row-field-group");
    expect(form?.children[2]).toHaveClass("credential-row-actions");

    const identity = form?.querySelector(".credential-row-identity");
    expect(identity).not.toBeNull();
    expect(within(identity as HTMLElement).getByText("OpenAI API key")).toHaveAttribute(
      "data-slot",
      "field-label",
    );
    expect(within(identity as HTMLElement).getByText("OPENAI_API_KEY")).toHaveAttribute(
      "id",
      "credential-openai_api_key-description",
    );
    expect(input).toHaveAttribute(
      "aria-describedby",
      "credential-openai_api_key-description",
    );
    expect(
      screen.getByRole("button", { name: "Save OpenAI API key" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Remove OpenAI API key" }),
    ).toBeDisabled();
  });

  it("turns an operational save failure into sanitized recovery guidance", async () => {
    const user = userEvent.setup();
    const updateCredential = vi.fn(async () => {
      throw new JobCtrlApiError(503, "Service Unavailable");
    });
    renderWithProviders(
      <CredentialForm
        credentialKey="OPENAI_API_KEY"
        label="OpenAI API key"
        configured={false}
      />,
      {
        ports: buildTestPorts({ api: { updateCredential } }),
      },
    );

    await user.type(
      screen.getByLabelText("OpenAI API key"),
      "synthetic-secret",
    );
    await user.click(
      screen.getByRole("button", { name: "Save OpenAI API key" }),
    );

    expect(
      await screen.findByRole("alert", { name: /Keychain update failed/i }),
    ).toHaveTextContent(/Unlock Keychain Access, then retry/i);
  });
});
