import { Empty } from "../../shared/ui/empty.js";
import { ArtifactGroup } from "./ArtifactGroup.js";
import type { ArtifactGroup as ArtifactGroupShape } from "./selectors/artifactSelectors.js";

export interface ArtifactsTableProps {
  groups: ArtifactGroupShape[];
  loading: boolean;
  loaded: boolean;
}

export function ArtifactsTable({ groups, loading, loaded }: ArtifactsTableProps) {
  return (
    <div className="table">
      {loading && !loaded ? <Empty title="Loading artifacts." /> : null}
      {groups.map((group) => (
        <ArtifactGroup key={group.groupKey} group={group} />
      ))}
      {loaded && groups.length === 0 ? <Empty title="No artifacts match." /> : null}
    </div>
  );
}
