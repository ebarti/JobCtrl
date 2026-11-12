import type { ResumeArtifact } from "../../contexts/resumes/index.js";
import type { ArtifactsSearch } from "../../routes/-artifacts.search.js";
import { useIsMobile } from "../../shared/hooks/use-mobile.js";
import { FilterableDataGrid } from "../../shared/ui/filterable-data-grid.js";
import { artifactColumns, ArtifactMobileRow } from "./columns.js";

export interface ArtifactsTableProps {
  readonly items: readonly ResumeArtifact[];
  readonly loading: boolean;
  readonly total: number;
  readonly page: number;
  readonly pages: number;
  readonly pageSize: number;
  readonly sort: ArtifactsSearch["sort"];
  readonly direction: "asc" | "desc";
  readonly onSort: (
    sort: ArtifactsSearch["sort"],
    direction: "asc" | "desc",
  ) => void;
  readonly onPageChange: (page: number) => void;
  readonly onPageSizeChange: (pageSize: number) => void;
}
export function ArtifactsTable({
  items,
  loading,
  total,
  page,
  pages,
  pageSize,
  sort,
  direction,
  onSort,
  onPageChange,
  onPageSizeChange,
}: ArtifactsTableProps) {
  const mobile = useIsMobile();
  return (
    <FilterableDataGrid<ResumeArtifact>
      title="Saved materials"
      data={items}
      columns={artifactColumns}
      getRowId={(row) => row.artifactId}
      loading={loading}
      loadingMessage="Loading saved materials."
      emptyMessage="No recorded PDF files match these filters."
      sort={{ columnId: sort, direction }}
      onSortChange={(next) => {
        if (
          artifactColumns.some(
            (column) => column.id === next.columnId && column.sortable,
          )
        )
          onSort(next.columnId as ArtifactsSearch["sort"], next.direction);
      }}
      manualSorting
      initialSort={{ columnId: "created_at", direction: "desc" }}
      mobileLayout="cards"
      {...(mobile
        ? {
            mobileListLabel: "Materials",
            renderMobileRow: (row: ResumeArtifact) => (
              <ArtifactMobileRow row={row} />
            ),
          }
        : {})}
      pagination={{
        page,
        pageSize,
        totalPages: pages,
        totalRows: total,
        onPageChange,
        onPageSizeChange,
      }}
    />
  );
}
