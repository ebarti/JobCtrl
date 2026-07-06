import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { sampleResearchTaskDetail } from "../../../test/fixtures/contact-research.js";
import { renderWithProviders } from "../../../test/render.js";
import { CandidateReviewList } from "./CandidateReviewList.js";

describe("<CandidateReviewList> a11y", () => {
  it("renders candidate provenance + confirm action with no critical axe violations", async () => {
    const view = renderWithProviders(<CandidateReviewList task={sampleResearchTaskDetail} />);
    expect(view.getAllByText("Dana Hiring-Manager").length).toBeGreaterThan(0);
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
