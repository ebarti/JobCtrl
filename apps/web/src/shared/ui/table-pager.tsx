import type { JSX } from "react";

import { Button } from "./button.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select.js";

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
  const pageSizeItems = pageSizeOptions.map((option) => ({
    value: option,
    label: `${option}/page`,
  }));
  return (
    <div className="pager data-table-pager">
      <Button
        size="sm"
        variant="ghost"
        type="button"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        Previous
      </Button>
      <span className="meta" data-typography="metadata">
        Page {page} of {pages}
        {typeof totalRows === "number" ? ` · ${totalRows} rows` : ""}
      </span>
      <Button
        size="sm"
        variant="ghost"
        type="button"
        disabled={page >= pages}
        onClick={() => onPageChange(page + 1)}
      >
        Next
      </Button>
      <Select
        items={pageSizeItems}
        value={pageSize}
        onValueChange={(nextPageSize) => {
          if (nextPageSize !== null) onPageSizeChange(nextPageSize);
        }}
      >
        <SelectTrigger aria-label="Page size" className="min-w-24" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            {pageSizeItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
