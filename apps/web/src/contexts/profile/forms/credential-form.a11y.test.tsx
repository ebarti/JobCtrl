import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { CredentialForm } from "./credential-form.js";

describe("<CredentialForm> a11y", () => {
  it("has no critical axe violations on initial render", async () => {
    const view = renderWithProviders(
      <CredentialForm
        credentialKey="OPENAI_API_KEY"
        label="OpenAI API Key"
        configured={false}
      />,
    );
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations when the platform store is unavailable", async () => {
    const view = renderWithProviders(
      <>
        <p id="credential-unavailable">Use environment configuration.</p>
        <CredentialForm
          credentialKey="OPENAI_API_KEY"
          label="OpenAI API Key"
          configured={null}
          available={false}
          unavailableReason="unsupported_platform"
          unavailableDescriptionId="credential-unavailable"
        />
      </>,
    );
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations when Keychain inspection fails", async () => {
    const view = renderWithProviders(
      <>
        <p id="credential-unavailable">Unlock Keychain Access, then retry.</p>
        <CredentialForm
          credentialKey="OPENAI_API_KEY"
          label="OpenAI API Key"
          configured={null}
          available={false}
          unavailableReason="inspection_failed"
          unavailableDescriptionId="credential-unavailable"
        />
      </>,
    );
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
