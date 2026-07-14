import { JobCtrlApiError } from "@jobctrl/api-client";
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { CredentialForm } from "./credential-form.js";

describe("<CredentialForm>", () => {
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
      screen.getByLabelText(/OpenAI API key/i),
      "synthetic-secret",
    );
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(
      await screen.findByRole("alert", { name: /Keychain update failed/i }),
    ).toHaveTextContent(/Unlock Keychain Access, then retry/i);
  });
});
