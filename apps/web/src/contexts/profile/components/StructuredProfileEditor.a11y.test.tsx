import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { StructuredProfileEditor } from "./StructuredProfileEditor.js";

describe("<StructuredProfileEditor> a11y", () => {
  it("has no axe violations when binary preferences are unanswered", async () => {
    const profile = JSON.parse(JSON.stringify(sampleProfileResponse.profile));
    profile.work_authorization = {
      legally_authorized_to_work: "",
      require_sponsorship: "",
    };
    profile.availability = {
      available_for_full_time: "",
      available_for_contract: "",
    };

    const view = render(
      <StructuredProfileEditor
        mode="preferences"
        profileText={JSON.stringify(profile, null, 2)}
        styleText={JSON.stringify(sampleProfileResponse.style, null, 2)}
        onProfileTextChange={vi.fn()}
        onStyleTextChange={vi.fn()}
      />,
    );

    expect(await axe(view.container)).toHaveNoViolations();
  });
});
