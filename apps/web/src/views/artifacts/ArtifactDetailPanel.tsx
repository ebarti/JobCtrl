import type { ArtifactSummary } from "@jobctrl/contracts";
import {
  IconAlertTriangle,
  IconArchive,
  IconArrowLeft,
  IconChevronDown,
  IconExternalLink,
  IconFileTypePdf,
} from "@tabler/icons-react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ArtifactComparison } from "../../contexts/materials/components/ArtifactComparison.js";
import { ArtifactStatusBadge } from "../../contexts/materials/components/ArtifactStatusBadge.js";
import { useOpenArtifactMutation } from "../../contexts/materials/hooks/useOpenArtifactMutation.js";
import {
  TailoringExplanationSection,
  type TailoringEvidenceReference,
  type TailoringExplanationSectionProps,
} from "../../contexts/materials/components/TailoringExplanationSection.js";
import { artifactStatusDescription } from "../../contexts/materials/lib/artifact-status-copy.js";
import { useArtifactDetailQuery } from "../../contexts/operations/hooks/useArtifactDetailQuery.js";
import { useArtifactsListQuery } from "../../contexts/operations/hooks/useArtifactsListQuery.js";
import { useEvidenceMapQuery } from "../../contexts/operations/hooks/useEvidenceMapQuery.js";
import { useJobDetailQuery } from "../../contexts/operations/hooks/useJobDetailQuery.js";
import type {
  ArtifactsListInput,
  EvidenceMapEntry,
  JobDetail,
} from "../../contexts/operations/types.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { Alert, AlertDescription, AlertTitle } from "../../shared/ui/alert.js";
import { Badge } from "../../shared/ui/badge.js";
import { Button } from "../../shared/ui/button.js";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../shared/ui/card.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../shared/ui/collapsible.js";
import { Empty } from "../../shared/ui/empty.js";
import { PdfPreviewViewer } from "../../shared/ui/PdfPreviewViewer.js";
import { RouteWorkspace } from "../../shared/ui/route-workspace.js";
import { Separator } from "../../shared/ui/separator.js";
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

function artifactTypeLabel(type: string): string {
  return type
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) =>
      part.toLowerCase() === "pdf"
        ? "PDF"
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ");
}

function evidenceReferenceExcerpt(entry: EvidenceMapEntry): string | null {
  const excerpt =
    entry.story?.outcome ?? entry.story?.action ?? entry.story?.scope ?? null;
  return excerpt && excerpt !== entry.title ? excerpt : null;
}

function requirementReferencesById(
  detail: JobDetail | undefined,
): ReadonlyMap<string, string> {
  const references = new Map<string, string>();
  for (const assessment of detail?.requirementFitReport?.assessments ?? []) {
    const requirementId = assessment.requirementId.trim();
    const requirementText = assessment.requirementText.trim();
    if (requirementId && requirementText) {
      references.set(requirementId, requirementText);
    }
  }
  for (const requirement of detail?.employerAnalysis?.requirements ?? []) {
    const requirementId = requirement.id.trim();
    const requirementText = requirement.text.trim();
    if (requirementId && requirementText && !references.has(requirementId)) {
      references.set(requirementId, requirementText);
    }
  }
  return references;
}

