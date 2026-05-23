import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  FilterableDataGrid,
  type DataGridColumn,
} from "./filterable-data-grid.js";

interface TestRow {
  id: string;
  company: string;
  provider: string;
  observed: number;
}

const rows: TestRow[] = [
  { id: "1", company: "Acme", provider: "Workday ATS", observed: 3 },
  { id: "2", company: "BoardCo", provider: "JobSpy board", observed: 8 },
  { id: "3", company: "Salesforce", provider: "Workday ATS", observed: 1 },
];

const columns: Array<DataGridColumn<TestRow>> = [
  {
    id: "company",
    label: "Company",
    rowHeader: true,
    render: (row) => row.company,
    getSortValue: (row) => row.company,
    getFilterValue: (row) => row.company,
  },
  {
    id: "provider",
    label: "Provider",
    render: (row) => row.provider,
    getSortValue: (row) => row.provider,
    getFilterValue: (row) => row.provider,
  },
  {
    id: "observed",
    label: "Observed",
    render: (row) => row.observed,
    getSortValue: (row) => row.observed,
  },
];

function renderGrid() {
  render(
    <FilterableDataGrid
      title="Grid view"
      data={rows}
      columns={columns}
      getRowId={(row) => row.id}
      loading={false}
      loadingMessage="Loading rows."
      emptyMessage="No rows."
      initialSort={{ columnId: "company", direction: "asc" }}
    />,
  );
}

describe("FilterableDataGrid", () => {
  it("combines text predicates, multi-select values, and sortable columns", async () => {
    renderGrid();
    const user = userEvent.setup();

    await user.click(
      screen.getByRole("button", { name: /open table filters/i }),
    );
    await user.type(screen.getByLabelText("Company filter text"), "ac");

    const table = screen.getByRole("table");
    expect(within(table).getByText("Acme")).toBeInTheDocument();
    expect(within(table).queryByText("BoardCo")).not.toBeInTheDocument();

    const companyOperator = screen.getByRole("group", {
      name: "Company text operator",
    });
    await user.click(
      within(companyOperator).getByRole("button", {
        name: "does not contain",
      }),
    );

    expect(within(table).queryByText("Acme")).not.toBeInTheDocument();
    expect(within(table).getByText("BoardCo")).toBeInTheDocument();

    await user.click(
      within(screen.getByLabelText("Active table filters")).getByRole(
        "button",
        { name: /Company/i },
      ),
    );
    await user.click(
      screen.getByRole("button", { name: /open table filters/i }),
    );
    await user.click(screen.getByRole("checkbox", { name: "Workday ATS" }));

    expect(within(table).getByText("Acme")).toBeInTheDocument();
    expect(within(table).getByText("Salesforce")).toBeInTheDocument();
    expect(within(table).queryByText("BoardCo")).not.toBeInTheDocument();

    await user.click(
      within(screen.getByLabelText("Active table filters")).getByRole(
        "button",
        { name: /Provider/i },
      ),
    );
    await user.click(screen.getByRole("button", { name: /Observed/i }));
    await user.click(screen.getByRole("button", { name: /Observed/i }));

    const tableRows = screen.getAllByRole("row");
    expect(within(tableRows[1]!).getByText("BoardCo")).toBeInTheDocument();
  });
});
