import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeJobDetail, sampleJob } from "../../test/fixtures/projections.js";
import { JobOverview } from "./JobOverview.js";

describe("<JobOverview>", () => {
  it("shows separate labelled job metadata without flattening fields into prose", () => {
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

    const metadata = screen.getByLabelText("Job metadata");
    expect(within(metadata).getByText("Company")).toBeInTheDocument();
    expect(within(metadata).getByText("Acme Corp")).toBeInTheDocument();
    expect(within(metadata).getByText("Posting")).toBeInTheDocument();
    expect(within(metadata).getByText("greenhouse:acme")).toBeInTheDocument();
    expect(within(metadata).getByText("Discovered via")).toBeInTheDocument();
    expect(within(metadata).getByText("jobspy:linkedin")).toBeInTheDocument();
    expect(
      within(metadata).getByRole("link", { name: "Open original posting" }),
    ).toHaveAttribute("href", sampleJob.url);
    expect(metadata).not.toHaveTextContent(" · ");
    expect(
      screen.getByRole("heading", { level: 1, name: sampleJob.title }),
    ).toBeInTheDocument();
  });

  it("omits empty location and salary metadata instead of rendering placeholder dashes", () => {
    const detail = makeJobDetail({
      ...sampleJob,
      location: "",
      salary: "",
    });
    render(<JobOverview detail={detail} />);

    const metadata = screen.getByLabelText("Job metadata");
    expect(within(metadata).queryByText("Location")).not.toBeInTheDocument();
    expect(within(metadata).queryByText("Salary")).not.toBeInTheDocument();
  });
});