function ArtifactTailoringExplanation({
  explanation,
  jobKey,
  renderEvidenceReference,
  resolveEvidenceReference,
}: {
  readonly explanation: TailoringExplanationSectionProps["explanation"];
  readonly jobKey: string;
  readonly renderEvidenceReference: NonNullable<
    TailoringExplanationSectionProps["renderEvidenceReference"]
  >;
  readonly resolveEvidenceReference: NonNullable<
    TailoringExplanationSectionProps["resolveEvidenceReference"]
  >;
}) {
  const jobDetail = useJobDetailQuery(jobKey);
  const requirementReferences = useMemo(
    () => requirementReferencesById(jobDetail.data),
    [jobDetail.data],
  );
  const resolveRequirementReference = useCallback(
    (requirementId: string): string | null | undefined => {
      if (jobDetail.isPending) return undefined;
      return requirementReferences.get(requirementId) ?? null;
    },
    [jobDetail.isPending, requirementReferences],
  );

  return (
    <TailoringExplanationSection
      className="tailoring-explanation-section artifact-tailoring-card"
      explanation={explanation}
      renderEvidenceReference={renderEvidenceReference}
      resolveEvidenceReference={resolveEvidenceReference}
      resolveRequirementReference={resolveRequirementReference}
    />
  );
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
  const evidenceMap = useEvidenceMapQuery();
  const evidenceEntriesById = useMemo(() => {
    const entries = new Map<string, EvidenceMapEntry>();
    for (const entry of evidenceMap.data?.entries ?? []) {
      entries.set(entry.entryId, entry);
      if (entry.evidenceId) entries.set(entry.evidenceId, entry);
    }
    return entries;
  }, [evidenceMap.data?.entries]);
  const resolveEvidenceReference = useCallback(
    (evidenceId: string): TailoringEvidenceReference | null | undefined => {
      if (evidenceMap.isPending) return undefined;
      const entry = evidenceEntriesById.get(evidenceId);
      if (!entry) return null;
      return {
        entryId: entry.entryId,
        title: entry.title,
        excerpt: evidenceReferenceExcerpt(entry),
      };
    },
    [evidenceEntriesById, evidenceMap.isPending],
  );
  const renderEvidenceReference = useCallback(
    (reference: TailoringEvidenceReference) => (
      <Link
        className="tailoring-evidence-reference__link"
        search={{
          q: "",
          entry: reference.entryId,
          job: detail?.artifact.jobKey ?? "",
        }}
        to="/evidence-map"
      >
        <span className="tailoring-evidence-reference__content">
          <strong>{reference.title}</strong>
          {reference.excerpt ? <span>{reference.excerpt}</span> : null}
        </span>
      </Link>
    ),
    [detail?.artifact.jobKey],
  );
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
                  {artifactTypeLabel(detail.artifact.type)} · created{" "}
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
                <Card className="artifact-summary-card" size="sm">
                  <CardHeader className="border-b">
                    <CardTitle>
                      <h3 className="artifact-card-heading">
                        Artifact summary
                      </h3>
                    </CardTitle>
                    <CardDescription>
                      {artifactStatusDescription(detail.artifact.status)}
                    </CardDescription>
                    <CardAction>
                      <Badge variant="outline">
                        {artifactTypeLabel(detail.artifact.type)}
                      </Badge>
                    </CardAction>
                  </CardHeader>
                  <CardContent className="artifact-summary-card__content">
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
                    <dl className="artifact-summary-facts">
                      <div>
                        <dt>Status</dt>
                        <dd>
                          <ArtifactStatusBadge
                            status={detail.artifact.status}
                          />
                        </dd>
                      </div>
                      <div>
                        <dt>Created</dt>
                        <dd>{formatDateTime(detail.artifact.createdAt)}</dd>
                      </div>
                      <div>
                        <dt>File size</dt>
                        <dd>{detail.artifact.size}</dd>
                      </div>
                    </dl>
                    <Separator />
                    <Collapsible className="artifact-technical-details">
                      <CollapsibleTrigger
                        render={
                          <Button
                            className="h-auto min-h-0 self-start px-0 py-0"
                            size="sm"
                            type="button"
                            variant="link"
                          />
                        }
                      >
                        Technical details
                        <IconChevronDown
                          aria-hidden="true"
                          data-icon="inline-end"
                        />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="artifact-technical-details__content">
                        <dl>
                          <div>
                            <dt>Artifact ID</dt>
                            <dd>
                              <code>{detail.artifact.artifactId}</code>
                            </dd>
                          </div>
                          <div>
                            <dt>Job record key</dt>
                            <dd>
                              <code>
                                {detail.artifact.jobKey || "Not recorded"}
                              </code>
                            </dd>
                          </div>
                          <div>
                            <dt>Stored file path</dt>
                            <dd>
                              <code>
                                {detail.artifact.localPath || "Not recorded"}
                              </code>
                            </dd>
                          </div>
                        </dl>
                      </CollapsibleContent>
                    </Collapsible>
                  </CardContent>
                  <CardFooter className="artifact-summary-actions border-t">
                    <Button
                      size="sm"
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
                      <IconFileTypePdf
                        aria-hidden="true"
                        data-icon="inline-start"
                      />
                      {openArtifact.isPending
                        ? "opening"
                        : isDemo
                          ? "preview in browser"
                          : "open"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
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
                      <IconExternalLink
                        aria-hidden="true"
                        data-icon="inline-end"
                      />
                    </Button>
                  </CardFooter>
                </Card>
                {detail.artifact.jobKey &&
                detail.tailoringExplanation?.bulletProvenance.some(
                  (entry) => entry.requirementIds.length > 0,
                ) ? (
                  <ArtifactTailoringExplanation
                    explanation={detail.tailoringExplanation}
                    jobKey={detail.artifact.jobKey}
                    renderEvidenceReference={renderEvidenceReference}
                    resolveEvidenceReference={resolveEvidenceReference}
                  />
                ) : (
                  <TailoringExplanationSection
                    className="tailoring-explanation-section artifact-tailoring-card"
                    explanation={detail.tailoringExplanation}
                    renderEvidenceReference={renderEvidenceReference}
                    resolveEvidenceReference={resolveEvidenceReference}
                  />
                )}
                <Card className="artifact-comparison-card" size="sm">
                  <CardHeader className="border-b">
                    <CardTitle>
                      <h3 className="artifact-card-heading">
                        Artifact comparison
                      </h3>
                    </CardTitle>
                    <CardDescription>
                      Compare this artifact with another version for the same
                      job and file type.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
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
                                  <SelectItem
                                    key={item.value}
                                    value={item.value}
                                  >
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
                  </CardContent>
                </Card>
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
