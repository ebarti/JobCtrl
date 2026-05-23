import type { RowSelectionState, SortingState } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { JobSummary } from "../../contexts/operations/types.js";
import { makeJobsPage, sampleJob } from "../../test/fixtures/projections.js";
import { JobsTable } from "./JobsTable.js";

function renderJobsTable(jobs: readonly JobSummary[] = [
  {
    ...sampleJob,
    company: "Acme Corp",
    source: "LinkedIn",
    discoverySource: "jobspy:linkedin",
    postingSource: "greenhouse:acme",
    postingSourceUrl: "https://boards.greenhouse.io/acme/jobs/123",
  },
]) {
  const sorting: SortingState = [{ id: "discovered_at", desc: true }];
  const rowSelection: RowSelectionState = {};
  return render(
    <JobsTable
      data={makeJobsPage(jobs)}
      loading={false}
      sorting={sorting}
      onSortingChange={() => {}}
      rowSelection={rowSelection}
      onRowSelectionChange={() => {}}
      allMatchingSelected={false}
      page={1}
      pageSize={50}
      onPageChange={() => {}}
      onPageSizeChange={() => {}}
      onOpenJob={() => {}}
    />,
  );
}

describe("<JobsTable>", () => {
  it("renders source as its own column instead of folding it into company", () => {
    renderJobsTable();

    expect(screen.getByText("Company")).toBeInTheDocument();
    expect(screen.getByText("Sources")).toBeInTheDocument();
    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    expect(screen.getByText("posting greenhouse:acme")).toBeInTheDocument();
    expect(screen.getByText("discovered via jobspy:linkedin")).toBeInTheDocument();
    expect(screen.queryByText(/Acme Corp.*LinkedIn/)).not.toBeInTheDocument();
  });

  it("does not label a broad discovery board as the posting owner", () => {
    renderJobsTable([
      {
        ...sampleJob,
        source: "LinkedIn",
        discoverySource: "jobspy:linkedin",
        postingSource: "",
        postingSourceUrl: null,
      },
    ]);

    expect(screen.queryByText("posting LinkedIn")).not.toBeInTheDocument();
    expect(screen.getByText("discovered via jobspy:linkedin")).toBeInTheDocument();
  });
});
