import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";

import { useOpenArtifactMutation } from "../../contexts/materials/hooks/useOpenArtifactMutation.js";
import { TailoringExplanationSection } from "../../contexts/materials/components/TailoringExplanationSection.js";
import { artifactStatusDescription } from "../../contexts/materials/lib/artifact-status-copy.js";
import { artifactStatusTone } from "../../contexts/materials/lib/artifact-status-tone.js";
import { useArtifactDetailQuery } from "../../contexts/operations/hooks/useArtifactDetailQuery.js";
import { useEscapeKey } from "../../shared/hooks/useEscapeKey.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { DetailDrawerBackdrop } from "../../shared/ui/detail-drawer-backdrop.js";
import { Empty } from "../../shared/ui/empty.js";
import { PdfPreviewViewer } from "../../shared/ui/PdfPreviewViewer.js";
import { Section } from "../../shared/ui/section.js";

export interface ArtifactDetailPanelProps {
  artifactId: string;
}

function isPreviewablePdfArtifact(type: string, localPath: string): boolean {
  return type.toLowerCase().endsWith("_pdf") || localPath.toLowerCase().endsWith(".pdf");
}

function artifactPreviewCacheKey(createdAt: string | null, sizeBytes: number | null): string {
  return `${createdAt ?? "unknown"}:${sizeBytes ?? "unknown"}`;
}

function isSuppressed(status: string): boolean {
  return status.toLowerCase() === "suppressed";
}

export function ArtifactDetailPanel({ artifactId }: ArtifactDetailPanelProps) {
  const navigate = useNavigate();
  const search = useSearch({ from: "/artifacts" });
  const { api } = usePorts();
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
    <DetailDrawerBackdrop onDismiss={close}>
      <div
        className="drawer detail-drawer artifact-detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Artifact details"
      >
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
              <span>
                <span
                  className={`tag ${artifactStatusTone(detail.artifact.status)}`}
                  title={artifactStatusDescription(detail.artifact.status)}
                >
                  {detail.artifact.status}
                </span>
              </span>
              <span>
                <small>{detail.artifact.company}</small>
                <h2>{detail.artifact.title || detail.artifact.type}</h2>
                <p>
                  {detail.artifact.type} · created {formatDateTime(detail.artifact.createdAt)}
                </p>
              </span>
            </div>
            <div className="artifact-detail-layout">
              <div className="artifact-detail-sidebar">
                <Section title="Artifact details">
                  {isSuppressed(detail.artifact.status) ? (
                    <div className="banner inline">
                      This artifact is historical audit material and is not active apply-ready material.
                    </div>
                  ) : null}
                  <dl className="detail-list">
                    <div>
                      <dt>Status</dt>
                      <dd>{artifactStatusDescription(detail.artifact.status)}</dd>
                    </div>
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
                <TailoringExplanationSection explanation={detail.tailoringExplanation} />
              </div>
              {isPreviewablePdfArtifact(detail.artifact.type, detail.artifact.localPath) ? (
                <section className="artifact-preview-panel" aria-label="Artifact PDF preview">
                  <PdfPreviewViewer
                    cacheKey={artifactPreviewCacheKey(
                      detail.artifact.createdAt,
                      detail.artifact.sizeBytes,
                    )}
                    loadingMessage="The artifact PDF is loading into the in-app preview."
                    loadingTitle="Rendering artifact PDF."
                    openLabel="open PDF"
                    pageAltPrefix={detail.artifact.title || detail.artifact.type}
                    title="Artifact preview"
                    url={api.artifactPreviewPdfUrl(
                      detail.artifact.artifactId,
                      artifactPreviewCacheKey(detail.artifact.createdAt, detail.artifact.sizeBytes),
                    )}
                  />
                </section>
              ) : null}
            </div>
            {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
          </>
        ) : null}
      </div>
    </DetailDrawerBackdrop>
  );
}
