import { STAGES, STAGE_STATES } from "@jobhunter/contracts";
import { useNavigate } from "@tanstack/react-router";

import type { JobsSearch } from "../../routes/-jobs.search.js";

const STATE_OPTIONS = ["all", ...STAGE_STATES] as const;

export interface JobFilterBarProps {
  search: JobsSearch;
}

export function JobFilterBar({ search }: JobFilterBarProps) {
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
    </div>
  );
}
