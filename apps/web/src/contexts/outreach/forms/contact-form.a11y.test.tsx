import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { ContactForm } from "./contact-form.js";

describe("<ContactForm> a11y", () => {
  it("has no critical axe violations on initial render", async () => {
    const view = renderWithProviders(
      <ContactForm submitLabel="add contact" pending={false} onSubmit={() => undefined} />,
    );
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
