import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { CredentialForm } from "./credential-form.js";

describe("<CredentialForm> a11y", () => {
  it("has no critical axe violations on initial render", async () => {
    const view = renderWithProviders(
      <CredentialForm credentialKey="OPENAI_API_KEY" label="OpenAI API Key" configured={false} />,
    );
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
