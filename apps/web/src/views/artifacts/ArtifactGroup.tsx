import { useNavigate } from "@tanstack/react-router";

import { useOpenArtifactMutation } from "../../contexts/materials/hooks/useOpenArtifactMutation.js";
import { artifactStatusTone } from "../../contexts/materials/lib/artifact-status-tone.js";
import {
  artifactKind,
  artifactVersionLabel,
  type ArtifactGroup as ArtifactGroupShape,
} from "./selectors/artifactSelectors.js";

export interface ArtifactGroupProps {
  group: ArtifactGroupShape;
}

export function ArtifactGroup({ group }: ArtifactGroupProps) {
  const navigate = useNavigate();
  const openArtifact = useOpenArtifactMutation();
  return (
    <div className="data-row artifact-group">
      <span className="title-stack">
        <b>{group.title}</b>
        <span>{group.company}</span>
      </span>
      <span className="artifact-variants">
        {group.artifacts.map((artifact) => (
          <button
            key={artifact.artifactId}
            type="button"
            className="artifact-variant"
            disabled={artifact.status === "missing" || openArtifact.isPending}
            title={
              artifact.status === "missing"
                ? "Local file is missing; regenerate this artifact before opening it."
                : artifact.localPath
            }
            onClick={() => openArtifact.mutate({ artifactId: artifact.artifactId })}
          >
            <span className={`tag ${artifactStatusTone(artifact.status)}`}>
              {artifactKind(artifact.type)}
            </span>
            <span>{artifactVersionLabel(artifact.type)}</span>
            <span className="mono">{artifact.size}</span>
          </button>
        ))}
      </span>
      <span className="row-actions">
        <button
          className="tab"
          type="button"
          disabled={!group.jobKey}
          onClick={() =>
            void navigate({ to: "/jobs/$jobId", params: { jobId: group.jobKey } })
          }
        >
          job
        </button>
      </span>
    </div>
  );
}
