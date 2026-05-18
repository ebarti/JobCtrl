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
  onPrimaryAction: () => void;
  onHideSelected: () => void;
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
  onPrimaryAction,
  onHideSelected,
}: JobBulkActionsProps) {
  const restoring = search.deleted === "deleted";
  const hidden = search.deleted === "hidden";
  const primaryLabel = hidden ? "unhide selected" : restoring ? "restore selected" : "delete selected";
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
        <button
          className={`tab ${hidden ? "on" : ""}`}
          type="button"
          onClick={() => onSetDeleted("hidden")}
        >
          hidden jobs
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
      {!hidden ? (
        <button
          className="tab danger-action"
          type="button"
          disabled={!selectedCount || loading}
          onClick={onHideSelected}
        >
          hide selected
        </button>
      ) : null}
      <button
        className={`tab ${restoring || hidden ? "on" : "danger-action"}`}
        type="button"
        disabled={!selectedCount || loading}
        onClick={onPrimaryAction}
      >
        {primaryLabel}
      </button>
    </div>
  );
}
