import type { ArtifactSummary } from "@jobctrl/contracts";
import {
  IconAlertTriangle,
  IconArchive,
  IconArrowLeft,
} from "@tabler/icons-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ArtifactComparison } from "../../contexts/materials/components/ArtifactComparison.js";
import { ArtifactStatusBadge } from "../../contexts/materials/components/ArtifactStatusBadge.js";
import { useOpenArtifactMutation } from "../../contexts/materials/hooks/useOpenArtifactMutation.js";
import { TailoringExplanationSection } from "../../contexts/materials/components/TailoringExplanationSection.js";
import { artifactStatusDescription } from "../../contexts/materials/lib/artifact-status-copy.js";
import { useArtifactDetailQuery } from "../../contexts/operations/hooks/useArtifactDetailQuery.js";
import { useArtifactsListQuery } from "../../contexts/operations/hooks/useArtifactsListQuery.js";
import type { ArtifactsListInput } from "../../contexts/operations/types.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { Alert, AlertDescription, AlertTitle } from "../../shared/ui/alert.js";
import { Button } from "../../shared/ui/button.js";
import { Empty } from "../../shared/ui/empty.js";
import { PdfPreviewViewer } from "../../shared/ui/PdfPreviewViewer.js";
import { RouteWorkspace } from "../../shared/ui/route-workspace.js";
import { Section } from "../../shared/ui/section.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../shared/ui/select.js";

export interface ArtifactDetailPanelProps {
  artifactId: string;
}

function isPreviewablePdfArtifact(type: string, localPath: string): boolean {
  return (
    type.toLowerCase().endsWith("_pdf") ||
    localPath.toLowerCase().endsWith(".pdf")
  );
}

function artifactPreviewCacheKey(
  createdAt: string | null,
  sizeBytes: number | null,
): string {
  return `${createdAt ?? "unknown"}:${sizeBytes ?? "unknown"}`;
}

function isSuppressed(status: string): boolean {
  return status.toLowerCase() === "suppressed";
}

