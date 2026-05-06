import type { ArtifactDetail } from "@jobhunter/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { artifactStatusTone } from "../../contexts/materials/lib/artifact-status-tone.js";
import { useEscapeKey } from "../../shared/hooks/useEscapeKey.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { Empty } from "../../shared/ui/empty.js";
import { Section } from "../../shared/ui/section.js";

export interface ArtifactDetailPanelProps {
  artifactId: string;
}

export function ArtifactDetailPanel({ artifactId }: ArtifactDetailPanelProps) {
  const ports = usePorts();
  const navigate = useNavigate();
  const search = useSearch({ from: "/artifacts" });
  const close = useCallback(() => {
    void navigate({ to: "/artifacts", search });
  }, [navigate, search]);
  useEscapeKey(true, close);

  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const requestSeq = useRef(0);

  useEffect(() => {
    const requestId = requestSeq.current + 1;
    requestSeq.current = requestId;
    setDetail(null);
    setError("");
    ports.api
      .artifact(artifactId)
      .then((response) => {
        if (requestId === requestSeq.current) {
          setDetail(response);
        }
      })
      .catch((requestError: unknown) => {
        if (requestId === requestSeq.current) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Unable to load artifact.",
          );
        }
      });
  }, [artifactId, ports.api]);

  const open = async () => {
    if (!detail) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await ports.api.openArtifact(detail.artifact.artifactId);
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "Unable to open artifact.",
      );
    } finally {
      setBusy(false);
    }
  };

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
        {error && !detail ? <Empty title={error} /> : null}
        {!detail && !error ? <Empty title="Loading artifact." /> : null}
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
                disabled={busy || detail.artifact.status === "missing"}
                onClick={() => void open()}
              >
                {busy ? "opening" : "open"}
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
          </>
        ) : null}
      </aside>
    </div>
  );
}
