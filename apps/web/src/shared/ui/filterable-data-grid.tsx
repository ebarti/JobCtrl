import {
  IconFilter,
  IconGripVertical,
  IconSortAscending,
  IconSortDescending,
  IconTable,
  IconX,
} from "@tabler/icons-react";
import {
  Fragment,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog.js";
import { Empty } from "./empty.js";
import { Input } from "./input.js";
import { TablePager, type TablePagerProps } from "./table-pager.js";

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
  header?: ReactNode | ((context: DataGridHeaderContext<TData>) => ReactNode);
  render: (row: TData, context: DataGridCellContext<TData>) => ReactNode;
  sortable?: boolean;
  getSortValue?: (row: TData) => string | number;
  getFilterValue?: (row: TData) => string;
  getFilterSearchValue?: (row: TData) => string;
  filterValues?: readonly string[];
  className?: string;
  headerClassName?: string;
  filterValueLimit?: number;
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  rowHeader?: boolean;
  reorderable?: boolean;
}

export interface DataGridSortState {
  columnId: string;
  direction: DataGridSortDirection;
}

export type DataGridDensity = "compact" | "regular" | "comfy";
export type DataGridMobileLayout = "table" | "cards";
export type DataGridColumnVisibilityState = Record<string, boolean>;
export type DataGridColumnWidthsState = Record<string, number>;
export type DataGridColorTone = "success" | "warning" | "danger" | "info";

export interface DataGridGroupingState {
  columnId: string;
}

export interface DataGridColorRule {
  columnId: string;
  predicate: {
    op: "eq" | "neq" | "gte" | "lte" | "contains";
    value: string | number;
  };
  tone: DataGridColorTone;
}

export interface DataGridHeaderContext<TData> {
  pageRows: readonly TData[];
  visibleRows: readonly TData[];
  allRows: readonly TData[];
}

export interface DataGridCellContext<TData> {
  pageRows: readonly TData[];
  rowId: string;
  rowIndex: number;
}

export interface DataGridPaginationState {
  page: number;
  pageSize: number;
  totalPages: number;
  totalRows?: number;
  pageSizeOptions?: TablePagerProps["pageSizeOptions"];
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
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
  sort?: DataGridSortState;
  onSortChange?: (next: DataGridSortState) => void;
  manualSorting?: boolean;
  initialFilters?: DataGridFilterState;
  filters?: DataGridFilterState;
  onFiltersChange?: (next: DataGridFilterState) => void;
  manualFiltering?: boolean;
  paginate?: boolean;
  initialPageSize?: number;
  pageSizeOptions?: TablePagerProps["pageSizeOptions"];
  pagination?: DataGridPaginationState;
  summary?: ReactNode;
  toolbarActions?: ReactNode;
  tableClassName?: string;
  resizableColumns?: boolean;
  columnVisibility?: DataGridColumnVisibilityState;
  columnOrder?: readonly string[];
  onColumnOrderChange?: (next: readonly string[]) => void;
  columnWidths?: DataGridColumnWidthsState;
  onColumnWidthsChange?: (next: DataGridColumnWidthsState) => void;
  density?: DataGridDensity | null;
  mobileLayout?: DataGridMobileLayout;
  grouping?: DataGridGroupingState | null;
  colorRules?: readonly DataGridColorRule[];
  rowClassName?: (row: TData) => string | undefined;
  rowAriaSelected?: (row: TData) => boolean;
  onRowActivate?: (row: TData) => void;
  rowActivationLabel?: (row: TData) => string;
  rowActivationAppearance?: "visible" | "focus-only";
  onPageRowsChange?: (rows: readonly TData[]) => void;
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

function sortButtonLabel(
  columnLabel: string,
  activeDirection: DataGridSortDirection | null,
): string {
  if (activeDirection === "asc") {
    return `Sort by ${columnLabel} (ascending)`;
  }
  if (activeDirection === "desc") {
    return `Sort by ${columnLabel} (descending)`;
  }
  return `Sort by ${columnLabel}`;
}

const ROW_ACTIVATION_IGNORE_SELECTOR = [
  "a",
  "button",
  "input",
  "label",
  "select",
  "summary",
  "textarea",
  "[role='button']",
  "[role='link']",
  "[data-row-activation-ignore]",
].join(",");

function shouldIgnoreRowActivation(event: MouseEvent<HTMLElement>): boolean {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return true;
  }
  return (
    event.target instanceof Element &&
    Boolean(event.target.closest(ROW_ACTIVATION_IGNORE_SELECTOR))
  );
}

