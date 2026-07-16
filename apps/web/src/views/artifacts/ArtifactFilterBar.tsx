import { useNavigate } from "@tanstack/react-router";

import {
  ARTIFACT_STATUSES,
  type ArtifactsSearch,
} from "../../routes/-artifacts.search.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../shared/ui/select.js";

export interface ArtifactFilterBarProps {
  search: ArtifactsSearch;
}

export function ArtifactFilterBar({ search }: ArtifactFilterBarProps) {
  const navigate = useNavigate({ from: "/artifacts" });
  const statusItems = ARTIFACT_STATUSES.map((status) => ({
    value: status,
    label: status,
  }));
  const apply = (next: Partial<ArtifactsSearch>) => {
    void navigate({
      search: (prev: ArtifactsSearch) => ({ ...prev, page: 1, ...next }),
    });
  };
  return (
    <div className="toolbar">
      <label className="field">
        <span>Status</span>
        <Select
          items={statusItems}
          value={search.status}
          onValueChange={(status) => {
            if (status !== null) apply({ status });
          }}
        >
          <SelectTrigger aria-label="Status" className="w-full min-w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {statusItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </label>
    </div>
  );
}
