import type { ResumeTemplateState } from "@jobctrl/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { JobResumeTemplateSelect } from "./JobResumeTemplateSelect.js";

const current: ResumeTemplateState = {
  effective: {
    templateId: "compact",
    templateVersionId: "compact:v1",
    templateVersionNumber: 1,
    templateName: "Compact",
    templateHash: "hash-compact",
    assignmentSource: "job_override",
  },
  snapshot: null,
  state: "template_current",
  reason: null,
  lastRefreshAttempt: null,
};

describe("<JobResumeTemplateSelect>", () => {
  it("renders material refresh as an icon-backed status", () => {
    render(
      <JobResumeTemplateSelect
        current={current}
        onTemplateChange={vi.fn()}
        refreshing
        templates={[]}
      />,
    );

    const status = screen.getByText("updating materials");
    expect(status).toHaveAttribute("data-slot", "status-badge");
    expect(status).toHaveAttribute("data-status-tone", "info");
    expect(status.querySelector("svg")).toHaveClass("tabler-icon-refresh");
    expect(
      screen.getByRole("combobox", { name: "Resume template" }),
    ).toHaveAttribute("aria-describedby", status.id);
  });
});
