import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

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
  it("activates rows through named buttons while rows keep table semantics", async () => {
    const onRowActivate = vi.fn();
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
        onRowActivate={onRowActivate}
        rowActivationLabel={(row) => `Open ${row.company}`}
      />,
    );
    const user = userEvent.setup();
    const acmeRow = screen.getByRole("row", { name: /Acme Workday ATS 3/i });
    expect(acmeRow).not.toHaveAttribute("tabindex");
    const openAcme = within(acmeRow).getByRole("button", { name: "Open Acme" });

    await user.click(within(acmeRow).getByText("Workday ATS"));
    expect(onRowActivate).toHaveBeenLastCalledWith(rows[0]);

    await user.click(openAcme);
    expect(onRowActivate).toHaveBeenLastCalledWith(rows[0]);

    openAcme.focus();
    await user.keyboard("{Enter}");
    expect(onRowActivate).toHaveBeenLastCalledWith(rows[0]);

    await user.keyboard(" ");
    expect(onRowActivate).toHaveBeenLastCalledWith(rows[0]);

    await user.keyboard("{ArrowDown}");
    expect(onRowActivate).toHaveBeenCalledTimes(4);
  });

  it("paginates local rows after filtering and sorting", async () => {
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
        paginate
        initialPageSize={2}
        pageSizeOptions={[2, 3]}
      />,
    );
    const user = userEvent.setup();

    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("BoardCo")).toBeInTheDocument();
    expect(screen.queryByText("Salesforce")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "next" }));
    expect(screen.queryByText("Acme")).not.toBeInTheDocument();
    expect(screen.getByText("Salesforce")).toBeInTheDocument();
  });

  it("combines text predicates, multi-select values, and sortable columns", async () => {
    renderGrid();
    const user = userEvent.setup();
    const table = screen.getByRole("table");

    await user.click(
      screen.getByRole("button", { name: /filter company column/i }),
    );
    await user.type(screen.getByLabelText("Company filter text"), "ac");
    expect(
      document.querySelector('[aria-label="Filter Company column (active)"]'),
    ).not.toBeNull();

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

    await user.click(screen.getByRole("button", { name: /close/i }));
    await user.click(
      within(screen.getByLabelText("Active table filters")).getByRole(
        "button",
        { name: /Company/i },
      ),
    );
    await user.click(
      screen.getByRole("button", { name: /filter provider column/i }),
    );
    await user.click(screen.getByRole("checkbox", { name: "Workday ATS" }));

    expect(within(table).getByText("Acme")).toBeInTheDocument();
    expect(within(table).getByText("Salesforce")).toBeInTheDocument();
    expect(within(table).queryByText("BoardCo")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /close/i }));
    await user.click(
      within(screen.getByLabelText("Active table filters")).getByRole(
        "button",
        { name: /Provider/i },
      ),
    );
    await user.click(screen.getByRole("button", { name: /sort by observed/i }));
    await user.click(
      screen.getByRole("button", { name: /sort by observed \(ascending\)/i }),
    );

    const tableRows = screen.getAllByRole("row");
    expect(within(tableRows[1]!).getByText("BoardCo")).toBeInTheDocument();
  });

  it("clears the exact active filter chip without removing other filters", async () => {
    renderGrid();
    const user = userEvent.setup();
    const table = screen.getByRole("table");

    await user.click(
      screen.getByRole("button", { name: /filter company column/i }),
    );
    expect(
      screen.getByRole("dialog", { name: "Company filter" }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Company filter text"), "ac");
    await user.click(screen.getByRole("button", { name: /close/i }));

    await user.click(
      screen.getByRole("button", { name: /filter provider column/i }),
    );
    expect(
      screen.getByRole("dialog", { name: "Provider filter" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Workday ATS" }));
    await user.click(screen.getByRole("button", { name: /close/i }));

    const activeFilters = screen.getByLabelText("Active table filters");
    await user.click(
      within(activeFilters).getByRole("button", { name: /Company/i }),
    );

    expect(
      within(activeFilters).queryByRole("button", { name: /Company/i }),
    ).not.toBeInTheDocument();
    expect(
      within(activeFilters).getByRole("button", { name: /Provider/i }),
    ).toBeInTheDocument();
    expect(within(table).getByText("Acme")).toBeInTheDocument();
    expect(within(table).getByText("Salesforce")).toBeInTheDocument();
    expect(within(table).queryByText("BoardCo")).not.toBeInTheDocument();
  });

  it("reports page rows after filtering, sorting, and page size changes combine", async () => {
    const onPageRowsChange = vi.fn();
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
        paginate
        initialPageSize={3}
        pageSizeOptions={[1, 2, 3]}
        onPageRowsChange={onPageRowsChange}
      />,
    );
    const user = userEvent.setup();

    await user.click(
      screen.getByRole("button", { name: /filter provider column/i }),
    );
    await user.click(screen.getByRole("checkbox", { name: "Workday ATS" }));
    await user.click(screen.getByRole("button", { name: /close/i }));
    await user.click(screen.getByRole("button", { name: /sort by observed/i }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Page size" }),
      "1",
    );
    await user.click(screen.getByRole("button", { name: "next" }));

    expect(screen.queryByText("Salesforce")).not.toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(onPageRowsChange).toHaveBeenLastCalledWith([rows[0]]);
  });

  it("keeps dense grid focus indicators tied to the standard ring token", () => {
    const css = readFileSync("src/styles/globals.css", "utf8");

    expect(css).toMatch(/:focus-visible\s*\{[^}]*--ring/s);
    expect(css).toMatch(
      /\.data-grid-row-activation-button:focus-visible,[\s\S]*?\.table-row-activation-button:focus-visible\s*\{[^}]*--ring/s,
    );
    expect(css).toMatch(
      /\.data-grid-column-filter-button:focus-visible\s*\{[^}]*--ring/s,
    );
  });
});
