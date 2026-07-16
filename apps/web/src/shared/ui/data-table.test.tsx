import type { ColumnDef, RowSelectionState, SortingState } from "@tanstack/react-table";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DataTable } from "./data-table.js";

interface TestRow {
  id: string;
  company: string;
  role: string;
  fit: number;
}

const rows: TestRow[] = [
  { id: "row-1", company: "Acme Studio", role: "Design Systems Engineer", fit: 8 },
  { id: "row-2", company: "Bright Labs", role: "Frontend Platform Lead", fit: 9 },
];

const columns: Array<ColumnDef<TestRow>> = [
  {
    accessorKey: "company",
    header: "Company",
    cell: ({ row }) => row.original.company,
  },
  {
    accessorKey: "role",
    header: "Role",
    cell: ({ row }) => row.original.role,
  },
  {
    accessorKey: "fit",
    header: "Fit",
    cell: ({ row }) => row.original.fit,
    enableSorting: true,
  },
];

function renderTable({
  data = rows,
  loaded = true,
  loading = false,
  onRowActivate,
  onSortingChange = vi.fn(),
  rowSelection = {},
  sorting = [],
}: {
  data?: TestRow[];
  loaded?: boolean;
  loading?: boolean;
  onRowActivate?: (row: TestRow) => void;
  onSortingChange?: (next: SortingState) => void;
  rowSelection?: RowSelectionState;
  sorting?: SortingState;
} = {}) {
  return {
    onSortingChange,
    ...render(
      <DataTable<TestRow>
        data={data}
        columns={columns}
        getRowId={(row) => row.id}
        loading={loading}
        loaded={loaded}
        loadingMessage="Loading table rows."
        emptyMessage="No matching rows."
        rowClassName="row"
        headerClassName="head"
        sorting={sorting}
        onSortingChange={onSortingChange}
        rowSelection={rowSelection}
        onRowSelectionChange={vi.fn()}
        rowAriaSelected={(row) => row.id === "row-2"}
        rowActivationLabel={(row) => `Open ${row.company}`}
        {...(onRowActivate ? { onRowActivate } : {})}
      />,
    ),
  };
}

describe("DataTable", () => {
  it("exposes semantic table, row, columnheader, and sorted header surfaces", async () => {
    const user = userEvent.setup();
    const onSortingChange = vi.fn();
    renderTable({
      onSortingChange,
      sorting: [{ id: "fit", desc: false }],
    });

    const table = screen.getByRole("table");
    const tableRows = within(table).getAllByRole("row");
    expect(tableRows).toHaveLength(3);

    const headers = within(tableRows[0]!).getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual(["Company", "Role", "Fit ↑"]);
    expect(headers[2]).toHaveAttribute("aria-sort", "ascending");
    expect(within(headers[2]!).getByRole("button", { name: "Fit" })).not.toHaveAttribute(
      "aria-sort",
    );

    await user.click(within(headers[2]!).getByRole("button", { name: "Fit" }));
    expect(onSortingChange).toHaveBeenCalledWith([{ id: "fit", desc: true }]);
  });

  it("keeps activatable data rows as rows while exposing named button activation", async () => {
    const user = userEvent.setup();
    const onRowActivate = vi.fn();
    renderTable({ onRowActivate });

    const table = screen.getByRole("table");
    const dataRows = within(table).getAllByRole("row").slice(1);
    expect(dataRows).toHaveLength(2);
    expect(dataRows[0]).not.toHaveAttribute("tabindex");

    const openAcme = within(dataRows[0]!).getByRole("button", {
      name: "Open Acme Studio",
    });
    expect(openAcme).toHaveClass("sr-only", "focus:not-sr-only");
    await user.click(openAcme);
    openAcme.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(onRowActivate).toHaveBeenCalledTimes(3);
    expect(onRowActivate).toHaveBeenNthCalledWith(1, rows[0]);
    expect(dataRows[1]).toHaveAttribute("aria-selected", "true");
  });

  it("keeps loading, empty, selection, and controlled sorting behavior visible", async () => {
    const user = userEvent.setup();
    const { rerender, onSortingChange } = renderTable({
      data: [],
      loaded: false,
      loading: true,
    });

    expect(screen.getByText("Loading table rows.")).toBeInTheDocument();

    rerender(
      <DataTable<TestRow>
        data={[]}
        columns={columns}
        getRowId={(row) => row.id}
        loading={false}
        loaded={true}
        loadingMessage="Loading table rows."
        emptyMessage="No matching rows."
        rowClassName="row"
        headerClassName="head"
        sorting={[]}
        onSortingChange={onSortingChange}
        rowSelection={{}}
        onRowSelectionChange={vi.fn()}
      />,
    );

    expect(screen.getByText("No matching rows.")).toBeInTheDocument();

    rerender(
      <DataTable<TestRow>
        data={rows}
        columns={columns}
        getRowId={(row) => row.id}
        loading={false}
        loaded={true}
        loadingMessage="Loading table rows."
        emptyMessage="No matching rows."
        rowClassName="row"
        headerClassName="head"
        sorting={[]}
        onSortingChange={onSortingChange}
        rowSelection={{ "row-1": true }}
        onRowSelectionChange={vi.fn()}
        rowActivationLabel={(row) => `Open ${row.company}`}
      />,
    );

    expect(within(screen.getByRole("table")).getAllByRole("row")[1]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Fit" }));
    expect(onSortingChange).toHaveBeenCalledWith([{ id: "fit", desc: true }]);
  });
});
