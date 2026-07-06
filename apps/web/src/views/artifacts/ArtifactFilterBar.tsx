import { useNavigate } from "@tanstack/react-router";

import { ARTIFACT_STATUSES, type ArtifactsSearch } from "../../routes/-artifacts.search.js";

export interface ArtifactFilterBarProps {
  search: ArtifactsSearch;
}

export function ArtifactFilterBar({ search }: ArtifactFilterBarProps) {
  const navigate = useNavigate({ from: "/artifacts" });
  const apply = (next: Partial<ArtifactsSearch>) => {
    void navigate({
      search: (prev: ArtifactsSearch) => ({ ...prev, page: 1, ...next }),
    });
  };
  return (
    <div className="toolbar">
      <label className="field">
        <span>Status</span>
        <select
          value={search.status}
          onChange={(event) => apply({ status: event.target.value as ArtifactsSearch["status"] })}
        >
          {ARTIFACT_STATUSES.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
