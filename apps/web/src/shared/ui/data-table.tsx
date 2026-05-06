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
    <div className="table">
      <div className={headerClassName} role="row">
        {table.getFlatHeaders().map((header) => {
          const sortDirection = header.column.getIsSorted();
          const headerClass = cellClassName?.(header.column.id);
          if (!header.column.getCanSort()) {
            return (
              <span key={header.id} className={headerClass ?? "table-head static"}>
                {flexRender(header.column.columnDef.header, header.getContext())}
              </span>
            );
          }
          return (
            <button
              key={header.id}
              type="button"
              aria-sort={
                sortDirection === "asc"
                  ? "ascending"
                  : sortDirection === "desc"
                    ? "descending"
                    : "none"
              }
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
          );
        })}
      </div>
      {loading && !loaded ? <Empty title={loadingMessage} /> : null}
      {table.getRowModel().rows.map((row) => {
        const ariaSelected = rowAriaSelected?.(row.original) ?? row.getIsSelected();
        return (
          <div
            key={row.id}
            role={onRowActivate ? "button" : "row"}
            tabIndex={onRowActivate ? 0 : undefined}
            className={rowClassName}
            aria-selected={ariaSelected}
            onClick={() => onRowActivate?.(row.original)}
            onKeyDown={(event) => {
              if (!onRowActivate) {
                return;
              }
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onRowActivate(row.original);
              }
            }}
          >
            {row.getVisibleCells().map((cell) => (
              <span key={cell.id} className={cellClassName?.(cell.column.id)}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </span>
            ))}
          </div>
        );
      })}
      {loaded && data.length === 0 ? <Empty title={emptyMessage} /> : null}
      {footer}
    </div>
  );
}
