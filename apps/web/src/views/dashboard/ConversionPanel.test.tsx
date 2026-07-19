import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { DashboardSummary } from "../../contexts/operations/types.js";
import { sampleDashboardSummary } from "../../test/fixtures/projections.js";
import { ConversionPanel } from "./ConversionPanel.js";

const emptyConversion: DashboardSummary["conversion"] = {
  totals: {
    applied: 0,
    reply: 0,
    interview: 0,
    offer: 0,
    rejection: 0,
    replyRate: null,
    interviewRate: null,
    offerRate: null,
    rejectionRate: null,
    costPerInterview: null,
  },
  bySource: [],
  byBand: [],
};

describe("ConversionPanel", () => {
  it("renders the applied→reply→interview→offer funnel with rates relative to applied", () => {
    const { container } = render(<ConversionPanel summary={sampleDashboardSummary} />);

    expect(screen.getByRole("heading", { name: "Conversion" })).toBeInTheDocument();
    expect(screen.getByText("3 applied")).toBeInTheDocument();

    const stages = [...container.querySelectorAll(".conversion-stage")].map((el) => el.textContent);
    expect(stages).toEqual(["Applied3100%", "Reply267%", "Interview133%", "Offer00%"]);
    expect(container.querySelector(".conversion-stage-lbl")).toHaveAttribute("data-typography", "label");
    expect(container.querySelector(".conversion-stage-val span")).toHaveAttribute(
      "data-typography",
      "metadata",
    );
  });

  it("shows the rejection rate and reports a missing cost per interview honestly", () => {
    const { container } = render(<ConversionPanel summary={sampleDashboardSummary} />);

    expect(container.querySelector(".conversion-note")?.textContent).toBe(
      "1 rejected (33%) · Cost / interview: not available",
    );
  });

  it("renders per-source and per-band interview conversion", () => {
    const { container } = render(<ConversionPanel summary={sampleDashboardSummary} />);

    expect(screen.getByRole("heading", { name: "By source" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "By score band" })).toBeInTheDocument();
    expect(screen.getByText("greenhouse:acme")).toBeInTheDocument();
    expect(screen.getByText("strong")).toBeInTheDocument();

    const metrics = [...container.querySelectorAll(".conversion-row-metric")].map((el) => el.textContent);
    expect(metrics).toEqual(["33%interview", "33%interview"]);
    expect(container.querySelector(".conversion-row-metric b")).toHaveAttribute("data-typography", "metric");
    expect(container.querySelector(".conversion-row-metric span")).toHaveAttribute(
      "data-typography",
      "metadata",
    );
  });

  it("formats a populated cost per interview instead of fabricating when it is present", () => {
    const summary: DashboardSummary = {
      ...sampleDashboardSummary,
      conversion: {
        ...sampleDashboardSummary.conversion,
        totals: {
          ...sampleDashboardSummary.conversion.totals,
          costPerInterview: 42,
        },
      },
    };

    const { container } = render(<ConversionPanel summary={summary} />);

    expect(container.querySelector(".conversion-note")?.textContent).toContain("Cost / interview: 42");
    expect(container.querySelector(".conversion-note")?.textContent).not.toContain("not available");
  });

  it("keeps raw counts but shows no fabricated rate when the sample is too small", () => {
    const smallSample: DashboardSummary = {
      ...sampleDashboardSummary,
      conversion: {
        totals: {
          applied: 1,
          reply: 1,
          interview: 0,
          offer: 0,
          rejection: 0,
          replyRate: null,
          interviewRate: null,
          offerRate: null,
          rejectionRate: null,
          costPerInterview: null,
        },
        bySource: [],
        byBand: [],
      },
    };

    const { container } = render(<ConversionPanel summary={smallSample} />);

    // INVARIANT: one application + one reply shows the count but NEVER a 100% rate.
    const stages = [...container.querySelectorAll(".conversion-stage")].map((el) => el.textContent);
    expect(stages).toEqual(["Applied1100%", "Reply1n/a", "Interview0n/a", "Offer0n/a"]);
    expect(
      screen.getByText("Not enough applications yet for reliable conversion rates."),
    ).toBeInTheDocument();
  });

  it("shows an empty state when there are no applications yet", () => {
    const summary: DashboardSummary = {
      ...sampleDashboardSummary,
      conversion: emptyConversion,
    };

    render(<ConversionPanel summary={summary} />);

    expect(screen.getByText("Awaiting outcomes")).toBeInTheDocument();
    expect(screen.getByText("No application outcomes yet")).toBeInTheDocument();
    expect(screen.getByText(/Conversion rates appear after you apply/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review applied jobs" })).toHaveAttribute(
      "href",
      expect.stringContaining("applyStatus=applied"),
    );
    expect(screen.queryByRole("heading", { name: "By source" })).not.toBeInTheDocument();
  });
});
