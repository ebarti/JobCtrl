import type { ApplyAuditFact, ApplyAuditSource, ApplyReviewQueueItem } from "@jobhunter/contracts";
import { IconExternalLink } from "@tabler/icons-react";
import { useEffect, useState } from "react";

import { ACTIVE_APPLY_RUN_STATUSES, CancelApplyButton } from "../../contexts/apply/components/CancelApplyButton.js";
import { ApplyReviewDecisionControls } from "../../contexts/apply/components/ApplyReviewDecisionControls.js";
import { ArtifactTailoringInspector } from "../../contexts/materials/components/ArtifactTailoringInspector.js";
import { ResumeAuditPins } from "../../contexts/materials/components/ResumeAuditPins.js";
import { useApplyReviewQueueQuery } from "../../contexts/operations/hooks/useApplyReviewQueueQuery.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { Empty } from "../../shared/ui/empty.js";
import { MarkdownDocument } from "../../shared/ui/MarkdownDocument.js";
import { PdfPreviewViewer } from "../../shared/ui/PdfPreviewViewer.js";
import { JobDetailDrawer } from "../jobs/JobDetailDrawer.js";

type MaterialStatus = {
  readonly kind: ApplyReviewQueueItem["applyAudit"]["state"];
  readonly label: string;
  readonly tone: "ok" | "info" | "warn";
  readonly summary: string;
};

type ApplyRun = NonNullable<ApplyReviewQueueItem["latestApplyRun"]>;

function materialStatus(item: ApplyReviewQueueItem): MaterialStatus {
  return {
    kind: item.applyAudit.state,
    label: item.applyAudit.label,
    tone: auditTone(item.applyAudit.state),
    summary: item.applyAudit.summary,
  };
}

function auditTone(state: ApplyReviewQueueItem["applyAudit"]["state"]): MaterialStatus["tone"] {
  if (state === "ready") return "ok";
  if (state === "preparing") return "info";
  return "warn";
}

function latestApplyContext(item: ApplyReviewQueueItem): string {
  const run = item.latestApplyRun;
  if (!run) {
    return "No apply run yet.";
  }
  const mode = run.dryRun ? "Dry run" : "Submit";
  const timestamp = run.startedAt ? ` · ${formatDateTime(run.startedAt)}` : "";
  const reason = cleanRepairReason(run.result);
  if (isFailedApplyRun(run)) {
    return `${mode} failed${reason ? `: ${reason}` : ""}${timestamp}`;
  }
  const status = `${run.status} ${run.result ?? ""}`.toLowerCase();
  if (status.includes("running")) {
    return `${mode} running${timestamp}`;
  }
  if (status.includes("queued") || status.includes("pending")) {
    return `${mode} queued${timestamp}`;
  }
  if (status.includes("succeeded") || status.includes("complete")) {
    return `${mode} completed${timestamp}`;
  }
  return `${mode} recorded${timestamp}`;
}

function isFailedApplyRun(run: ApplyRun): boolean {
  const status = `${run.status} ${run.result ?? ""}`.toLowerCase();
  return status.includes("failed") || status.includes("skipped");
}