function artifactComparisonListInput(
  type: string | null | undefined,
): ArtifactsListInput {
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
  const template =
    artifact.resumeTemplate?.effective.templateName ??
    artifact.resumeTemplate?.effective.templateId;
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

  const { data: detail, error: queryError } =
    useArtifactDetailQuery(artifactId);
  const comparisonListInput = useMemo(
    () => artifactComparisonListInput(detail?.artifact.type),
    [detail?.artifact.type],
  );
  const comparisonList = useArtifactsListQuery(comparisonListInput, {
    enabled: Boolean(detail),
  });
  const comparisonCandidates = useMemo(
    () =>
      detail
        ? comparableArtifacts(detail.artifact, comparisonList.data?.items ?? [])
        : [],
    [comparisonList.data?.items, detail],
  );
  const comparisonItems = useMemo(
    () =>
      comparisonCandidates.map((candidate) => ({
        value: candidate.artifactId,
        label: artifactOptionLabel(candidate),
      })),
    [comparisonCandidates],
  );
  const [comparisonArtifactId, setComparisonArtifactId] = useState<string>("");
  const openArtifact = useOpenArtifactMutation();
  const errorMessage =
    queryError instanceof Error
      ? queryError.message
      : (openArtifact.error?.message ?? "");
  const errorTitle =
    queryError instanceof Error
      ? "Artifact could not be refreshed"
      : "Artifact could not be opened";

  useEffect(() => {
    setComparisonArtifactId((current) =>
      comparisonCandidates.some((candidate) => candidate.artifactId === current)
        ? current
        : (comparisonCandidates[0]?.artifactId ?? ""),
    );
  }, [artifactId, comparisonCandidates]);

  return (
    <div
      className="route-page route-page--artifact-detail"
      aria-label="Artifact details"
    >
      {errorMessage && !detail ? <Empty title={errorMessage} /> : null}
      {!detail && !errorMessage ? <Empty title="Loading artifact." /> : null}
      {detail ? (
        <RouteWorkspace
          aria-label="Artifact details"
          className="artifact-detail-workspace"
          contentLabel="Artifact audit and preview"
          header={
            <div className="artifact-detail-workspace__header">
              <Button
                aria-label="Back to artifacts"
                className="workspace-back"
                size="sm"
                type="button"
                variant="ghost"
                onClick={close}
              >
                <IconArrowLeft aria-hidden="true" size={16} stroke={1.9} />
                Artifacts
              </Button>
              <span>
                <ArtifactStatusBadge status={detail.artifact.status} />
              </span>
              <div className="artifact-detail-workspace__title">
                <small>{detail.artifact.company}</small>
                <h1>{detail.artifact.title || detail.artifact.type}</h1>
                <p>
                  {detail.artifact.type} · created{" "}
                  {formatDateTime(detail.artifact.createdAt)}
                </p>
              </div>
            </div>
          }
        >
          <div className="artifact-detail-route-body">
            <div className="artifact-detail-layout">
              <div className="artifact-detail-sidebar">
                <h2 className="sr-only">Artifact audit</h2>
                <Section title="Artifact details">
                  {isSuppressed(detail.artifact.status) ? (
                    <Alert>
                      <IconArchive aria-hidden="true" />
                      <AlertTitle>Historical artifact</AlertTitle>
                      <AlertDescription>
                        This artifact is historical audit material and is not
                        active apply-ready material.
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  <dl className="detail-list">
                    <div>
                      <dt>Status</dt>
                      <dd>
                        {artifactStatusDescription(detail.artifact.status)}
                      </dd>
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
                      <dd className="mono">
                        {detail.artifact.localPath || "-"}
                      </dd>
                    </div>
                    <div>
                      <dt>Size</dt>
                      <dd>{detail.artifact.size}</dd>
                    </div>
                  </dl>
                  <button
                    className="tab on"
                    type="button"
                    disabled={
                      openArtifact.isPending ||
                      detail.artifact.status === "missing"
                    }
                    onClick={() =>
                      openArtifact.mutate({
                        artifactId: detail.artifact.artifactId,
                      })
                    }
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
                <TailoringExplanationSection
                  explanation={detail.tailoringExplanation}
                />
                <Section title="Artifact comparison">
                  {comparisonList.isFetching && !comparisonList.data ? (
                    <p className="meta">Loading comparable artifacts.</p>
                  ) : null}
                  {comparisonCandidates.length ? (
                    <>
                      <label className="field compact artifact-comparison-picker">
                        <span>Compare with</span>
                        <Select
                          items={comparisonItems}
                          value={comparisonArtifactId || null}
                          onValueChange={(nextArtifactId) =>
                            setComparisonArtifactId(nextArtifactId ?? "")
                          }
                        >
                          <SelectTrigger
                            aria-label="Compare with"
                            className="w-full"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent alignItemWithTrigger={false}>
                            <SelectGroup>
                              {comparisonItems.map((item) => (
                                <SelectItem key={item.value} value={item.value}>
                                  {item.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
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
              {isPreviewablePdfArtifact(
                detail.artifact.type,
                detail.artifact.localPath,
              ) ? (
                <section
                  className="artifact-preview-panel"
                  aria-label="Artifact PDF preview"
                >
                  <PdfPreviewViewer
                    cacheKey={artifactPreviewCacheKey(
                      detail.artifact.createdAt,
                      detail.artifact.sizeBytes,
                    )}
                    loadingMessage="The artifact PDF is loading into the in-app preview."
                    loadingTitle="Rendering artifact PDF."
                    openLabel="open PDF"
                    pageAltPrefix={
                      detail.artifact.title || detail.artifact.type
                    }
                    title="Artifact preview"
                    url={api.artifactPreviewPdfUrl(
                      detail.artifact.artifactId,
                      artifactPreviewCacheKey(
                        detail.artifact.createdAt,
                        detail.artifact.sizeBytes,
                      ),
                    )}
                  />
                </section>
              ) : null}
            </div>
            {errorMessage ? (
              <Alert variant="destructive">
                <IconAlertTriangle aria-hidden="true" />
                <AlertTitle>{errorTitle}</AlertTitle>
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        </RouteWorkspace>
      ) : null}
    </div>
  );
}
