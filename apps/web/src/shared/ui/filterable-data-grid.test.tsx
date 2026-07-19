import { fireEvent, render, screen, within } from "@testing-library/react";
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

const resizableColumns: Array<DataGridColumn<TestRow>> = [
  { ...columns[0]!, width: 200, minWidth: 120 },
  { ...columns[1]!, width: 180, minWidth: 120 },
  { ...columns[2]!, width: 120, minWidth: 80 },
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

function createDragTransfer() {
  const values = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "none",
    getData: (type: string) => values.get(type) ?? "",
    setData: (type: string, value: string) => values.set(type, value),
  };
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
    expect(openAcme).toHaveClass("row-activation-focus-only");
    expect(openAcme).not.toHaveClass("sr-only", "focus:not-sr-only");
    expect(openAcme).toHaveTextContent("View details");

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

  it("can opt into persistent activation copy without removing keyboard access", () => {
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
        onRowActivate={() => {}}
        rowActivationLabel={(row) => `Open ${row.company}`}
        rowActivationAppearance="visible"
      />,
    );

    const openAcme = screen.getByRole("button", { name: "Open Acme" });
    expect(openAcme).not.toHaveClass("row-activation-focus-only");
    expect(openAcme).toHaveTextContent("View details");
    expect(openAcme).toHaveAttribute("type", "button");
    expect(openAcme).not.toHaveAttribute("tabindex", "-1");
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

    await user.click(screen.getByRole("button", { name: "Next" }));
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

  it("reflows records with labeled cells and keeps mobile sort and filter controls operable", async () => {
    render(
      <FilterableDataGrid
        title="Responsive grid"
        data={rows}
        columns={columns}
        getRowId={(row) => row.id}
        loading={false}
        loadingMessage="Loading rows."
        emptyMessage="No rows."
        initialSort={{ columnId: "company", direction: "asc" }}
        mobileLayout="cards"
      />,
    );
    const user = userEvent.setup();
    const table = screen.getByRole("table", { name: "Responsive grid" });
    const grid = table.closest(".filterable-data-grid");
    const acmeRow = within(table).getByRole("row", {
      name: /Acme Workday ATS 3/i,
    });

    expect(grid).toHaveAttribute("data-mobile-layout", "cards");
    expect(within(acmeRow).getByRole("rowheader")).toHaveAttribute(
      "data-label",
      "Company",
    );
    const providerCell = within(acmeRow).getByText("Workday ATS").closest("td");
    const providerHeader = within(table).getByRole("columnheader", {
      name: /Provider/i,
    });
    expect(providerCell).toHaveAttribute("data-label", "Provider");
    expect(providerCell).toHaveAttribute("headers", providerHeader.id);

    await user.click(screen.getByText("Sort and filter columns"));
    const controls = screen.getByRole("group", {
      name: "Responsive grid column controls",
    });
    await user.click(
      within(controls).getByRole("button", { name: /sort by observed/i }),
    );
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent(
      "Salesforce",
    );

    await user.click(
      within(controls).getByRole("button", {
        name: /filter company column/i,
      }),
    );
    await user.type(screen.getByLabelText("Company filter text"), "board");
    expect(within(table).getByText("BoardCo")).toBeInTheDocument();
    expect(within(table).queryByText("Acme")).not.toBeInTheDocument();
  });

  it("supports task-specific mobile rows without replacing the desktop table fallback", async () => {
    const onRowActivate = vi.fn();
    render(
      <FilterableDataGrid
        title="Responsive grid"
        data={rows}
        columns={columns}
        getRowId={(row) => row.id}
        loading={false}
        loadingMessage="Loading rows."
        emptyMessage="No rows."
        initialSort={{ columnId: "company", direction: "asc" }}
        mobileListLabel="Company results"
        onRowActivate={onRowActivate}
        rowActivationLabel={(row) => `Open ${row.company}`}
        renderMobileRow={(row, context) => (
          <article data-row-index={context.rowIndex}>
            <strong>{row.company}</strong>
            <span>{row.observed} sightings</span>
          </article>
        )}
      />,
    );
    const user = userEvent.setup();
    const grid = document.querySelector(".filterable-data-grid");
    const table = screen.getByRole("table", { name: "Responsive grid" });
    const list = screen.getByRole("list", { name: "Company results" });
    const acmeRecord = within(list)
      .getAllByRole("listitem")
      .find((item) => item.dataset["rowId"] === "1");

    expect(grid).toHaveAttribute("data-mobile-rows", "custom");
    expect(within(table).getByText("Acme")).toBeInTheDocument();
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(acmeRecord).toBeDefined();
    if (!acmeRecord) throw new Error("Expected the Acme mobile record.");
    expect(acmeRecord.querySelector("article")).toHaveAttribute(
      "data-row-index",
      "0",
    );

    await user.click(within(acmeRecord).getByText("3 sightings"));
    expect(onRowActivate).toHaveBeenLastCalledWith(rows[0]);

    await user.click(
      within(acmeRecord).getByRole("button", { name: "Open Acme" }),
    );
    expect(onRowActivate).toHaveBeenCalledTimes(2);
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
    await user.click(screen.getByRole("combobox", { name: "Page size" }));
    await user.click(await screen.findByRole("option", { name: "1/page" }));
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.queryByText("Salesforce")).not.toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(onPageRowsChange).toHaveBeenLastCalledWith([rows[0]]);
  });

  it("resizes columns from header handles with keyboard and pointer input", async () => {
    render(
      <FilterableDataGrid
        title="Grid view"
        data={rows}
        columns={resizableColumns}
        getRowId={(row) => row.id}
        loading={false}
        loadingMessage="Loading rows."
        emptyMessage="No rows."
        initialSort={{ columnId: "company", direction: "asc" }}
      />,
    );
    const user = userEvent.setup();
    const companyHandle = screen.getByRole("button", {
      name: "Resize Company column",
    });
    const companyCol = document.querySelector<HTMLTableColElement>(
      'col[data-column-id="company"]',
    );

    expect(companyCol).toHaveStyle({ width: "200px" });

    companyHandle.focus();
    await user.keyboard("{ArrowRight}");
    expect(companyCol).toHaveStyle({ width: "216px" });

    fireEvent(
      companyHandle,
      new MouseEvent("pointerdown", { bubbles: true, clientX: 100 }),
    );
    fireEvent(window, new MouseEvent("pointermove", { clientX: 160 }));
    fireEvent(window, new MouseEvent("pointerup"));

    expect(companyCol).toHaveStyle({ width: "276px" });
  });

  it("applies controlled column order, visibility, widths, and density", async () => {
    const onColumnWidthsChange = vi.fn();
    render(
      <FilterableDataGrid
        title="Grid view"
        data={rows}
        columns={resizableColumns}
        getRowId={(row) => row.id}
        loading={false}
        loadingMessage="Loading rows."
        emptyMessage="No rows."
        initialSort={{ columnId: "company", direction: "asc" }}
        columnOrder={["observed", "company", "provider"]}
        columnVisibility={{ provider: false }}
        columnWidths={{ observed: 160 }}
        onColumnWidthsChange={onColumnWidthsChange}
        density="compact"
      />,
    );
    const user = userEvent.setup();
    const headers = screen.getAllByRole("columnheader");

    expect(headers.map((header) => header.textContent)).toEqual([
      expect.stringContaining("Observed"),
      expect.stringContaining("Company"),
    ]);
    expect(screen.queryByText("Provider")).not.toBeInTheDocument();
    expect(document.querySelector(".filterable-data-grid")).toHaveAttribute(
      "data-density",
      "compact",
    );
    expect(
      document.querySelector<HTMLTableColElement>(
        'col[data-column-id="observed"]',
      ),
    ).toHaveStyle({ width: "160px" });

    await user.keyboard("{Tab}");
    await user.click(
      screen.getByRole("button", { name: "Resize Observed column" }),
    );
    screen.getByRole("button", { name: "Resize Observed column" }).focus();
    await user.keyboard("{ArrowRight}");

    expect(onColumnWidthsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ observed: 176 }),
    );
  });

  it("reorders visible columns from accessible grips without dropping hidden columns", async () => {
    const onColumnOrderChange = vi.fn();
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
        columnOrder={["company", "provider", "observed"]}
        columnVisibility={{ provider: false }}
        onColumnOrderChange={onColumnOrderChange}
      />,
    );
    const user = userEvent.setup();
    const observedHandle = screen.getByRole("button", {
      name: "Reorder Observed column",
    });
    const companyHeader = screen.getByRole("columnheader", {
      name: /Company/i,
    });
    const transfer = createDragTransfer();

    expect(observedHandle).toHaveAccessibleDescription(
      /left and right arrow keys.*Columns dialog/i,
    );
    expect(
      screen.queryByRole("button", { name: "Reorder Provider column" }),
    ).not.toBeInTheDocument();

    fireEvent.dragStart(observedHandle, { dataTransfer: transfer });
    fireEvent.dragOver(companyHeader, { clientX: 0, dataTransfer: transfer });
    fireEvent.drop(companyHeader, { clientX: 0, dataTransfer: transfer });

    expect(onColumnOrderChange).toHaveBeenLastCalledWith([
      "observed",
      "company",
      "provider",
    ]);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Observed moved before Company.",
    );

    screen.getByRole("button", { name: "Reorder Company column" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onColumnOrderChange).toHaveBeenLastCalledWith([
      "provider",
      "observed",
      "company",
    ]);
  });

  it("groups page rows and applies semantic color-rule classes", () => {
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
        grouping={{ columnId: "provider" }}
        colorRules={[
          {
            columnId: "company",
            predicate: { op: "contains", value: "Acme" },
            tone: "success",
          },
          {
            columnId: "observed",
            predicate: { op: "gte", value: 8 },
            tone: "warning",
          },
        ]}
      />,
    );

    expect(screen.getByRole("row", { name: /Workday ATS 2/i })).toHaveClass(
      "data-grid-group-row",
    );
    expect(screen.getByRole("row", { name: /JobSpy board 1/i })).toHaveClass(
      "data-grid-group-row",
    );
    const acmeRow = screen.getByRole("row", { name: /Acme Workday ATS 3/i });
    expect(acmeRow).toHaveClass("data-grid-row-tone-success");
    expect(within(acmeRow).getByRole("rowheader")).toHaveClass(
      "data-grid-cell-tone-success",
    );
    const boardRow = screen.getByRole("row", {
      name: /BoardCo JobSpy board 8/i,
    });
    expect(boardRow).toHaveClass("data-grid-row-tone-warning");
    expect(within(boardRow).getByText("8").closest("td")).toHaveClass(
      "data-grid-cell-tone-warning",
    );
  });

  it("keeps dense grid focus indicators tied to the standard ring token", () => {
    const css = readFileSync("src/styles/globals.css", "utf8");
    const redesignCss = readFileSync("src/styles/redesign-data.css", "utf8");

    expect(css).toMatch(/:focus-visible\s*\{[^}]*--ring/s);
    expect(css).toMatch(
      /\.data-grid-row-activation-button:focus-visible,[\s\S]*?\.table-row-activation-button:focus-visible\s*\{[^}]*--ring/s,
    );
    expect(css).toMatch(
      /\.data-grid-column-filter-button:focus-visible\s*\{[^}]*--ring/s,
    );
    expect(css).toMatch(
      /\.data-grid-column-resizer:focus-visible\s*\{[^}]*--ring/s,
    );
    expect(redesignCss).toMatch(
      /\.data-grid-column-reorder-handle:focus-visible\s*\{[^}]*--ring/s,
    );

    const quietTableStatuses = redesignCss.slice(
      redesignCss.indexOf(".filterable-data-grid-table .stage-pill,"),
      redesignCss.indexOf(".filterable-data-grid-table .stage-pill::before"),
    );
    expect(quietTableStatuses).toContain(
      ".filterable-data-grid-table .stage-pill",
    );
    expect(quietTableStatuses).toContain("border: 0");
    expect(quietTableStatuses).toContain("border-radius: 0");
    expect(quietTableStatuses).toContain("background: transparent");
    expect(quietTableStatuses).toContain("box-shadow: none");
  });

  it("defines two-column tablet and one-column mobile record reflow", () => {
    const css = readFileSync("src/styles/redesign-data.css", "utf8");
    const responsiveRules = css.slice(css.indexOf("Dense records reflow"));

    expect(css).toMatch(
      /\.filterable-data-grid-table thead th\s*\{[^}]*font-size: var\(--jh-type-label-size\)/s,
    );
    expect(css).toMatch(
      /\.responsive-record-table thead th\s*\{[^}]*font-size: var\(--jh-type-label-size\)/s,
    );
    expect(responsiveRules).toMatch(/@media \(max-width: 900px\)/);
    expect(responsiveRules).toMatch(
      /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/,
    );
    expect(responsiveRules).toMatch(/width: 100% !important/);
    expect(responsiveRules).toMatch(/overflow-x: clip/);
    expect(responsiveRules).toMatch(/@media \(max-width: 560px\)/);
    expect(responsiveRules).toContain(".responsive-record-table");
  });
});
