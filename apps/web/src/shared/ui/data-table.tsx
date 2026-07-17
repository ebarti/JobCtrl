import {
  flexRender,
  getCoreRowModel,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
  type Updater,
  useReactTable,
} from "@tanstack/react-table";
import type { ReactNode } from "react";

import { Empty } from "./empty.js";

export interface DataTableProps<TData> {
  data: readonly TData[];
  columns: ColumnDef<TData>[];
  getRowId: (row: TData) => string;
  loading: boolean;
  loaded: boolean;
  loadingMessage: string;
  emptyMessage: string;
  rowClassName: string;
  headerClassName: string;
  sorting: SortingState;
  onSortingChange: (next: SortingState) => void;
  rowSelection: RowSelectionState;
  onRowSelectionChange: (next: RowSelectionState) => void;
  enableRowSelection?: boolean;
  rowKeyAttribute?: (row: TData) => string;
  onRowActivate?: (row: TData) => void;
  rowActivationLabel?: (row: TData) => string;
  rowActivationAppearance?: "visible" | "focus-only";
  rowAriaSelected?: (row: TData) => boolean;
  cellClassName?: (columnId: string) => string | undefined;
  footer?: ReactNode;
}

export function DataTable<TData>({
  data,
  columns,
  getRowId,
  loading,
  loaded,
  loadingMessage,
  emptyMessage,
  rowClassName,
  headerClassName,
  sorting,
  onSortingChange,
  rowSelection,
  onRowSelectionChange,
  enableRowSelection = true,
  onRowActivate,
  rowActivationLabel,
  rowActivationAppearance = "focus-only",
  rowAriaSelected,
  cellClassName,
  footer,
}: DataTableProps<TData>) {
  const table = useReactTable<TData>({
    data: data as TData[],
    columns,
    state: { sorting, rowSelection },
    getRowId,
    enableRowSelection,
    enableMultiRowSelection: enableRowSelection,
    enableSortingRemoval: false,
    manualSorting: true,
    manualPagination: true,
    onSortingChange: (updater: Updater<SortingState>) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      onSortingChange(next);
    },
    onRowSelectionChange: (updater: Updater<RowSelectionState>) => {
      const next = typeof updater === "function" ? updater(rowSelection) : updater;
      onRowSelectionChange(next);
    },
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <>
      <div className="table data-table-surface" role="table">
        <div role="rowgroup">
          <div className={headerClassName} role="row">
            {table.getFlatHeaders().map((header) => {
              const sortDirection = header.column.getIsSorted();
              const headerClass = cellClassName?.(header.column.id);
              const ariaSort =
                sortDirection === "asc"
                  ? "ascending"
                  : sortDirection === "desc"
                    ? "descending"
                    : "none";
              if (!header.column.getCanSort()) {
                return (
                  <span
                    key={header.id}
                    className={headerClass ?? "table-head static"}
                    role="columnheader"
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </span>
                );
              }
              return (
                <span key={header.id} role="columnheader" aria-sort={ariaSort}>
                  <button
                    type="button"
                    className={
                      sortDirection
                        ? `${headerClass ?? "table-head"} active`.trim()
                        : (headerClass ?? "table-head")
                    }
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {sortDirection ? (
                      <span aria-hidden="true">{sortDirection === "asc" ? " ↑" : " ↓"}</span>
                    ) : null}
                  </button>
                </span>
              );
            })}
          </div>
        </div>
        <div role="rowgroup">
          {table.getRowModel().rows.map((row) => {
            const ariaSelected = rowAriaSelected?.(row.original) ?? row.getIsSelected();
            const activationLabel = rowActivationLabel?.(row.original) ?? `Open row ${row.id}`;
            return (
              <div
                key={row.id}
                role="row"
                className={
                  onRowActivate
                    ? `${rowClassName} table-row-activatable`.trim()
                    : rowClassName
                }
                aria-selected={ariaSelected}
              >
                {row.getVisibleCells().map((cell, cellIndex) => {
                  const isActivationCell = Boolean(onRowActivate) && cellIndex === 0;
                  return (
                    <span key={cell.id} className={cellClassName?.(cell.column.id)} role="cell">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      {isActivationCell ? (
                        <button
                          type="button"
                          className={
                            rowActivationAppearance === "focus-only"
                              ? "table-row-activation-button row-activation-focus-only"
                              : "table-row-activation-button"
                          }
                          aria-label={activationLabel}
                          onClick={(event) => {
                            event.stopPropagation();
                            onRowActivate?.(row.original);
                          }}
                        >
                          <span aria-hidden="true">View details</span>
                        </button>
                      ) : null}
                    </span>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {loading && !loaded ? <Empty title={loadingMessage} /> : null}
      {loaded && data.length === 0 ? <Empty title={emptyMessage} /> : null}
      {footer}
    </>
  );
}
