import type { OutreachDraftStatus } from "@jobctrl/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DraftStatusBadge } from "./DraftStatusBadge.js";

const STATUS_EXPECTATIONS: Record<
  OutreachDraftStatus,
  { label: string; tone: string }
> = {
  candidate: { label: "Under review", tone: "info" },
  approved: { label: "Approved", tone: "ok" },
  rejected: { label: "Rejected", tone: "danger" },
  superseded: { label: "Superseded", tone: "muted" },
};

describe("<DraftStatusBadge>", () => {
  it.each(
    Object.entries(STATUS_EXPECTATIONS) as [
      OutreachDraftStatus,
      { label: string; tone: string },
    ][],
  )("renders %s with its existing label and tone", (status, expected) => {
    render(<DraftStatusBadge status={status} />);

    const badge = screen.getByText(expected.label);
    expect(badge).toHaveAttribute("data-slot", "status-badge");
    expect(badge).toHaveAttribute("data-status-tone", expected.tone);
    expect(badge).toHaveAttribute("title", `Draft status: ${expected.label}`);
    expect(badge).toHaveClass(`outreach-draft-status-${status}`);
  });
});
