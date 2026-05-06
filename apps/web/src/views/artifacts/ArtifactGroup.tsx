import { useNavigate } from "@tanstack/react-router";

import { artifactStatusTone } from "../../contexts/materials/lib/artifact-status-tone.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import {
  artifactKind,
  artifactVersionLabel,
  type ArtifactGroup as ArtifactGroupShape,
} from "./selectors/artifactSelectors.js";

export interface ArtifactGroupProps {
  group: ArtifactGroupShape;
  onError: (message: string) => void;
  onStatus: (message: string) => void;
}

export function ArtifactGroup({ group, onError, onStatus }: ArtifactGroupProps) {
  const ports = usePorts();
  const navigate = useNavigate();
  const openArtifact = async (artifactId: string, type: string) => {
    onError("");
    onStatus("");
    try {
      await ports.api.openArtifact(artifactId);
      onStatus(`opened ${type}`);
    } catch (requestError) {
      onError(requestError instanceof Error ? requestError.message : "Unable to open artifact.");
    }
  };
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
            disabled={artifact.status === "missing"}
            title={
              artifact.status === "missing"
                ? "Local file is missing; regenerate this artifact before opening it."
                : artifact.localPath
            }
            onClick={() => void openArtifact(artifact.artifactId, artifact.type)}
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
