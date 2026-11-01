import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ScoreProfileFreshness } from "@jobctrl/contracts";
import { ScoreProfileFreshnessBadge } from "./ScoreProfileFreshnessBadge.js";

const updated: ScoreProfileFreshness = { status: "profile_updated", scoredProfileVersion: 1, currentProfileVersion: 2, review: null };
describe("score profile freshness", () => {
  it.each(["current", "not_scored"] as const)("does not warn for %s", status => {
    const { container } = render(<ScoreProfileFreshnessBadge freshness={{ ...updated, status }} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("shows a saved profile edit and explains that the score is retained until explicit review", () => {
    render(<ScoreProfileFreshnessBadge freshness={updated} />);
    expect(screen.getByText("Profile updated since scoring")).toHaveAttribute("title", expect.stringContaining("Score used profile v1; saved profile is v2"));
  });
  it("keeps unknown score provenance visible", () => {
    render(<ScoreProfileFreshnessBadge freshness={{ ...updated, status: "unknown", scoredProfileVersion: null }} />);
    expect(screen.getByText("Score profile version unknown")).toBeInTheDocument();
  });
  it("shows the model's no-change decision without calling the score freshly computed", () => {
    render(<ScoreProfileFreshnessBadge freshness={{ ...updated, status: "reviewed_unchanged", review: {
      determinationId: "review", verdict: "insignificant", rationale: "Explicit model rationale.", provider: "synthetic", model: "model", reasoningEffort: "max", reviewedAt: "2026-10-23" } }} />);
    expect(screen.getByText("Profile changes checked · score retained")).toHaveAttribute("title", "Explicit model rationale.");
  });
});
