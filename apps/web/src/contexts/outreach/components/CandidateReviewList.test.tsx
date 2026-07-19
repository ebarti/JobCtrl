import { describe, expect, it } from "vitest";

import {
  makeResearchTaskDetail,
  sampleResearchTaskDetail,
} from "../../../test/fixtures/contact-research.js";
import { renderWithProviders } from "../../../test/render.js";
import { CandidateReviewList } from "./CandidateReviewList.js";

describe("<CandidateReviewList>", () => {
  it("renders each candidate's provenance and the source-attempt outcomes (INV-2)", () => {
    const view = renderWithProviders(<CandidateReviewList task={sampleResearchTaskDetail} />);
    // Appears in the card head and as the "name" attribute fact.
    expect(view.getAllByText("Dana Hiring-Manager").length).toBeGreaterThan(0);
    // Candidate + attribute provenance is inspectable.
    expect(view.getAllByText("Public web page").length).toBeGreaterThan(0);
    expect(view.getAllByText("llm_assisted").length).toBeGreaterThan(0);
    // Source-attempt outcomes (the search audit) are shown, including the
    // manual-capture fallback recorded as a first-class outcome.
    expect(view.getByText("Manual capture required")).toBeInTheDocument();
    expect(view.getByText("Needs review")).toHaveAttribute(
      "data-status-tone",
      "warn",
    );
  });

  it("offers an explicit Confirm action for a needs_review candidate (INV-4)", () => {
    const view = renderWithProviders(<CandidateReviewList task={sampleResearchTaskDetail} />);
    expect(view.getByRole("button", { name: /confirm contact/i })).toBeInTheDocument();
  });

  it("shows a confirmed note and no confirm action once a candidate is confirmed", () => {
    const confirmed = makeResearchTaskDetail({
      status: "completed",
      needsReviewCount: 0,
      confirmedCount: 1,
      candidates: [
        {
          ...sampleResearchTaskDetail.candidates[0]!,
          status: "confirmed",
          confirmedContactId: "contact-1",
          confirmedAt: "2026-07-06T00:01:00+00:00",
        },
      ],
    });
    const view = renderWithProviders(<CandidateReviewList task={confirmed} />);
    expect(view.getByText("Completed")).toHaveAttribute(
      "data-status-tone",
      "ok",
    );
    expect(view.getByText(/confirmed into your contacts/i)).toBeInTheDocument();
    expect(view.queryByRole("button", { name: /confirm contact/i })).toBeNull();
  });
});
