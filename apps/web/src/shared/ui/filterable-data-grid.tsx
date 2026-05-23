import { Filter, SortAsc, SortDesc, TableProperties, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { Button } from "./button.js";
import { Empty } from "./empty.js";
import { Input } from "./input.js";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js";

export type DataGridSortDirection = "asc" | "desc";
export type DataGridTextOperator = "contains" | "does_not_contain";

export interface DataGridTextFilter {
  operator: DataGridTextOperator;
  text: string;
  selectedValues: string[];
}

export type DataGridFilterState = Record<
  string,
  DataGridTextFilter | undefined
>;

export interface DataGridColumn<TData> {
  id: string;
  label: string;
  render: (row: TData) => ReactNode;
  getSortValue?: (row: TData) => string | number;
  getFilterValue?: (row: TData) => string;
  getFilterSearchValue?: (row: TData) => string;
  className?: string;
  headerClassName?: string;
  filterValueLimit?: number;
  rowHeader?: boolean;
}

export interface DataGridSortState {
  columnId: string;
  direction: DataGridSortDirection;
}

export interface FilterableDataGridProps<TData> {
  title: string;
  data: readonly TData[];
  columns: Array<DataGridColumn<TData>>;
  getRowId: (row: TData) => string;
  loading: boolean;
  loadingMessage: string;
  emptyMessage: string;
  initialSort: DataGridSortState;
  initialFilters?: DataGridFilterState;
  summary?: ReactNode;
  toolbarActions?: ReactNode;
}

function emptyFilter(): DataGridTextFilter {
  return { operator: "contains", text: "", selectedValues: [] };
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function compareValues(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function isActiveFilter(
  filter: DataGridTextFilter | undefined,
): filter is DataGridTextFilter {
  return Boolean(filter?.text.trim() || filter?.selectedValues.length);
}

function operatorLabel(operator: DataGridTextOperator): string {
  return operator === "contains" ? "contains" : "does not contain";
}

function sortedDistinctValues<TData>(
  data: readonly TData[],
  column: DataGridColumn<TData>,
): string[] {
  if (!column.getFilterValue) return [];
  return Array.from(
    new Set(data.map(column.getFilterValue).filter(Boolean)),
  ).sort((left, right) => compareValues(left, right));
}

export function FilterableDataGrid<TData>({
  title,
  data,
  columns,
  getRowId,
  loading,
  loadingMessage,
  emptyMessage,
  initialSort,
  initialFilters = {},
  summary,
  toolbarActions,
}: FilterableDataGridProps<TData>) {
  const [sort, setSort] = useState<DataGridSortState>(initialSort);
  const [filters, setFilters] = useState<DataGridFilterState>(initialFilters);
  const [valueQueries, setValueQueries] = useState<Record<string, string>>({});

  const filterableColumns = useMemo(
    () => columns.filter((column) => Boolean(column.getFilterValue)),
    [columns],
  );
  const distinctValues = useMemo(() => {
    const next = new Map<string, string[]>();
    filterableColumns.forEach((column) => {
      next.set(column.id, sortedDistinctValues(data, column));
    });
    return next;
  }, [data, filterableColumns]);

  const visibleRows = useMemo(() => {
    const filtered = data.filter((row) =>
      filterableColumns.every((column) => {
        if (!column.getFilterValue) return true;
        const filter = filters[column.id];
        if (!isActiveFilter(filter)) return true;
        const value = column.getFilterValue(row);
        const searchValue = column.getFilterSearchValue?.(row) ?? value;
        const normalizedValue = normalize(searchValue);
        const text = normalize(filter?.text ?? "");
        if (
          filter?.selectedValues.length &&
          !filter.selectedValues.includes(value)
        ) {
          return false;
        }
        if (!text) return true;
        if (filter.operator === "does_not_contain") {
          return !normalizedValue.includes(text);
        }
        return normalizedValue.includes(text);
      }),
    );

    const sortColumn = columns.find((column) => column.id === sort.columnId);
    if (!sortColumn?.getSortValue) return filtered;
    const getSortValue = sortColumn.getSortValue;
    return [...filtered].sort((left, right) => {
      const compared = compareValues(getSortValue(left), getSortValue(right));
      return sort.direction === "asc" ? compared : compared * -1;
    });
  }, [columns, data, filterableColumns, filters, sort]);

  const activeFilters = filterableColumns
    .map((column) => ({ column, filter: filters[column.id] }))
    .filter(({ filter }) => isActiveFilter(filter));

  const updateFilter = (
    columnId: string,
    updater: (filter: DataGridTextFilter) => DataGridTextFilter,
  ) => {
    setFilters((current) => {
      const nextFilter = updater(current[columnId] ?? emptyFilter());
      return { ...current, [columnId]: nextFilter };
    });
  };

  const clearFilter = (columnId: string) => {
    setFilters((current) => ({ ...current, [columnId]: emptyFilter() }));
  };

  const clearAllFilters = () => {
    setFilters({});
  };

  const toggleSort = (column: DataGridColumn<TData>) => {
    if (!column.getSortValue) return;
    setSort((current) =>
      current.columnId === column.id
        ? {
            columnId: column.id,
            direction: current.direction === "asc" ? "desc" : "asc",
          }
        : { columnId: column.id, direction: "asc" },
    );
  };

  const toggleFilterValue = (columnId: string, value: string) => {
    updateFilter(columnId, (filter) => {
      const selected = new Set(filter.selectedValues);
      if (selected.has(value)) {
        selected.delete(value);
      } else {
        selected.add(value);
      }
      return { ...filter, selectedValues: [...selected] };
    });
  };

  return (
    <div className="filterable-data-grid">
      <div className="data-grid-toolbar">
        <div className="data-grid-view-title">
          <TableProperties size={15} aria-hidden="true" />
          <strong>{title}</strong>
          <span className="meta">
            {visibleRows.length} shown / {data.length} loaded
          </span>
        </div>
        <div className="data-grid-tools">
          {summary}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant={activeFilters.length ? "secondary" : "ghost"}
                aria-label="Open table filters"
              >
                <Filter size={14} aria-hidden="true" />
                Filter
                {activeFilters.length ? (
                  <span>{activeFilters.length}</span>
                ) : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="data-grid-filter-popover">
              <div className="data-grid-filter-head">
                <div>
                  <strong>Filter records</strong>
                  <span>Show rows where all active conditions match.</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!activeFilters.length}
                  onClick={clearAllFilters}
                >
                  Clear all
                </Button>
              </div>
              <div className="data-grid-filter-list">
                {filterableColumns.map((column) => {
                  const filter = filters[column.id] ?? emptyFilter();
                  const values = distinctValues.get(column.id) ?? [];
                  const valueQuery = normalize(valueQueries[column.id] ?? "");
                  const visibleValues = values
                    .filter(
                      (value) =>
                        !valueQuery || normalize(value).includes(valueQuery),
                    )
                    .slice(0, column.filterValueLimit ?? 80);
                  return (
                    <section
                      className="data-grid-filter-condition"
                      key={column.id}
                    >
                      <div className="data-grid-filter-condition-head">
                        <strong>{column.label}</strong>
                        <button
                          type="button"
                          onClick={() => clearFilter(column.id)}
                        >
                          Clear
                        </button>
                      </div>
                      <div
                        className="data-grid-filter-operator"
                        role="group"
                        aria-label={`${column.label} text operator`}
                      >
                        {(["contains", "does_not_contain"] as const).map(
                          (operator) => (
                            <button
                              key={operator}
                              type="button"
                              aria-pressed={filter.operator === operator}
                              className={
                                filter.operator === operator
                                  ? "active"
                                  : undefined
                              }
                              onClick={() =>
                                updateFilter(column.id, (current) => ({
                                  ...current,
                                  operator,
                                }))
                              }
                            >
                              {operatorLabel(operator)}
                            </button>
                          ),
                        )}
                      </div>
                      <label className="data-grid-filter-field">
                        <span>Text predicate</span>
                        <Input
                          aria-label={`${column.label} filter text`}
                          value={filter.text}
                          placeholder={`${column.label} text`}
                          onChange={(event) =>
                            updateFilter(column.id, (current) => ({
                              ...current,
                              text: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label className="data-grid-filter-field">
                        <span>Find values</span>
                        <Input
                          aria-label={`${column.label} value search`}
                          value={valueQueries[column.id] ?? ""}
                          placeholder="Search values"
                          onChange={(event) =>
                            setValueQueries((current) => ({
                              ...current,
                              [column.id]: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <div
                        className="data-grid-value-list"
                        aria-label={`${column.label} values`}
                      >
                        {visibleValues.map((value) => (
                          <label key={value} className="data-grid-value-option">
                            <input
                              type="checkbox"
                              checked={filter.selectedValues.includes(value)}
                              onChange={() =>
                                toggleFilterValue(column.id, value)
                              }
                            />
                            <span>{value}</span>
                          </label>
                        ))}
                        {values.length > visibleValues.length ? (
                          <span className="data-grid-value-overflow">
                            {values.length - visibleValues.length} more values.
                            Use search or text predicate.
                          </span>
                        ) : null}
                      </div>
                    </section>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
          {toolbarActions}
        </div>
      </div>
      {activeFilters.length ? (
        <div
          className="data-grid-filter-chips"
          aria-label="Active table filters"
        >
          {activeFilters.map(({ column, filter }) => (
            <button
              key={column.id}
              type="button"
              onClick={() => clearFilter(column.id)}
            >
              <span>{column.label}</span>
              <span>
                {filter?.selectedValues.length
                  ? filter.selectedValues.join(", ")
                  : `${operatorLabel(filter?.operator ?? "contains")} "${filter?.text.trim()}"`}
              </span>
              <X size={12} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : null}
      <div className="filterable-data-grid-scroll">
        <table className="filterable-data-grid-table">
          <thead>
            <tr>
              {columns.map((column) => {
                const active = sort.columnId === column.id;
                const SortIcon = sort.direction === "desc" ? SortDesc : SortAsc;
                return (
                  <th
                    key={column.id}
                    aria-sort={
                      active
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : column.getSortValue
                          ? "none"
                          : undefined
                    }
                    className={column.headerClassName}
                    scope="col"
                  >
                    {column.getSortValue ? (
                      <button
                        type="button"
                        className="data-grid-sort-button"
                        onClick={() => toggleSort(column)}
                      >
                        <span>{column.label}</span>
                        {active ? (
                          <SortIcon size={13} aria-hidden="true" />
                        ) : (
                          <span aria-hidden="true">↕</span>
                        )}
                      </button>
                    ) : (
                      column.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={getRowId(row)}>
                {columns.map((column) =>
                  column.rowHeader ? (
                    <th
                      key={column.id}
                      className={column.className}
                      scope="row"
                    >
                      {column.render(row)}
                    </th>
                  ) : (
                    <td key={column.id} className={column.className}>
                      {column.render(row)}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {loading && !data.length ? <Empty title={loadingMessage} /> : null}
        {!loading && !visibleRows.length ? (
          <Empty
            title={
              data.length ? "No rows match the current filters." : emptyMessage
            }
          />
        ) : null}
      </div>
    </div>
  );
}
