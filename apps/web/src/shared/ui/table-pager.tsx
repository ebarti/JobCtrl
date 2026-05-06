import type { JSX } from "react";

export interface TablePagerProps {
  page: number;
  pageSize: number;
  totalPages: number;
  totalRows: number | undefined;
  pageSizeOptions?: readonly number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

const DEFAULT_PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;

export function TablePager({
  page,
  pageSize,
  totalPages,
  totalRows,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  onPageChange,
  onPageSizeChange,
}: TablePagerProps): JSX.Element {
  const pages = Math.max(totalPages, 1);
  return (
    <div className="pager">
      <button
        className="tab"
        type="button"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        previous
      </button>
      <span className="meta">
        page {page} / {pages}
        {typeof totalRows === "number" ? ` · ${totalRows} rows` : ""}
      </span>
      <button
        className="tab"
        type="button"
        disabled={page >= pages}
        onClick={() => onPageChange(page + 1)}
      >
        next
      </button>
      <select
        aria-label="Page size"
        value={pageSize}
        onChange={(event) => onPageSizeChange(Number(event.target.value))}
      >
        {pageSizeOptions.map((option) => (
          <option key={option} value={option}>
            {option}/page
          </option>
        ))}
      </select>
    </div>
  );
}
