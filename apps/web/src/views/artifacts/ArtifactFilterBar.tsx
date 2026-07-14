import { useNavigate } from "@tanstack/react-router";

import { ARTIFACT_STATUSES, type ArtifactsSearch } from "../../routes/-artifacts.search.js";
import { SelectField } from "../../shared/ui/select-field.js";
import { ToolRow } from "../../shared/ui/tool-row.js";

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
    <ToolRow
      className="data-surface__tools"
      primary={
        <SelectField
          className="tool-row__field"
          label="Status"
          value={search.status}
          onValueChange={(value) => apply({ status: value as ArtifactsSearch["status"] })}
          options={ARTIFACT_STATUSES.map((item) => ({
            value: item,
            label: item === "all" ? "All statuses" : item.replace(/_/g, " "),
          }))}
        />
      }
    />
  );
}
