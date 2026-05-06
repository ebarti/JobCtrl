import type { PaginatedResponse } from "@jobhunter/contracts";

export interface PagerProps {
  pagination: PaginatedResponse<unknown>["pagination"] | undefined;
  page: number;
  onPage: (page: number) => void;
}

export function Pager({ pagination, page, onPage }: PagerProps) {
  return (
    <div className="pager">
      <button
        className="tab"
        type="button"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        previous
      </button>
      <span className="meta">
        page {pagination?.page ?? page} / {pagination?.pages ?? 1}
      </span>
      <button
        className="tab"
        type="button"
        disabled={page >= (pagination?.pages ?? 1)}
        onClick={() => onPage(page + 1)}
      >
        next
      </button>
    </div>
  );
}
