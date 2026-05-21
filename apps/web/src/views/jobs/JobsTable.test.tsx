import type { RowSelectionState, SortingState } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeJobsPage, sampleJob } from "../../test/fixtures/projections.js";
import { JobsTable } from "./JobsTable.js";

function renderJobsTable() {
  const sorting: SortingState = [{ id: "discovered_at", desc: true }];
  const rowSelection: RowSelectionState = {};
  return render(
    <JobsTable
      data={makeJobsPage([{ ...sampleJob, company: "Acme Corp", source: "LinkedIn" }])}
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
    expect(screen.getByText("Source")).toBeInTheDocument();
    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    expect(screen.getByText("LinkedIn")).toBeInTheDocument();
    expect(screen.queryByText(/Acme Corp.*LinkedIn/)).not.toBeInTheDocument();
  });
});
