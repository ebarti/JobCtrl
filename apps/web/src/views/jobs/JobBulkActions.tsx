import type { JobsSearch } from "../../routes/-jobs.search.js";

export interface JobBulkActionsProps {
  search: JobsSearch;
  selectedCount: number;
  hasItems: boolean;
  hasAnyMatching: boolean;
  loading: boolean;
  onSetDeleted: (deleted: JobsSearch["deleted"]) => void;
  onSelectPage: () => void;
  onSelectAllMatching: () => void;
  onClearSelection: () => void;
  onMutateSelected: () => void;
}

export function JobBulkActions({
  search,
  selectedCount,
  hasItems,
  hasAnyMatching,
  loading,
  onSetDeleted,
  onSelectPage,
  onSelectAllMatching,
  onClearSelection,
  onMutateSelected,
}: JobBulkActionsProps) {
  const restoring = search.deleted === "deleted";
  return (
    <div className="bulk-bar">
      <div className="tabs">
        <button
          className={`tab ${search.deleted === "active" ? "on" : ""}`}
          type="button"
          onClick={() => onSetDeleted("active")}
        >
          active jobs
        </button>
        <button
          className={`tab ${restoring ? "on" : ""}`}
          type="button"
          onClick={() => onSetDeleted("deleted")}
        >
          deleted jobs
        </button>
      </div>
      <span className="meta">
        {selectedCount ? `${selectedCount} selected` : "select jobs to manage"}
      </span>
      <button className="tab" type="button" disabled={!hasItems} onClick={onSelectPage}>
        select page
      </button>
      <button className="tab" type="button" disabled={!hasAnyMatching} onClick={onSelectAllMatching}>
        select all matching
      </button>
      <button className="tab" type="button" disabled={!selectedCount} onClick={onClearSelection}>
        clear selected
      </button>
      <button
        className={`tab ${restoring ? "on" : "danger-action"}`}
        type="button"
        disabled={!selectedCount || loading}
        onClick={onMutateSelected}
      >
        {restoring ? "restore selected" : "delete selected"}
      </button>
    </div>
  );
}
