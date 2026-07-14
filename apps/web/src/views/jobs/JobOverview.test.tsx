import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeJobDetail, sampleJob } from "../../test/fixtures/projections.js";
import { JobOverview, JobSummaryLedger } from "./JobOverview.js";

describe("<JobOverview>", () => {
  it("shows separate discovery and posting owner provenance", () => {
    render(
      <JobOverview
        detail={makeJobDetail({
          ...sampleJob,
          company: "Acme Corp",
          discoverySource: "jobspy:linkedin",
          postingSource: "greenhouse:acme",
          postingSourceUrl: "https://boards.greenhouse.io/acme/jobs/123",
        })}
      />,
    );

    expect(
      screen.getByText("Acme Corp · posting: greenhouse:acme · discovered via: jobspy:linkedin"),
    ).toBeInTheDocument();
  });

  it("keeps fit, readiness, compensation, and stage in the summary ledger", () => {
    render(
      <JobSummaryLedger
        detail={makeJobDetail({
          ...sampleJob,
          fitScore: 8,
          salary: "EUR 110,000-140,000/year",
          currentStage: "discover",
          currentSubstage: "enrich",
          postingSource: "greenhouse:acme",
        })}
      />,
    );

    expect(screen.getByText("Fit")).toBeInTheDocument();
    expect(screen.getByText("8/10")).toBeInTheDocument();
    expect(screen.getByText("Readiness")).toBeInTheDocument();
    expect(screen.getByText("Compensation")).toBeInTheDocument();
    expect(screen.getByText("EUR 110,000-140,000/year")).toBeInTheDocument();
    expect(screen.getByText("Current stage")).toBeInTheDocument();
    expect(screen.getByText("enrich")).toBeInTheDocument();
    expect(screen.getByText("via greenhouse:acme")).toBeInTheDocument();
  });
});
