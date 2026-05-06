import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";

import { useOpenArtifactMutation } from "../../contexts/materials/hooks/useOpenArtifactMutation.js";
import { artifactStatusTone } from "../../contexts/materials/lib/artifact-status-tone.js";
import { useArtifactDetailQuery } from "../../contexts/operations/hooks/useArtifactDetailQuery.js";
import { useEscapeKey } from "../../shared/hooks/useEscapeKey.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { Empty } from "../../shared/ui/empty.js";
import { Section } from "../../shared/ui/section.js";

export interface ArtifactDetailPanelProps {
  artifactId: string;
}

export function ArtifactDetailPanel({ artifactId }: ArtifactDetailPanelProps) {
  const navigate = useNavigate();
  const search = useSearch({ from: "/artifacts" });
  const close = useCallback(() => {
    void navigate({ to: "/artifacts", search });
  }, [navigate, search]);
  useEscapeKey(true, close);

  const { data: detail, error: queryError } = useArtifactDetailQuery(artifactId);
  const openArtifact = useOpenArtifactMutation();
  const errorMessage =
    queryError instanceof Error
      ? queryError.message
      : openArtifact.error?.message ?? "";

  return (
    <div className="drawer-backdrop">
      <aside className="drawer detail-drawer">
        <button
          aria-label="Close artifact details"
          className="drawer-close"
          type="button"
          onClick={close}
        >
          x
        </button>
        {errorMessage && !detail ? <Empty title={errorMessage} /> : null}
        {!detail && !errorMessage ? <Empty title="Loading artifact." /> : null}
        {detail ? (
          <>
            <div className="drawer-head">
              <span className={`tag ${artifactStatusTone(detail.artifact.status)}`}>
                {detail.artifact.status}
              </span>
              <span>
                <small>{detail.artifact.company}</small>
                <h2>{detail.artifact.title || detail.artifact.type}</h2>
                <p>
                  {detail.artifact.type} · created {formatDateTime(detail.artifact.createdAt)}
                </p>
              </span>
            </div>
            <Section title="Artifact details">
              <dl className="detail-list">
                <div>
                  <dt>Artifact id</dt>
                  <dd className="mono">{detail.artifact.artifactId}</dd>
                </div>
                <div>
                  <dt>Job</dt>
                  <dd>{detail.artifact.jobKey || "-"}</dd>
                </div>
                <div>
                  <dt>Local path</dt>
                  <dd className="mono">{detail.artifact.localPath || "-"}</dd>
                </div>
                <div>
                  <dt>Size</dt>
                  <dd>{detail.artifact.size}</dd>
                </div>
              </dl>
              <button
                className="tab on"
                type="button"
                disabled={openArtifact.isPending || detail.artifact.status === "missing"}
                onClick={() => openArtifact.mutate({ artifactId: detail.artifact.artifactId })}
              >
                {openArtifact.isPending ? "opening" : "open"}
              </button>
              <button
                className="tab"
                type="button"
                disabled={!detail.artifact.jobKey}
                onClick={() =>
                  void navigate({
                    to: "/jobs/$jobId",
                    params: { jobId: detail.artifact.jobKey },
                  })
                }
              >
                open related job
              </button>
            </Section>
            {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
          </>
        ) : null}
      </aside>
    </div>
  );
}