function classNames(
  ...values: Array<string | undefined | false>
): string | undefined {
  const joined = values.filter(Boolean).join(" ");
  return joined || undefined;
}

function clampWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function orderColumns<TData>(
  columns: Array<DataGridColumn<TData>>,
  order: readonly string[] | undefined,
): Array<DataGridColumn<TData>> {
  if (!order?.length) return columns;
  const byId = new Map(columns.map((column) => [column.id, column]));
  const ordered: Array<DataGridColumn<TData>> = [];
  const seen = new Set<string>();
  for (const columnId of order) {
    const column = byId.get(columnId);
    if (!column || seen.has(columnId)) continue;
    ordered.push(column);
    seen.add(columnId);
  }
  for (const column of columns) {
    if (!seen.has(column.id)) {
      ordered.push(column);
    }
  }
  return ordered;
}

function filterVisibleColumns<TData>(
  columns: Array<DataGridColumn<TData>>,
  visibility: DataGridColumnVisibilityState | undefined,
): Array<DataGridColumn<TData>> {
  if (!visibility) return columns;
  return columns.filter((column) => visibility[column.id] !== false);
}

function isColumnReorderable<TData>(column: DataGridColumn<TData>): boolean {
  return column.reorderable !== false;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function columnRuleValue<TData>(
  row: TData,
  column: DataGridColumn<TData>,
): string | number {
  const filterValue =
    column.getFilterSearchValue?.(row) ?? column.getFilterValue?.(row);
  if (filterValue !== undefined) return filterValue;
  return column.getSortValue?.(row) ?? "";
}

function groupLabelFor<TData>(
  row: TData,
  column: DataGridColumn<TData>,
): string {
  const value = column.getFilterValue?.(row) ?? column.getSortValue?.(row);
  const label = String(value ?? "").trim();
  return label || "Unspecified";
}

function matchesColorRule<TData>(
  row: TData,
  column: DataGridColumn<TData>,
  rule: DataGridColorRule,
): boolean {
  const left = columnRuleValue(row, column);
  const right = rule.predicate.value;
  if (rule.predicate.op === "gte" || rule.predicate.op === "lte") {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) {
      return false;
    }
    return rule.predicate.op === "gte"
      ? leftNumber >= rightNumber
      : leftNumber <= rightNumber;
  }
  const leftText = normalize(String(left));
  const rightText = normalize(String(right));
  if (rule.predicate.op === "eq") return leftText === rightText;
  if (rule.predicate.op === "neq") return leftText !== rightText;
  return leftText.includes(rightText);
}

function firstMatchingTone<TData>(
  row: TData,
  columnsById: ReadonlyMap<string, DataGridColumn<TData>>,
  colorRules: readonly DataGridColorRule[],
  columnId?: string,
): DataGridColorTone | null {
  for (const rule of colorRules) {
    if (columnId && rule.columnId !== columnId) continue;
    const column = columnsById.get(rule.columnId);
    if (column && matchesColorRule(row, column, rule)) {
      return rule.tone;
    }
  }
  return null;
}

function toneClass(
  target: "row" | "cell",
  tone: DataGridColorTone | null,
): string | undefined {
  return tone ? `data-grid-${target}-tone-${tone}` : undefined;
}

export function isActiveDataGridFilter(
  filter: DataGridTextFilter | undefined,
): filter is DataGridTextFilter {
  return Boolean(filter?.text.trim() || filter?.selectedValues.length);
}

export function hasActiveDataGridFilters(
  filters: DataGridFilterState,
): boolean {
  return Object.values(filters).some(isActiveDataGridFilter);
}

function operatorLabel(operator: DataGridTextOperator): string {
  return operator === "contains" ? "contains" : "does not contain";
}

function sortedDistinctValues<TData>(
  data: readonly TData[],
  column: DataGridColumn<TData>,
): string[] {
  if (column.filterValues) return [...column.filterValues];
  if (!column.getFilterValue) return [];
  return Array.from(
    new Set(data.map(column.getFilterValue).filter(Boolean)),
  ).sort((left, right) => compareValues(left, right));
}

interface ColumnFilterDialogProps<TData> {
  column: DataGridColumn<TData>;
  filter: DataGridTextFilter;
  values: readonly string[];
  valueQuery: string;
  active: boolean;
  onClear: () => void;
  onOperatorChange: (operator: DataGridTextOperator) => void;
  onTextChange: (text: string) => void;
  onValueQueryChange: (text: string) => void;
  onToggleValue: (value: string) => void;
}

