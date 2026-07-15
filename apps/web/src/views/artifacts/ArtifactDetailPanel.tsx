import type { ArtifactSummary } from "@jobctrl/contracts";
import { IconX } from "@tabler/icons-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ArtifactComparison } from "../../contexts/materials/components/ArtifactComparison.js";
import { useOpenArtifactMutation } from "../../contexts/materials/hooks/useOpenArtifactMutation.js";
import { TailoringExplanationSection } from "../../contexts/materials/components/TailoringExplanationSection.js";
import { artifactStatusDescription } from "../../contexts/materials/lib/artifact-status-copy.js";
import { artifactStatusTone } from "../../contexts/materials/lib/artifact-status-tone.js";
import { useArtifactDetailQuery } from "../../contexts/operations/hooks/useArtifactDetailQuery.js";
import { useArtifactsListQuery } from "../../contexts/operations/hooks/useArtifactsListQuery.js";
import type { ArtifactsListInput } from "../../contexts/operations/types.js";
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

function artifactComparisonListInput(type: string | null | undefined): ArtifactsListInput {
  const input: ArtifactsListInput = {
    pageSize: 200,
    sort: "created_at",
    dir: "desc",
  };
  if (type) {
    input.type = type;
  }
  return input;
}

function comparableArtifacts(
  artifact: ArtifactSummary,
  candidates: readonly ArtifactSummary[],
): ArtifactSummary[] {
  return candidates.filter((candidate) => {
    if (candidate.artifactId === artifact.artifactId) return false;
    if (candidate.jobKey !== artifact.jobKey) return false;
    if (candidate.type !== artifact.type) return false;
    if (candidate.status.toLowerCase() === "missing") return false;
    return true;
  });
}

function artifactOptionLabel(artifact: ArtifactSummary): string {
  const template = artifact.resumeTemplate?.effective.templateName ?? artifact.resumeTemplate?.effective.templateId;
  const created = formatDateTime(artifact.createdAt);
  return [artifact.status, template, created].filter(Boolean).join(" / ");
}

export function ArtifactDetailPanel({ artifactId }: ArtifactDetailPanelProps) {
  const navigate = useNavigate();
  const search = useSearch({ from: "/artifacts" });
  const { api, featureFlags } = usePorts();
  const isDemo = featureFlags.get("demoMode", false);
  const close = useCallback(() => {
    void navigate({ to: "/artifacts", search });
  }, [navigate, search]);
  useEscapeKey(true, close);

  const { data: detail, error: queryError } = useArtifactDetailQuery(artifactId);
  const comparisonListInput = useMemo(
    () => artifactComparisonListInput(detail?.artifact.type),
    [detail?.artifact.type],
  );
  const comparisonList = useArtifactsListQuery(comparisonListInput, { enabled: Boolean(detail) });
  const comparisonCandidates = useMemo(
    () => (detail ? comparableArtifacts(detail.artifact, comparisonList.data?.items ?? []) : []),
    [comparisonList.data?.items, detail],
  );
  const [comparisonArtifactId, setComparisonArtifactId] = useState<string>("");
  const openArtifact = useOpenArtifactMutation();
  const errorMessage =
    queryError instanceof Error
      ? queryError.message
      : openArtifact.error?.message ?? "";

  useEffect(() => {
    setComparisonArtifactId((current) =>
      comparisonCandidates.some((candidate) => candidate.artifactId === current)
        ? current
        : comparisonCandidates[0]?.artifactId ?? "",
    );
  }, [artifactId, comparisonCandidates]);

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
          <IconX aria-hidden="true" size={18} stroke={1.8} />
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
                    {openArtifact.isPending
                      ? "opening"
                      : isDemo
                        ? "preview in browser"
                        : "open"}
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
                <Section title="Artifact comparison">
                  {comparisonList.isFetching && !comparisonList.data ? (
                    <p className="meta">Loading comparable artifacts.</p>
                  ) : null}
                  {comparisonCandidates.length ? (
                    <>
                      <label className="field compact artifact-comparison-picker">
                        <span>Compare with</span>
                        <select
                          value={comparisonArtifactId}
                          onChange={(event) => setComparisonArtifactId(event.currentTarget.value)}
                        >
                          {comparisonCandidates.map((candidate) => (
                            <option key={candidate.artifactId} value={candidate.artifactId}>
                              {artifactOptionLabel(candidate)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <ArtifactComparison
                        leftArtifactId={detail.artifact.artifactId}
                        leftLabel="Selected"
                        rightArtifactId={comparisonArtifactId || null}
                        rightLabel="Comparison"
                        showTitle={false}
                      />
                    </>
                  ) : (
                    <Empty title="No other artifact for this job and type was found in the current artifact list." />
                  )}
                </Section>
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
