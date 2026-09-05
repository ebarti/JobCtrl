import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { recordAt } from "../lib/json-record.js";
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
        profile={profile}
        style={recordAt(sampleProfileResponse, "style")}
        onProfileChange={vi.fn()}
        onStyleChange={vi.fn()}
      />,
    );

    expect(await axe(view.container)).toHaveNoViolations();
  });
});
