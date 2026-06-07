import type { ArtifactTailoringExplanation } from "@jobhunter/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";

import { useOpenArtifactMutation } from "../../contexts/materials/hooks/useOpenArtifactMutation.js";
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

function formatToken(value: string | null | undefined): string {
  if (!value) return "-";
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function scoreText(score: number | null, minScore?: number | null): string {
  if (score === null) return "-";
  const formatted = `${Math.round(score * 100)}%`;
  return minScore === null || minScore === undefined
    ? formatted
    : `${formatted} / minimum ${Math.round(minScore * 100)}%`;
}

function yesNo(value: boolean | null): string {
  if (value === null) return "-";
  return value ? "yes" : "no";
}

function hasItems(items: readonly string[]): boolean {
  return items.length > 0;
}

function EvidenceList({ items }: { readonly items: readonly string[] }) {
  if (!items.length) return <span className="muted">none recorded</span>;
  return (
    <ul className="compact-list">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function TailoringExplanationSection({
  explanation,
}: {
  readonly explanation: ArtifactTailoringExplanation | null;
}) {
  if (!explanation) return null;

  const blockingIssues = [
    ...explanation.quality.errors,
    ...explanation.judge.issues,
    ...explanation.judge.unsupportedClaims,
    ...explanation.judge.fabrications,
    ...explanation.judge.missingRequiredEvidence,
    ...(explanation.adversarialReview?.blockers ?? []),
  ];
  const warnings = [
    ...explanation.quality.warnings,
    ...(explanation.adversarialReview?.warnings ?? []),
  ];
  const showAdversarial =
    explanation.adversarialReview &&
    (explanation.adversarialReview.ran || explanation.adversarialReview.skippedReason);

  return (
    <Section title="Tailoring rationale">
      <div className="tailoring-evidence">
        <dl className="evidence-summary-grid">
          <div>
            <dt>Target seniority</dt>
            <dd>{formatToken(explanation.targetSeniority)}</dd>
          </div>
          <div>
            <dt>Claim mode</dt>
            <dd>{formatToken(explanation.claimMode)}</dd>
          </div>
          <div>
            <dt>Quality gate</dt>
            <dd>{yesNo(explanation.quality.passed ?? explanation.safety.qualityPassed)}</dd>
          </div>
          <div>
            <dt>Judge score</dt>
            <dd>{scoreText(explanation.judge.score, explanation.judge.minScore)}</dd>
          </div>
        </dl>

        <div className="evidence-block">
          <h4>Why these changes</h4>
          <dl className="detail-list compact">
            <div>
              <dt>Covered keywords</dt>
              <dd>
                <EvidenceList items={explanation.keywords.covered} />
              </dd>
            </div>
            <div>
              <dt>Missing keywords</dt>
              <dd>
                <EvidenceList items={explanation.keywords.missing} />
              </dd>
            </div>
            <div>
              <dt>Represented evidence</dt>
              <dd>
                <EvidenceList items={explanation.evidence.representedIds} />
              </dd>
            </div>
            <div>
              <dt>Required evidence</dt>
              <dd>
                <EvidenceList items={explanation.evidence.requiredIds} />
              </dd>
            </div>
            <div>
              <dt>Missing evidence</dt>
              <dd>
                <EvidenceList items={explanation.evidence.missingIds} />
              </dd>
            </div>
            <div>
              <dt>Seniority evidence</dt>
              <dd>
                <EvidenceList items={explanation.evidence.seniorityIds} />
              </dd>
            </div>
          </dl>
        </div>

        <div className="evidence-block">
          <h4>Safety checks</h4>
          <dl className="detail-list compact">
            <div>
              <dt>Validation mode</dt>
              <dd>{formatToken(explanation.validationMode)}</dd>
            </div>
            <div>
              <dt>Auto-approvable claims</dt>
              <dd>
                <EvidenceList items={explanation.safety.autoApprovableClaimModes.map(formatToken)} />
              </dd>
            </div>
            <div>
              <dt>Adjacent drafts allowed</dt>
              <dd>{yesNo(explanation.safety.allowAdjacentAchievementDrafts)}</dd>
            </div>
            <div>
              <dt>Verified metrics</dt>
              <dd>{explanation.evidence.verifiedMetricCount ?? "-"}</dd>
            </div>
            <div>
              <dt>Metric claims</dt>
              <dd>
                <EvidenceList items={explanation.quality.metricClaims} />
              </dd>
            </div>
          </dl>
        </div>

        {hasItems(blockingIssues) || hasItems(warnings) ? (
          <div className="evidence-block">
            <h4>Review findings</h4>
            {hasItems(blockingIssues) ? (
              <div className="finding-list danger">
                <b>Blocking</b>
                <EvidenceList items={blockingIssues} />
              </div>
            ) : null}
            {hasItems(warnings) ? (
              <div className="finding-list warning">
                <b>Warnings</b>
                <EvidenceList items={warnings} />
              </div>
            ) : null}
          </div>
        ) : null}

        {showAdversarial ? (
          <div className="evidence-block">
            <h4>High-fit review</h4>
            {explanation.adversarialReview?.ran ? (
              <dl className="detail-list compact">
                <div>
                  <dt>Passed</dt>
                  <dd>{yesNo(explanation.adversarialReview.passed)}</dd>
                </div>
                <div>
                  <dt>Score</dt>
                  <dd>
                    {scoreText(
                      explanation.adversarialReview.score,
                      explanation.adversarialReview.threshold,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Personas</dt>
                  <dd>
                    <EvidenceList
                      items={explanation.adversarialReview.personas.map((persona) =>
                        `${formatToken(persona.persona)}: ${persona.verdict ?? "-"} ${
                          persona.score === null ? "" : `(${Math.round(persona.score * 100)}%)`
                        }`.trim(),
                      )}
                    />
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="muted">{explanation.adversarialReview?.skippedReason}</p>
            )}
          </div>
        ) : null}

        <div className="evidence-block">
          <h4>Generation context</h4>
          <dl className="detail-list compact">
            <div>
              <dt>Selected model</dt>
              <dd>{explanation.models.selectedModel ?? "-"}</dd>
            </div>
            <div>
              <dt>Judge model</dt>
              <dd>{explanation.models.judgeModel ?? "-"}</dd>
            </div>
            <div>
              <dt>Candidate models</dt>
              <dd>
                <EvidenceList items={explanation.models.candidateModels} />
              </dd>
            </div>
            <div>
              <dt>Selected candidate</dt>
              <dd>{explanation.models.selectedCandidate ?? "-"}</dd>
            </div>
            <div>
              <dt>Attempts</dt>
              <dd>{explanation.models.attempts ?? "-"}</dd>
            </div>
          </dl>
        </div>
      </div>
    </Section>
  );
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