function cleanRepairReason(value: string | null | undefined): string | null {
  const text = String(value ?? "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(blocked|failed|skipped|error)\s*:\s*/i, "");
  if (!text || /^(blocked|failed|stale|error)$/i.test(text)) {
    return null;
  }
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function selectedItem(items: readonly ApplyReviewQueueItem[], selectedJobKey: string | null) {
  return items.find((item) => item.jobKey === selectedJobKey) ?? items[0] ?? null;
}

function reviewStateLabel(item: ApplyReviewQueueItem): string | null {
  if (item.review.state === "pending") {
    return null;
  }
  const decidedAt = item.review.decidedAt ? ` · ${formatDateTime(item.review.decidedAt)}` : "";
  switch (item.review.state) {
    case "approved_submit":
      return `Approved for submit${decidedAt}`;
    case "approved_dry_run":
      return `Approved for dry run${decidedAt}`;
    case "deferred":
      return `Deferred${decidedAt}`;
    case "declined":
      return `Declined${decidedAt}`;
    default:
      return null;
  }
}

function activeApplyRun(item: ApplyReviewQueueItem): ApplyRun | null {
  const run = item.latestApplyRun;
  if (!run || !ACTIVE_APPLY_RUN_STATUSES.has(run.status)) {
    return null;
  }
  return run;
}

function evidenceValues(item: ApplyReviewQueueItem): Array<{ label: string; values: readonly string[] }> {
  return [
    { label: "Matched", values: item.position.matched },
    { label: "Missing", values: item.position.missing },
    { label: "Transferable", values: item.position.transferable },
    { label: "Keywords", values: item.position.keywords },
  ].filter((group) => group.values.length > 0);
}

function sourceFacts(item: ApplyReviewQueueItem): ApplyAuditFact[] {
  return item.applyAudit.sources
    .filter(isInspectableSource)
    .map((source) => ({
      code: `source_${source.kind}`,
      label: source.label,
      detail: sourceDetail(source),
      severity: source.status === "unknown" ? "unknown" : "warning",
      source: source.kind,
    }));
}

function isInspectableSource(source: ApplyAuditSource): boolean {
  if (source.status === "unknown") {
    return true;
  }
  return source.status === "missing" && (
    source.kind === "application_url" ||
    source.kind === "materials.resume" ||
    source.kind === "materials.pdf"
  );
}

function sourceDetail(source: ApplyAuditSource): string {
  const status = source.status.replace(/_/g, " ");
  return source.detail ? `${status}: ${source.detail}` : status;
}

function ApplyAuditFacts({ item }: { readonly item: ApplyReviewQueueItem }) {
  const groups = [
    { label: "Missing", facts: item.applyAudit.missingPrerequisites },
    { label: "Blockers", facts: item.applyAudit.hardBlockers },
    { label: "Eligibility", facts: item.applyAudit.eligibilityConcerns },
    { label: "Sources", facts: sourceFacts(item) },
  ].filter((group) => group.facts.length > 0);

  if (!groups.length) {
    return null;
  }

  return (
    <dl className="apply-review-audit-facts">
      {groups.map((group) => (
        <div key={group.label}>
          <dt>{group.label}</dt>
          <dd>
            {group.facts.map((fact) => (
              <span className={`tag ${factTone(fact)}`} key={`${group.label}:${fact.code}:${fact.detail ?? ""}`}>
                {fact.detail ? `${fact.label}: ${fact.detail}` : fact.label}
              </span>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function factTone(fact: ApplyAuditFact): "muted" | "info" | "ok" | "warn" {
  if (fact.severity === "unknown") {
    return "muted";
  }
  if (fact.severity === "success") {
    return "ok";
  }
  if (fact.severity === "info") {
    return "info";
  }
  return "warn";
}

function ApplyReviewQueue({
  items,
  selected,
  onSelect,
}: {
  readonly items: readonly ApplyReviewQueueItem[];
  readonly selected: ApplyReviewQueueItem;
  readonly onSelect: (jobKey: string) => void;
}) {
  return (
    <aside className="apply-review-queue" aria-label="Application review queue">
      <div className="apply-review-queue-head">
        <span className="eyebrow">Queue</span>
        <b>{items.length} human decision{items.length === 1 ? "" : "s"}</b>
      </div>
      <div className="apply-review-queue-list">
        {items.map((item) => {
          const status = materialStatus(item);
          return (
            <button
              key={item.jobKey}
              type="button"
              className={`apply-review-queue-item${item.jobKey === selected.jobKey ? " selected" : ""}`}
              aria-pressed={item.jobKey === selected.jobKey}
              onClick={() => onSelect(item.jobKey)}
            >
              <span className="apply-review-queue-title">
                <span className="tag ok">{item.fitScore ?? "-"}</span>
                <b>{item.title}</b>
              </span>
              <span className="meta">
                {item.company} · {item.source}
              </span>
              <span className={`tag ${status.tone}`}>{status.label}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function RequirementEvidence({ item }: { readonly item: ApplyReviewQueueItem }) {
  const groups = evidenceValues(item);
  if (!groups.length) {
    return <Empty title="No scoring requirement evidence captured yet." />;
  }
  return (
    <dl className="apply-review-evidence-list">
      {groups.map((group) => (
        <div key={group.label}>
          <dt>{group.label}</dt>
          <dd>
            {group.values.map((value) => (
              <span className="tag muted" key={value}>
                {value}
              </span>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function TextPreview({
  title,
  text,
  emptyTitle,
}: {
  readonly title: string;
  readonly text: string | null;
  readonly emptyTitle: string;
}) {
  return (
    <section className="apply-review-preview-block">
      <h3>{title}</h3>
      {text ? <div className="apply-review-document preformatted">{text}</div> : <Empty title={emptyTitle} />}
    </section>
  );
}

function ResumePreview({ item }: { readonly item: ApplyReviewQueueItem }) {
  const { api } = usePorts();
  const artifactId = item.materialsPreview.resumePdfArtifactId;
  if (!artifactId) {
    return (
      <TextPreview
        title="Tailored resume"
        text={item.materialsPreview.resumeText}
        emptyTitle="Resume text is still being prepared."
      />
    );
  }
  return (
    <section className="apply-review-preview-block apply-review-pdf-preview">
      <h3>Tailored resume</h3>
      <PdfPreviewViewer
        cacheKey={`${artifactId}:${item.jobKey}`}
        loadingMessage="The tailored resume PDF is loading into the in-app preview."
        loadingTitle="Rendering tailored resume."
        openLabel="open PDF"
        pageAltPrefix={`${item.title} tailored resume`}
        title="Tailored resume PDF"
        url={api.artifactPreviewPdfUrl(artifactId, `${artifactId}:${item.jobKey}`)}
      />
    </section>
  );
}

function ResumeReviewSurface({ item }: { readonly item: ApplyReviewQueueItem }) {
  const artifactId = item.materialsPreview.resumePdfArtifactId;
  return (
    <section className="apply-review-preview-block apply-review-resume-review" aria-label="Rendered resume audit">
      <div className="apply-review-resume-main">
        <ResumePreview item={item} />
      </div>
      {artifactId ? (
        <ResumeAuditPins artifactId={artifactId} resumeText={item.materialsPreview.resumeText} />
      ) : (
        <section className="apply-review-resume-pins" aria-label="Line-by-line resume audit">
          <h3>Line-by-line resume audit</h3>
          <Empty title="No resume artifact is available for provenance inspection." />
        </section>
      )}
    </section>
  );
}

function SelectedReview({ item }: { readonly item: ApplyReviewQueueItem }) {
  const status = materialStatus(item);
  const evidenceGroups = evidenceValues(item).length;
  const reviewState = reviewStateLabel(item);
  const activeRun = activeApplyRun(item);
  const [detailJobKey, setDetailJobKey] = useState<string | null>(null);
  const resumePdfArtifactId = item.materialsPreview.resumePdfArtifactId;

  useEffect(() => {
    setDetailJobKey(null);
  }, [item.jobKey]);

  return (
    <main className="apply-review-selected">
      <header className="apply-review-selected-head">
        <div className="title-stack">
          <span className="eyebrow">Selected application</span>
          <b>{item.title}</b>
          <span>
            {item.company} · score {item.fitScore ?? "-"} · {latestApplyContext(item)}
          </span>
        </div>
        <div className="apply-review-selected-actions">
          <span className={`tag ${status.tone}`}>{status.label}</span>
          <button
            aria-label={`Open job detail for ${item.title}`}
            className="tab"
            type="button"
            onClick={() => setDetailJobKey(item.jobKey)}
          >
            <IconExternalLink size={14} aria-hidden="true" />
            open job detail
          </button>
          {activeRun ? (
            <CancelApplyButton
              jobId={item.jobKey}
              runId={activeRun.runId}
              className="tab danger-action"
              label="stop apply"
              ariaLabel={`Stop apply run for ${item.title}`}
            />
          ) : null}
          <ApplyReviewDecisionControls item={item} />
        </div>
      </header>

      {detailJobKey ? (
        <JobDetailDrawer
          jobId={detailJobKey}
          onClose={() => setDetailJobKey(null)}
        />
      ) : null}

      <div className="apply-review-status-note">
        <b>{status.summary}</b>
        {reviewState ? <span>Current decision: {reviewState}.</span> : null}
        <ApplyAuditFacts item={item} />
      </div>

      <section className="apply-review-workspace" aria-label={`Review evidence for ${item.title}`}>
        <article className="apply-review-pane">
          <header>
            <span className="eyebrow">Job Position</span>
            <h2>Requirements and original post</h2>
          </header>
          <div className="apply-review-pane-scroll">
            <section className="apply-review-preview-block">
              <h3>Requirement evidence</h3>
              <p className="meta">
                Derived from existing scoring evidence for this v1 review workspace.
                {evidenceGroups ? ` ${evidenceGroups} evidence group${evidenceGroups === 1 ? "" : "s"} available.` : ""}
              </p>
              <RequirementEvidence item={item} />
            </section>
            <section className="apply-review-preview-block">
              <h3>Verbatim job post</h3>
              {item.position.descriptionPreview ? (
                <div className="apply-review-document">
                  <MarkdownDocument
                    emptyTitle="No captured job post text."
                    text={item.position.descriptionPreview}
                  />
                </div>
              ) : (
                <Empty title="No captured job post text." />
              )}
            </section>
          </div>
        </article>

        <article className="apply-review-pane">
          <header>
            <span className="eyebrow">Application Materials</span>
            <h2>Tailored resume and cover</h2>
          </header>
          <div className="apply-review-pane-scroll apply-review-materials-scroll">
            <ResumeReviewSurface item={item} />
            {resumePdfArtifactId ? (
              <ArtifactTailoringInspector
                artifactId={resumePdfArtifactId}
                className="apply-review-preview-block apply-review-tailoring"
              />
            ) : null}
            <TextPreview
              title="Cover letter"
              text={item.materialsPreview.coverLetterText}
              emptyTitle="No cover letter is required or available for this job."
            />
          </div>
        </article>
      </section>
    </main>
  );
}

export function ApplyReviewView() {
  const queue = useApplyReviewQueueQuery();
  const queueError = queue.error instanceof Error ? queue.error.message : null;
  const items = queue.data?.items ?? [];
  const [selectedJobKey, setSelectedJobKey] = useState<string | null>(null);
  const selected = selectedItem(items, selectedJobKey);

  useEffect(() => {
    if (!items.length) {
      setSelectedJobKey(null);
      return;
    }
    if (!selectedJobKey || !items.some((item) => item.jobKey === selectedJobKey)) {
      setSelectedJobKey(items[0]?.jobKey ?? null);
    }
  }, [items, selectedJobKey]);

  const statuses = items.map(materialStatus);
  const readyCount = statuses.filter((status) => status.kind === "ready").length;
  const preparingCount = statuses.filter((status) => status.kind === "preparing").length;
  const repairCount = statuses.filter((status) => status.kind === "repair" || status.kind === "blocked").length;

  return (
    <div className="apply-review-layout">
      <section className="card full">
        <CardHeader
          title="Application review"
          meta={`${readyCount} ready · ${preparingCount} preparing · ${repairCount} need repair`}
        />
        {queueError ? <div className="banner inline">{queueError}</div> : null}
        {queue.isFetching && !queue.data ? <Empty title="Loading review queue." /> : null}
        {queue.data && selected ? (
          <div className="apply-review-shell">
            <ApplyReviewQueue items={items} selected={selected} onSelect={setSelectedJobKey} />
            <SelectedReview item={selected} />
          </div>
        ) : null}
        {queue.data && !items.length ? <Empty title="No application review items." /> : null}
      </section>
    </div>
  );
}