function ColumnFilterDialog<TData>({
  column,
  filter,
  values,
  valueQuery,
  active,
  onClear,
  onOperatorChange,
  onTextChange,
  onValueQueryChange,
  onToggleValue,
}: ColumnFilterDialogProps<TData>) {
  const normalizedQuery = normalize(valueQuery);
  const visibleValues = values
    .filter(
      (value) => !normalizedQuery || normalize(value).includes(normalizedQuery),
    )
    .slice(0, column.filterValueLimit ?? 80);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className={
            active
              ? "data-grid-column-filter-button active"
              : "data-grid-column-filter-button"
          }
          aria-label={`Filter ${column.label} column${active ? " (active)" : ""}`}
        >
          <IconFilter size={12} aria-hidden="true" />
        </button>
      </DialogTrigger>
      <DialogContent className="data-grid-column-filter-dialog">
        <DialogHeader>
          <DialogTitle>{column.label} filter</DialogTitle>
          <DialogDescription>
            Show rows where this column matches the selected values and text
            predicate.
          </DialogDescription>
        </DialogHeader>
        <section className="data-grid-filter-condition">
          <div className="data-grid-filter-condition-head">
            <strong>{column.label}</strong>
            <button type="button" onClick={onClear}>
              Clear
            </button>
          </div>
          <div
            className="data-grid-filter-operator"
            role="group"
            aria-label={`${column.label} text operator`}
          >
            {(["contains", "does_not_contain"] as const).map((operator) => (
              <button
                key={operator}
                type="button"
                aria-pressed={filter.operator === operator}
                className={filter.operator === operator ? "active" : undefined}
                onClick={() => onOperatorChange(operator)}
              >
                {operatorLabel(operator)}
              </button>
            ))}
          </div>
          <label className="data-grid-filter-field">
            <span>Text predicate</span>
            <Input
              aria-label={`${column.label} filter text`}
              value={filter.text}
              placeholder={`${column.label} text`}
              onChange={(event) => onTextChange(event.target.value)}
            />
          </label>
          <label className="data-grid-filter-field">
            <span>Find values</span>
            <Input
              aria-label={`${column.label} value search`}
              value={valueQuery}
              placeholder="Search values"
              onChange={(event) => onValueQueryChange(event.target.value)}
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
                  onChange={() => onToggleValue(value)}
                />
                <span>{value}</span>
              </label>
            ))}
            {values.length > visibleValues.length ? (
              <span className="data-grid-value-overflow">
                {values.length - visibleValues.length} more values. Use search
                or text predicate.
              </span>
            ) : null}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
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
  sort: controlledSort,
  onSortChange,
  manualSorting = false,
  initialFilters = {},
  filters: controlledFilters,
  onFiltersChange,
  manualFiltering = false,
  paginate = false,
  initialPageSize = 25,
  pageSizeOptions,
  pagination,
  summary,
  toolbarActions,
  tableClassName,
  resizableColumns = true,
  columnVisibility,
  columnOrder,
  onColumnOrderChange,
  columnWidths: controlledColumnWidths,
  onColumnWidthsChange,
  density,
  mobileLayout = "table",
  grouping,
  colorRules = [],
  rowClassName,
  rowAriaSelected,
  onRowActivate,
  rowActivationLabel,
  rowActivationAppearance = "focus-only",
  onPageRowsChange,
}: FilterableDataGridProps<TData>) {
  const [localSort, setLocalSort] = useState<DataGridSortState>(initialSort);
  const [localFilters, setLocalFilters] =
    useState<DataGridFilterState>(initialFilters);
  const [localPage, setLocalPage] = useState(1);
  const [localPageSize, setLocalPageSize] = useState(initialPageSize);
  const [valueQueries, setValueQueries] = useState<Record<string, string>>({});
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
  const [draggedColumnId, setDraggedColumnId] = useState<string | null>(null);
  const [columnDropTarget, setColumnDropTarget] = useState<{
    columnId: string;
    edge: "before" | "after";
  } | null>(null);
  const [columnReorderStatus, setColumnReorderStatus] = useState("");
  const tableInstanceId = useId();
  const [localColumnWidths, setLocalColumnWidths] =
    useState<DataGridColumnWidthsState>({});
  const tableRef = useRef<HTMLTableElement | null>(null);
  const stopColumnResizeRef = useRef<(() => void) | null>(null);
  const lastPageRowIdsRef = useRef<string[]>([]);
  const sort = controlledSort ?? localSort;
  const filters = controlledFilters ?? localFilters;
  const columnWidths = controlledColumnWidths ?? localColumnWidths;
  const paginationEnabled = paginate || Boolean(pagination);
  const page = pagination?.page ?? localPage;
  const pageSize = pagination?.pageSize ?? localPageSize;
  const effectivePageSizeOptions =
    pagination?.pageSizeOptions ?? pageSizeOptions;
  const orderedColumns = useMemo(
    () => orderColumns(columns, columnOrder),
    [columns, columnOrder],
  );
  const displayColumns = useMemo(
    () => filterVisibleColumns(orderedColumns, columnVisibility),
    [columnVisibility, orderedColumns],
  );
  const columnsById = useMemo(
    () => new Map(columns.map((column) => [column.id, column])),
    [columns],
  );
  const groupColumn = grouping?.columnId
    ? columnsById.get(grouping.columnId)
    : undefined;
  const activationColumnIndex = useMemo(() => {
    const rowHeaderIndex = displayColumns.findIndex(
      (column) => column.rowHeader,
    );
    return rowHeaderIndex >= 0 ? rowHeaderIndex : 0;
  }, [displayColumns]);

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
    const filtered = manualFiltering
      ? data
      : data.filter((row) =>
          filterableColumns.every((column) => {
            if (!column.getFilterValue) return true;
            const filter = filters[column.id];
            if (!isActiveDataGridFilter(filter)) return true;
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
    if (manualSorting || !sortColumn?.getSortValue) return filtered;
    const getSortValue = sortColumn.getSortValue;
    return [...filtered].sort((left, right) => {
      const compared = compareValues(getSortValue(left), getSortValue(right));
      return sort.direction === "asc" ? compared : compared * -1;
    });
  }, [
    columns,
    data,
    filterableColumns,
    filters,
    manualFiltering,
    manualSorting,
    sort,
  ]);

  useEffect(() => {
    if (!pagination) {
      setLocalPage(1);
    }
  }, [filters, localPageSize, pagination, sort]);

  const totalRows = pagination?.totalRows ?? visibleRows.length;
  const totalPages =
    pagination?.totalPages ?? Math.max(1, Math.ceil(totalRows / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);

  useEffect(() => {
    if (pagination || safePage === localPage) return;
    setLocalPage(safePage);
  }, [localPage, pagination, safePage]);

  const pageRows = useMemo(() => {
    if (!paginationEnabled || pagination) return visibleRows;
    const offset = (safePage - 1) * pageSize;
    return visibleRows.slice(offset, offset + pageSize);
  }, [pageSize, pagination, paginationEnabled, safePage, visibleRows]);
  const pageRowIndexById = useMemo(() => {
    const next = new Map<string, number>();
    pageRows.forEach((row, index) => {
      next.set(getRowId(row), index);
    });
    return next;
  }, [getRowId, pageRows]);
  const pageRowGroups = useMemo(() => {
    if (!groupColumn) {
      return [{ key: "all", label: null, rows: pageRows }];
    }
    const groups = new Map<string, TData[]>();
    for (const row of pageRows) {
      const label = groupLabelFor(row, groupColumn);
      const key = `${groupColumn.id}:${label}`;
      const rows = groups.get(key);
      if (rows) {
        rows.push(row);
      } else {
        groups.set(key, [row]);
      }
    }
    return Array.from(groups, ([key, rows]) => ({
      key,
      label: key.slice(groupColumn.id.length + 1),
      rows,
    }));
  }, [groupColumn, pageRows]);

  const headerContext = useMemo<DataGridHeaderContext<TData>>(
    () => ({ pageRows, visibleRows, allRows: data }),
    [data, pageRows, visibleRows],
  );

  const activeFilters = filterableColumns
    .map((column) => ({ column, filter: filters[column.id] }))
    .filter(({ filter }) => isActiveDataGridFilter(filter));

  useEffect(() => {
    if (!onPageRowsChange) return;
    const nextIds = pageRows.map(getRowId);
    if (sameStrings(lastPageRowIdsRef.current, nextIds)) {
      return;
    }
    lastPageRowIdsRef.current = nextIds;
    onPageRowsChange(pageRows);
  }, [getRowId, onPageRowsChange, pageRows]);

  useEffect(() => {
    setColumnWidths((current) => {
      const columnIds = new Set(columns.map((column) => column.id));
      const next = Object.fromEntries(
        Object.entries(current).filter(([columnId]) => columnIds.has(columnId)),
      );
      return Object.keys(next).length === Object.keys(current).length
        ? current
        : next;
    });
  }, [columns]);

  useEffect(
    () => () => {
      stopColumnResizeRef.current?.();
    },
    [],
  );

  function setColumnWidths(
    updater: (current: DataGridColumnWidthsState) => DataGridColumnWidthsState,
  ) {
    const next = updater(columnWidths);
    if (next === columnWidths) {
      return;
    }
    if (onColumnWidthsChange) {
      onColumnWidthsChange(next);
    } else {
      setLocalColumnWidths(next);
    }
  }

  const setFilters = (
    updater: (current: DataGridFilterState) => DataGridFilterState,
  ) => {
    const next = updater(filters);
    if (onFiltersChange) {
      onFiltersChange(next);
    } else {
      setLocalFilters(next);
    }
  };

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

  const toggleSort = (column: DataGridColumn<TData>) => {
    if (!(column.sortable ?? Boolean(column.getSortValue))) return;
    const next =
      sort.columnId === column.id
        ? {
            columnId: column.id,
            direction: (sort.direction === "asc"
              ? "desc"
              : "asc") as DataGridSortDirection,
          }
        : { columnId: column.id, direction: "asc" as const };
    if (onSortChange) {
      onSortChange(next);
    } else {
      setLocalSort(next);
    }
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

  const handlePageChange = (nextPage: number) => {
    if (pagination) {
      pagination.onPageChange(nextPage);
    } else {
      setLocalPage(nextPage);
    }
  };

  const handlePageSizeChange = (nextPageSize: number) => {
    if (pagination) {
      pagination.onPageSizeChange(nextPageSize);
    } else {
      setLocalPageSize(nextPageSize);
      setLocalPage(1);
    }
  };

  const measuredColumnWidths = () => {
    const widths: Record<string, number> = {};
    tableRef.current
      ?.querySelectorAll<HTMLElement>("thead th[data-column-id]")
      .forEach((header) => {
        const columnId = header.dataset["columnId"];
        if (!columnId) return;
        const measured = Math.round(header.getBoundingClientRect().width);
        if (measured > 0) {
          widths[columnId] = measured;
        }
      });
    for (const column of columns) {
      if (widths[column.id] === undefined && column.width !== undefined) {
        widths[column.id] = column.width;
      }
    }
    return widths;
  };

  const resizeColumnBy = (column: DataGridColumn<TData>, delta: number) => {
    const minWidth = column.minWidth ?? 56;
    const maxWidth = column.maxWidth ?? 1600;
    const measured = measuredColumnWidths();
    setColumnWidths((current) => {
      const currentWidth =
        current[column.id] ?? measured[column.id] ?? column.width ?? minWidth;
      return {
        ...measured,
        ...current,
        [column.id]: clampWidth(currentWidth + delta, minWidth, maxWidth),
      };
    });
  };

  const startColumnResize = (
    column: DataGridColumn<TData>,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (!resizableColumns) return;
    event.preventDefault();
    event.stopPropagation();
    stopColumnResizeRef.current?.();

    const minWidth = column.minWidth ?? 56;
    const maxWidth = column.maxWidth ?? 1600;
    const startingWidths = measuredColumnWidths();
    const startWidth =
      columnWidths[column.id] ??
      startingWidths[column.id] ??
      column.width ??
      minWidth;
    const startX = event.clientX;

    setColumnWidths((current) => ({ ...startingWidths, ...current }));
    document.body.classList.add("data-grid-column-resizing");

    const stopResize = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      document.body.classList.remove("data-grid-column-resizing");
      stopColumnResizeRef.current = null;
    };
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = clampWidth(
        startWidth + moveEvent.clientX - startX,
        minWidth,
        maxWidth,
      );
      setColumnWidths((current) => ({
        ...startingWidths,
        ...current,
        [column.id]: nextWidth,
      }));
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    stopColumnResizeRef.current = stopResize;
  };

  const handleColumnResizeKeyDown = (
    column: DataGridColumn<TData>,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 40 : 16;
    resizeColumnBy(column, event.key === "ArrowLeft" ? -step : step);
  };

  const moveColumn = (
    sourceColumnId: string,
    targetColumnId: string,
    edge: "before" | "after",
  ) => {
    if (!onColumnOrderChange || sourceColumnId === targetColumnId) return;
    const sourceColumn = columnsById.get(sourceColumnId);
    const targetColumn = columnsById.get(targetColumnId);
    if (
      !sourceColumn ||
      !targetColumn ||
      !isColumnReorderable(sourceColumn) ||
      !isColumnReorderable(targetColumn)
    )
      return;

    const next = orderedColumns.map((column) => column.id);
    const sourceIndex = next.indexOf(sourceColumnId);
    if (sourceIndex < 0) return;
    next.splice(sourceIndex, 1);
    const targetIndex = next.indexOf(targetColumnId);
    if (targetIndex < 0) return;
    next.splice(targetIndex + (edge === "after" ? 1 : 0), 0, sourceColumnId);
    if (
      sameStrings(
        next,
        orderedColumns.map((column) => column.id),
      )
    )
      return;

    onColumnOrderChange(next);
    setColumnReorderStatus(
      `${sourceColumn.label} moved ${edge} ${targetColumn.label}.`,
    );
  };

  const columnDropEdge = (
    event: ReactDragEvent<HTMLTableCellElement>,
  ): "before" | "after" => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientX > bounds.left + bounds.width / 2 ? "after" : "before";
  };

  const draggedColumnFrom = (
    event: ReactDragEvent<HTMLElement>,
  ): string | null =>
    event.dataTransfer.getData("application/x-jobctrl-column") ||
    event.dataTransfer.getData("text/plain") ||
    draggedColumnId;

  const handleColumnReorderKeyDown = (
    column: DataGridColumn<TData>,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const reorderableColumns = displayColumns.filter(isColumnReorderable);
    const currentIndex = reorderableColumns.findIndex(
      (candidate) => candidate.id === column.id,
    );
    const delta = event.key === "ArrowLeft" ? -1 : 1;
    const target = reorderableColumns[currentIndex + delta];
    if (!target) {
      setColumnReorderStatus(
        `${column.label} is already the ${delta < 0 ? "first" : "last"} visible column.`,
      );
      return;
    }
    moveColumn(column.id, target.id, delta < 0 ? "before" : "after");
  };

  const summaryText = pagination
    ? `${data.length} shown / ${totalRows ?? data.length} total`
    : paginationEnabled
      ? `${pageRows.length} shown / ${visibleRows.length} filtered / ${data.length} loaded`
      : `${visibleRows.length} shown / ${data.length} loaded`;
  const columnWidthTotal = resizableColumns
    ? displayColumns.reduce(
        (total, column) =>
          total + (columnWidths[column.id] ?? column.width ?? 0),
        0,
      )
    : 0;
  const tableStyle = columnWidthTotal
    ? { width: `max(100%, ${columnWidthTotal}px)` }
    : undefined;

  const renderColumnControls = (column: DataGridColumn<TData>) => {
    const active = sort.columnId === column.id;
    const SortIcon =
      sort.direction === "desc" ? IconSortDescending : IconSortAscending;
    const sortable = column.sortable ?? Boolean(column.getSortValue);
    const filterable = Boolean(column.getFilterValue);
    const filter = filters[column.id] ?? emptyFilter();
    const filterActive = isActiveDataGridFilter(filter);
    const header =
      typeof column.header === "function"
        ? column.header(headerContext)
        : (column.header ?? column.label);

    return (
      <>
        {sortable ? (
          <button
            type="button"
            className="data-grid-sort-button"
            aria-label={sortButtonLabel(
              column.label,
              active ? sort.direction : null,
            )}
            onClick={() => toggleSort(column)}
          >
            <span>{header}</span>
            {active ? (
              <SortIcon size={13} aria-hidden="true" />
            ) : (
              <span aria-hidden="true">↕</span>
            )}
          </button>
        ) : (
          <span className="data-grid-column-title">{header}</span>
        )}
        {filterable ? (
          <ColumnFilterDialog
            column={column}
            filter={filter}
            values={distinctValues.get(column.id) ?? []}
            valueQuery={valueQueries[column.id] ?? ""}
            active={filterActive}
            onClear={() => clearFilter(column.id)}
            onOperatorChange={(operator) =>
              updateFilter(column.id, (current) => ({
                ...current,
                operator,
              }))
            }
            onTextChange={(text) =>
              updateFilter(column.id, (current) => ({
                ...current,
                text,
              }))
            }
            onValueQueryChange={(text) =>
              setValueQueries((current) => ({
                ...current,
                [column.id]: text,
              }))
            }
            onToggleValue={(value) => toggleFilterValue(column.id, value)}
          />
        ) : null}
      </>
    );
  };

  const mobileControlColumns = displayColumns.filter(
    (column) =>
      typeof column.header === "function" ||
      (column.sortable ?? Boolean(column.getSortValue)) ||
      Boolean(column.getFilterValue),
  );

  return (
    <div
      className="filterable-data-grid data-surface"
      data-density={density ?? undefined}
      data-mobile-layout={mobileLayout}
    >
      {onColumnOrderChange ? (
        <>
          <span
            id={`${tableInstanceId}-column-reorder-help`}
            className="sr-only"
          >
            Drag a column grip to reorder visible columns. With a grip focused,
            use the left and right arrow keys. Move earlier and later buttons
            remain available in the Columns dialog.
          </span>
          <span className="sr-only" role="status" aria-live="polite">
            {columnReorderStatus}
          </span>
        </>
      ) : null}
      <div className="data-grid-toolbar">
        <div className="data-grid-view-title">
          <IconTable size={15} aria-hidden="true" />
          <strong>{title}</strong>
          <span className="meta">{summaryText}</span>
        </div>
        <div className="data-grid-tools">
          {summary}
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
              <IconX size={12} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : null}
      {mobileLayout === "cards" && mobileControlColumns.length ? (
        <details
          className="data-grid-mobile-controls"
          open={mobileControlsOpen}
          onToggle={(event) => setMobileControlsOpen(event.currentTarget.open)}
        >
          <summary>Sort and filter columns</summary>
          {mobileControlsOpen ? (
            <div
              className="data-grid-mobile-control-list"
              role="group"
              aria-label={`${title} column controls`}
            >
              {mobileControlColumns.map((column) => (
                <div
                  key={column.id}
                  className="data-grid-mobile-control"
                  data-column-id={column.id}
                >
                  {renderColumnControls(column)}
                </div>
              ))}
            </div>
          ) : null}
        </details>
      ) : null}
      <div className="filterable-data-grid-scroll">
        <table
          ref={tableRef}
          aria-label={title}
          className={
            tableClassName
              ? `filterable-data-grid-table ${tableClassName}`
              : "filterable-data-grid-table"
          }
          style={tableStyle}
        >
          {resizableColumns ? (
            <colgroup>
              {displayColumns.map((column) => {
                const width = columnWidths[column.id] ?? column.width;
                return (
                  <col
                    key={column.id}
                    data-column-id={column.id}
                    style={width ? { width: `${width}px` } : undefined}
                  />
                );
              })}
            </colgroup>
          ) : null}
          <thead>
            <tr>
              {displayColumns.map((column) => {
                const active = sort.columnId === column.id;
                const sortable =
                  column.sortable ?? Boolean(column.getSortValue);
                return (
                  <th
                    key={column.id}
                    id={`${tableInstanceId}-${column.id}-header`}
                    data-column-id={column.id}
                    aria-sort={
                      active
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : sortable
                          ? "none"
                          : undefined
                    }
                    className={classNames(
                      column.headerClassName,
                      resizableColumns && "data-grid-column-resizable",
                    )}
                    data-column-drop-edge={
                      columnDropTarget?.columnId === column.id
                        ? columnDropTarget.edge
                        : undefined
                    }
                    scope="col"
                    onDragOver={
                      onColumnOrderChange && isColumnReorderable(column)
                        ? (event) => {
                            const sourceColumnId = draggedColumnFrom(event);
                            if (!sourceColumnId || sourceColumnId === column.id)
                              return;
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            setColumnDropTarget({
                              columnId: column.id,
                              edge: columnDropEdge(event),
                            });
                          }
                        : undefined
                    }
                    onDrop={
                      onColumnOrderChange && isColumnReorderable(column)
                        ? (event) => {
                            const sourceColumnId = draggedColumnFrom(event);
                            if (!sourceColumnId) return;
                            event.preventDefault();
                            const edge =
                              columnDropTarget?.columnId === column.id
                                ? columnDropTarget.edge
                                : columnDropEdge(event);
                            moveColumn(sourceColumnId, column.id, edge);
                            setDraggedColumnId(null);
                            setColumnDropTarget(null);
                          }
                        : undefined
                    }
                  >
                    <div className="data-grid-column-head">
                      {onColumnOrderChange && isColumnReorderable(column) ? (
                        <button
                          type="button"
                          className="data-grid-column-reorder-handle"
                          aria-label={`Reorder ${column.label} column`}
                          aria-describedby={`${tableInstanceId}-column-reorder-help`}
                          aria-keyshortcuts="ArrowLeft ArrowRight"
                          title={`Drag to reorder ${column.label} column`}
                          draggable
                          data-row-activation-ignore
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onDragStart={(event) => {
                            event.stopPropagation();
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData(
                              "application/x-jobctrl-column",
                              column.id,
                            );
                            event.dataTransfer.setData("text/plain", column.id);
                            setDraggedColumnId(column.id);
                            setColumnReorderStatus(
                              `${column.label} picked up for reordering.`,
                            );
                          }}
                          onDragEnd={() => {
                            setDraggedColumnId(null);
                            setColumnDropTarget(null);
                          }}
                          onKeyDown={(event) =>
                            handleColumnReorderKeyDown(column, event)
                          }
                        >
                          <IconGripVertical size={14} aria-hidden="true" />
                        </button>
                      ) : null}
                      {renderColumnControls(column)}
                    </div>
                    {resizableColumns ? (
                      <button
                        type="button"
                        className="data-grid-column-resizer"
                        aria-label={`Resize ${column.label} column`}
                        title={`Resize ${column.label} column`}
                        data-row-activation-ignore
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onKeyDown={(event) =>
                          handleColumnResizeKeyDown(column, event)
                        }
                        onPointerDown={(event) =>
                          startColumnResize(column, event)
                        }
                      />
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {pageRowGroups.map((group) => (
              <Fragment key={group.key}>
                {group.label ? (
                  <tr className="data-grid-group-row">
                    <th colSpan={Math.max(1, displayColumns.length)}>
                      <span>{group.label}</span>
                      <span>{group.rows.length}</span>
                    </th>
                  </tr>
                ) : null}
                {group.rows.map((row) => {
                  const rowId = getRowId(row);
                  const rowIndex = pageRowIndexById.get(rowId) ?? 0;
                  const baseRowClassName = rowClassName?.(row);
                  const rowTone = firstMatchingTone(
                    row,
                    columnsById,
                    colorRules,
                  );
                  const effectiveRowClassName = classNames(
                    baseRowClassName,
                    toneClass("row", rowTone),
                    onRowActivate && "data-grid-row-activatable",
                  );
                  const activationLabel =
                    rowActivationLabel?.(row) ?? `Open row ${rowId}`;
                  return (
                    <tr
                      key={rowId}
                      className={effectiveRowClassName}
                      aria-selected={rowAriaSelected?.(row)}
                      onClick={
                        onRowActivate
                          ? (event) => {
                              if (shouldIgnoreRowActivation(event)) {
                                return;
                              }
                              onRowActivate(row);
                            }
                          : undefined
                      }
                    >
                      {displayColumns.map((column, columnIndex) => {
                        const content = column.render(row, {
                          pageRows,
                          rowId,
                          rowIndex,
                        });
                        const cellTone = firstMatchingTone(
                          row,
                          columnsById,
                          colorRules,
                          column.id,
                        );
                        const cellClassName = classNames(
                          column.className,
                          toneClass("cell", cellTone),
                        );
                        const isActivationCell =
                          Boolean(onRowActivate) &&
                          columnIndex === activationColumnIndex;
                        const activationButton = isActivationCell ? (
                          <button
                            type="button"
                            className={classNames(
                              "data-grid-row-activation-button",
                              rowActivationAppearance === "focus-only" &&
                                "row-activation-focus-only",
                            )}
                            aria-label={activationLabel}
                            onClick={(event) => {
                              event.stopPropagation();
                              onRowActivate?.(row);
                            }}
                          >
                            <span aria-hidden="true">View details</span>
                          </button>
                        ) : null;
                        return column.rowHeader ? (
                          <th
                            key={column.id}
                            className={cellClassName}
                            data-label={column.label}
                            data-row-header="true"
                            headers={`${tableInstanceId}-${column.id}-header`}
                            scope="row"
                          >
                            {content}
                            {activationButton}
                          </th>
                        ) : (
                          <td
                            key={column.id}
                            className={cellClassName}
                            data-label={column.label}
                            headers={`${tableInstanceId}-${column.id}-header`}
                          >
                            {content}
                            {activationButton}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
        {loading && !data.length ? <Empty title={loadingMessage} /> : null}
        {!loading && !pageRows.length ? (
          <Empty
            title={
              data.length ? "No rows match the current filters." : emptyMessage
            }
          />
        ) : null}
      </div>
      {paginationEnabled ? (
        <TablePager
          page={safePage}
          pageSize={pageSize}
          totalPages={totalPages}
          totalRows={totalRows}
          {...(effectivePageSizeOptions
            ? { pageSizeOptions: effectivePageSizeOptions }
            : {})}
          onPageChange={handlePageChange}
          onPageSizeChange={handlePageSizeChange}
        />
      ) : null}
    </div>
  );
}
