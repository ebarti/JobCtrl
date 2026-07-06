import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { SendLogForm } from "./send-log-form.js";

describe("<SendLogForm> a11y", () => {
  it("has no critical axe violations on initial render", async () => {
    const view = renderWithProviders(
      <SendLogForm threadId="thread-1" contactId="contact-1" draftId="draft-2" />,
    );
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
