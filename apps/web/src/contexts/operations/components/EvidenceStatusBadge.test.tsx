import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EvidenceStatusBadge, type EvidenceStatusBadgeProps } from "./EvidenceStatusBadge.js";

describe("<EvidenceStatusBadge>", () => {
  it.each([
    [{ type: "fit", value: "matched" }, "matched", "ok"],
    [{ type: "fit", value: "transferable" }, "transferable", "info"],
    [{ type: "fit", value: "missing" }, "missing", "danger"],
    [{ type: "fit", value: "blocked" }, "blocked", "danger"],
    [{ type: "fit", value: "not_assessed" }, "not assessed", "muted"],
    [{ type: "fit", value: null }, "not assessed", "muted"],
    [{ type: "coverage", value: "covered" }, "covered", "ok"],
    [{ type: "coverage", value: "declared" }, "declared", "info"],
    [{ type: "coverage", value: "missing_from_profile" }, "missing from profile", "danger"],
    [{ type: "coverage", value: "missing_from_resume" }, "missing from resume", "danger"],
    [{ type: "coverage", value: "not_covered" }, "not covered", "danger"],
    [{ type: "coverage", value: "not_recorded" }, "not recorded", "muted"],
    [{ type: "strength", value: "verified" }, "verified", "ok"],
    [{ type: "strength", value: "supported" }, "supported", "info"],
    [{ type: "strength", value: "inferred" }, "inferred", "warn"],
    [{ type: "strength", value: "draft" }, "draft", "muted"],
    [{ type: "strength", value: null }, "unrated", "muted"],
    [{ type: "confirmation", value: true }, "confirmed", "ok"],
    [{ type: "confirmation", value: false }, "unconfirmed", "warn"],
    [{ type: "gap", value: "missing_requirement" }, "Missing requirement", "danger"],
    [{ type: "gap", value: "blocked_requirement" }, "Blocked requirement", "danger"],
    [{ type: "gap", value: "transferable_requirement" }, "Transferable requirement", "info"],
    [{ type: "gap", value: "missing_skill" }, "Missing skill", "danger"],
  ] as const)("maps %o to the %s label and %s tone", (status, label, tone) => {
    render(<EvidenceStatusBadge {...(status as EvidenceStatusBadgeProps)} />);

    const badge = screen.getByText(label);
    expect(badge).toHaveAttribute("data-slot", "status-badge");
    expect(badge).toHaveAttribute("data-status-tone", tone);
  });
});
