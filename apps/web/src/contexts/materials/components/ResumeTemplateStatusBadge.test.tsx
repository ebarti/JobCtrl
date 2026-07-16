import type {
  ResumeTemplateState,
  ResumeTemplateStaleState,
} from "@jobctrl/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ResumeTemplateStatusBadge } from "./ResumeTemplateStatusBadge.js";

const STATE_TONES: Record<ResumeTemplateStaleState, string> = {
  template_current: "ok",
  template_stale: "warn",
  refresh_queued: "info",
  refresh_failed: "warn",
  refresh_unavailable: "warn",
};

describe("<ResumeTemplateStatusBadge>", () => {
  it.each(Object.entries(STATE_TONES) as [ResumeTemplateStaleState, string][])(
    "renders %s with its existing tone",
    (state, tone) => {
      render(<ResumeTemplateStatusBadge state={templateState(state)} />);

      const badge = screen.getByTitle("Compact from job override.");
      expect(badge).toHaveAttribute("data-slot", "status-badge");
      expect(badge).toHaveAttribute("data-status-tone", tone);
    },
  );

  it.each([
    ["refresh_queued", "clock"],
    ["refresh_unavailable", "ban"],
  ] as const)("uses the domain-specific icon for %s", (state, iconName) => {
    render(<ResumeTemplateStatusBadge state={templateState(state)} />);

    expect(
      screen.getByTitle("Compact from job override.").querySelector("svg"),
    ).toHaveClass(`tabler-icon-${iconName}`);
  });
});

function templateState(state: ResumeTemplateStaleState): ResumeTemplateState {
  return {
    effective: {
      templateId: "compact",
      templateVersionId: "compact:v1",
      templateVersionNumber: 1,
      templateName: "Compact",
      templateHash: "hash-compact",
      assignmentSource: "job_override",
    },
    snapshot: null,
    state,
    reason: null,
    lastRefreshAttempt: null,
  };
}
