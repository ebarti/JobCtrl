import { STAGES } from "@jobhunter/contracts";
import { useNavigate } from "@tanstack/react-router";

import { PageSize } from "../../shared/ui/page-size.js";
import type { JobsSearch } from "../../routes/-jobs.search.js";

const STATE_OPTIONS = [
  "all",
  "pending",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "exhausted",
  "stale",
] as const;

export interface JobFilterBarProps {
  search: JobsSearch;
  onRefresh: () => void;
}

export function JobFilterBar({ search, onRefresh }: JobFilterBarProps) {
  const navigate = useNavigate({ from: "/jobs" });
  const apply = (next: Partial<JobsSearch>) => {
    void navigate({ search: (prev: JobsSearch) => ({ ...prev, page: 1, ...next }) });
  };
  return (
    <div className="toolbar">
      <select
        value={search.stage}
        onChange={(event) => apply({ stage: event.target.value as JobsSearch["stage"] })}
      >
        <option value="all">all stages</option>
        {STAGES.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
      <select
        value={search.state}
        onChange={(event) => apply({ state: event.target.value as JobsSearch["state"] })}
      >
        {STATE_OPTIONS.map((item) => (
          <option key={item} value={item}>
            {item} states
          </option>
        ))}
      </select>
      <PageSize value={search.pageSize} onChange={(value) => apply({ pageSize: value })} />
      <button className="tab" type="button" onClick={onRefresh}>
        refresh
      </button>
    </div>
  );
}
