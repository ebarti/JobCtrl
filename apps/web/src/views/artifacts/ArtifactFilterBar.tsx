import { useNavigate } from "@tanstack/react-router";

import { DirectionSelect } from "../../shared/ui/direction-select.js";
import { PageSize } from "../../shared/ui/page-size.js";
import { SelectPairs } from "../../shared/ui/select-pairs.js";
import {
  ARTIFACT_STATUSES,
  type ArtifactsSearch,
} from "../../routes/-artifacts.search.js";

const SORT_OPTIONS = [
  ["created_at", "Created"],
  ["title", "Title"],
  ["company", "Company"],
  ["type", "Type"],
  ["status", "Status"],
  ["size_bytes", "Size"],
] as const;

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
      <SelectPairs
        options={SORT_OPTIONS}
        value={search.sort}
        onChange={(value) => apply({ sort: value })}
      />
      <DirectionSelect value={search.dir} onChange={(value) => apply({ dir: value })} />
      <PageSize value={search.pageSize} onChange={(value) => apply({ pageSize: value })} />
    </div>
  );
}
