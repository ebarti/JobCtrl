import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeJobDetail, sampleJob } from "../../test/fixtures/projections.js";
import { JobOverview } from "./JobOverview.js";

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
      screen.getByText(
        "Acme Corp · posting: greenhouse:acme · discovered via: jobspy:linkedin",
      ),
    ).toBeInTheDocument();
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
    const { container } = render(<JobOverview detail={detail} />);

    expect(container.querySelector(".job-overview-location")).toBeNull();
    expect(container).not.toHaveTextContent("- · -");
  });
});
