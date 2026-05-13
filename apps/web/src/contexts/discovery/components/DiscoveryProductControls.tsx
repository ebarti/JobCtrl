import type {
  DiscoveryFeedbackKind,
  DiscoveryPreviewResponse,
  ManualCaptureImportRequest,
  ManualCaptureListResponse,
  QuarantineListResponse,
  SourceLocatorListResponse,
  SourceRegistryEntrySummary,
} from "@jobhunter/contracts";
import {
  AlertTriangle,
  Ban,
  Check,
  ExternalLink,
  Eye,
  Plus,
  ThumbsUp,
  Upload,
  X,
} from "lucide-react";
import { type FormEvent, useState } from "react";

import {
  useDiscoveryQuarantineQuery,
  useDiscoverySourcePreviewQuery,
  useManualCaptureQueueQuery,
  useSourceLocatorCandidatesQuery,
  useSourceRegistryQuery,
} from "../../operations/hooks/useDiscoveryProductControlsQuery.js";
import { Button } from "../../../shared/ui/button.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";
import { StatusDot } from "../../../shared/ui/status-dot.js";
import {
  useDiscoveryFeedbackMutation,
  useDiscoveryQuarantineDecisionMutation,
  useManualCaptureDismissMutation,
  useManualCaptureImportMutation,
  usePatchDiscoverySourceStateMutation,
  usePromoteSourceLocatorCandidateMutation,
  useRejectSourceLocatorCandidateMutation,
  useUpsertDiscoverySourceMutation,
} from "../hooks/useDiscoveryProductControlMutations.js";

type QuarantineEntry = QuarantineListResponse["entries"][number];
type ManualCaptureItem = ManualCaptureListResponse["items"][number];
type LocatorCandidate = SourceLocatorListResponse["candidates"][number];
type PreviewLead = DiscoveryPreviewResponse["leads"][number];

const SOURCE_KINDS = [
  "ats_api",
  "employer_careers_page",
  "official_api",
  "licensed_feed",
  "niche_board",
  "broad_board",
  "smart_extract",
  "user_mediated_capture",
] as const;

const CAPTURE_MODES: Array<{
  value: ManualCaptureImportRequest["captureMode"];
  label: string;
}> = [
  { value: "copied_url", label: "Copied URL" },
  { value: "current_page", label: "Current page" },
  { value: "saved_html", label: "Saved HTML" },
  { value: "pasted_text", label: "Pasted text" },
  { value: "email_import", label: "Email import" },
];

function pct(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

function dotState(state: string): string {
  if (state === "disabled" || state === "quarantined") return "failed";
  if (state === "experimental") return "running";
  return "succeeded";
}

function label(value: string): string {
  return value.replaceAll("_", " ");
}

function sourceMeta(source: SourceRegistryEntrySummary): string {
  return [
    `${source.kind.replaceAll("_", " ")}`,
    `${source.priority}`,
    `active ${pct(source.activeVerificationRate)}`,
    `detail ${pct(source.fullDescriptionSuccessRate)}`,
    `duplicate ${pct(source.duplicateRate)}`,
  ].join(" · ");
}

function candidateEvidence(candidate: LocatorCandidate): string {
  return [
    candidate.employerDomainMatched ? "domain matched" : "domain unverified",
    candidate.manualActionReason
      ? `manual ${label(candidate.manualActionReason)}`
      : "no manual blocker",
    `discovered ${new Date(candidate.discoveredAt).toLocaleDateString()}`,
  ].join(" · ");
}

export function DiscoveryProductControls() {
  const sources = useSourceRegistryQuery();
  const locatorCandidates = useSourceLocatorCandidatesQuery();
  const quarantine = useDiscoveryQuarantineQuery();
  const manualCapture = useManualCaptureQueueQuery();
  const sourceCount = sources.data?.sources.length ?? 0;
  const quarantineCount = quarantine.data?.entries.length ?? 0;
  const manualCount = manualCapture.data?.items.length ?? 0;
  const candidateCount = locatorCandidates.data?.candidates.length ?? 0;
  const error =
    sources.error ??
    quarantine.error ??
    manualCapture.error ??
    locatorCandidates.error;
  const message = error instanceof Error ? error.message : null;

  return (
    <section className="card full discovery-controls">
      <CardHeader
        title="Discovery controls"
        meta={`${sourceCount} sources · ${candidateCount} candidates · ${quarantineCount + manualCount} review`}
      />
      {message ? <div className="banner inline">{message}</div> : null}
      <div className="discovery-control-grid">
        <SourceRegistryPanel
          sources={sources.data?.sources ?? []}
          loading={sources.isLoading}
        />
        <SourceLocatorPanel
          candidates={locatorCandidates.data?.candidates ?? []}
          loading={locatorCandidates.isLoading}
        />
        <QuarantinePanel
          entries={quarantine.data?.entries ?? []}
          loading={quarantine.isLoading}
        />
        <ManualCapturePanel
          items={manualCapture.data?.items ?? []}
          loading={manualCapture.isLoading}
        />
      </div>
    </section>
  );
}

function SourceRegistryPanel({
  sources,
  loading,
}: {
  sources: SourceRegistryEntrySummary[];
  loading: boolean;
}) {
  const upsert = useUpsertDiscoverySourceMutation();
  const patchState = usePatchDiscoverySourceStateMutation();
  const [previewSourceId, setPreviewSourceId] = useState<string | null>(null);
  const preview = useDiscoverySourcePreviewQuery(previewSourceId);
  const [sourceId, setSourceId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [kind, setKind] = useState<(typeof SOURCE_KINDS)[number]>(
    "employer_careers_page",
  );
  const [seedUrl, setSeedUrl] = useState("");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    upsert.mutate({
      sourceId: sourceId.trim(),
      displayName: displayName.trim(),
      kind,
      priority: "standard",
      state: "experimental",
      ...(seedUrl.trim() ? { seedUrl: seedUrl.trim() } : {}),
    });
    setSourceId("");
    setDisplayName("");
    setSeedUrl("");
  };

  return (
    <div className="discovery-control-panel">
      <div className="discovery-panel-head">
        <h3>Source registry</h3>
        <span className="meta">{sources.length} total</span>
      </div>
      <form className="source-upsert-form" onSubmit={submit}>
        <label className="field">
          <span>Source id</span>
          <input
            value={sourceId}
            onChange={(event) => setSourceId(event.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Name</span>
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Kind</span>
          <select
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as (typeof SOURCE_KINDS)[number])
            }
          >
            {SOURCE_KINDS.map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </select>
        </label>
        <label className="field wide">
          <span>Seed URL</span>
          <input
            type="url"
            value={seedUrl}
            onChange={(event) => setSeedUrl(event.target.value)}
            placeholder="https://example.com/careers"
          />
        </label>
        <Button
          type="submit"
          size="sm"
          disabled={upsert.isPending || !sourceId.trim() || !displayName.trim()}
        >
          <Plus size={14} aria-hidden="true" />
          Add source
        </Button>
      </form>
      <div className="rows compact">
        {sources.map((source) => (
          <div className="discovery-source-row" key={source.sourceId}>
            <StatusDot state={dotState(source.state)} />
            <span className="title-stack">
              <b>{source.displayName}</b>
              <span>{sourceMeta(source)}</span>
            </span>
            <span
              className={`tag ${source.recommendedState === "quarantined" ? "danger" : "info"}`}
            >
              {label(source.state)}
            </span>
            <div className="row-actions">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Activate ${source.displayName}`}
                title="Activate source"
                disabled={patchState.isPending || source.state === "active"}
                onClick={() =>
                  patchState.mutate({
                    sourceId: source.sourceId,
                    body: {
                      state: "active",
                      reason: "User enabled source from product controls.",
                    },
                  })
                }
              >
                <Check size={14} aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Quarantine ${source.displayName}`}
                title="Quarantine source"
                disabled={
                  patchState.isPending || source.state === "quarantined"
                }
                onClick={() =>
                  patchState.mutate({
                    sourceId: source.sourceId,
                    body: {
                      state: "quarantined",
                      reason: "User quarantined source from product controls.",
                    },
                  })
                }
              >
                <Ban size={14} aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Preview ${source.displayName}`}
                title="Preview observed leads"
                disabled={
                  preview.isFetching && previewSourceId === source.sourceId
                }
                onClick={() => setPreviewSourceId(source.sourceId)}
              >
                <Eye size={14} aria-hidden="true" />
              </Button>
            </div>
          </div>
        ))}
        {!sources.length ? (
          <Empty
            title={loading ? "Loading sources." : "No sources registered."}
          />
        ) : null}
      </div>
      {previewSourceId ? (
        <SourcePreview
          sourceId={previewSourceId}
          leads={preview.data?.leads ?? []}
          loading={preview.isLoading || preview.isFetching}
        />
      ) : null}
    </div>
  );
}

function SourcePreview({
  sourceId,
  leads,
  loading,
}: {
  sourceId: string;
  leads: PreviewLead[];
  loading: boolean;
}) {
  return (
    <div className="discovery-source-preview">
      <div className="discovery-panel-head compact">
        <h3>Preview</h3>
        <span className="meta">{sourceId}</span>
      </div>
      <div className="rows compact">
        {leads.map((lead) => (
          <div className="discovery-preview-row" key={lead.candidateUrl}>
            <span className="title-stack">
              <b>{lead.title || lead.candidateUrl}</b>
              <span>
                {lead.company || "Unknown company"} ·{" "}
                {lead.location || "Unknown location"} · confidence{" "}
                {pct(lead.estimatedConfidence)}
              </span>
              <span className="mono">{lead.candidateUrl}</span>
            </span>
          </div>
        ))}
        {!leads.length ? (
          <Empty
            title={
              loading
                ? "Loading source preview."
                : "No observed leads for this source."
            }
          />
        ) : null}
      </div>
    </div>
  );
}

function SourceLocatorPanel({
  candidates,
  loading,
}: {
  candidates: LocatorCandidate[];
  loading: boolean;
}) {
  const promote = usePromoteSourceLocatorCandidateMutation();
  const reject = useRejectSourceLocatorCandidateMutation();

  return (
    <div className="discovery-control-panel">
      <div className="discovery-panel-head">
        <h3>Source locator</h3>
        <span className="meta">{candidates.length} candidates</span>
      </div>
      <div className="rows compact">
        {candidates.map((candidate) => (
          <div className="discovery-review-row" key={candidate.candidateId}>
            <ExternalLink size={16} aria-hidden="true" />
            <span className="title-stack">
              <b>{candidate.candidateUrl}</b>
              <span>
                {label(candidate.sourceKind)} · confidence{" "}
                {pct(candidate.confidence)} ·{" "}
                {candidate.detectedAtsKind
                  ? `${candidate.detectedAtsKind} detected`
                  : "ATS unknown"}
              </span>
              <span>{candidateEvidence(candidate)}</span>
            </span>
            <div className="row-actions">
              <Button
                size="icon"
                variant="ghost"
                asChild
                title="Open candidate"
              >
                <a
                  aria-label={`Open ${candidate.candidateUrl}`}
                  href={candidate.candidateUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Promote ${candidate.candidateUrl}`}
                title="Promote candidate"
                disabled={promote.isPending || reject.isPending}
                onClick={() =>
                  promote.mutate({
                    candidateId: candidate.candidateId,
                    body: {
                      reason:
                        "User promoted source locator candidate from product controls.",
                    },
                  })
                }
              >
                <Check size={14} aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Reject ${candidate.candidateUrl}`}
                title="Reject candidate"
                disabled={promote.isPending || reject.isPending}
                onClick={() =>
                  reject.mutate({
                    candidateId: candidate.candidateId,
                    body: {
                      reason:
                        "User rejected source locator candidate from product controls.",
                    },
                  })
                }
              >
                <X size={14} aria-hidden="true" />
              </Button>
            </div>
          </div>
        ))}
        {!candidates.length ? (
          <Empty
            title={
              loading ? "Loading locator candidates." : "No source candidates."
            }
          />
        ) : null}
      </div>
    </div>
  );
}

function QuarantinePanel({
  entries,
  loading,
}: {
  entries: QuarantineEntry[];
  loading: boolean;
}) {
  const decision = useDiscoveryQuarantineDecisionMutation();
  const feedback = useDiscoveryFeedbackMutation();

  const sendFeedback = (
    entry: QuarantineEntry,
    kind: DiscoveryFeedbackKind,
  ) => {
    feedback.mutate({ jobKey: entry.jobKey, sourceId: entry.sourceId, kind });
  };

  return (
    <div className="discovery-control-panel">
      <div className="discovery-panel-head">
        <h3>Quarantine review</h3>
        <span className="meta">{entries.length} pending</span>
      </div>
      <div className="rows compact">
        {entries.map((entry) => (
          <div className="discovery-review-row" key={entry.jobKey}>
            <AlertTriangle size={16} aria-hidden="true" />
            <span className="title-stack">
              <b>{entry.title || entry.jobKey}</b>
              <span>
                {entry.company || "Unknown company"} · {label(entry.reason)} ·
                confidence{" "}
                {entry.confidence === null
                  ? "n/a"
                  : Math.round(entry.confidence * 100)}
              </span>
            </span>
            <div className="row-actions">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Approve ${entry.title || entry.jobKey}`}
                title="Approve"
                disabled={decision.isPending}
                onClick={() =>
                  decision.mutate({
                    jobKey: entry.jobKey,
                    body: { decision: "approve" },
                  })
                }
              >
                <Check size={14} aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Reject ${entry.title || entry.jobKey}`}
                title="Reject"
                disabled={decision.isPending}
                onClick={() =>
                  decision.mutate({
                    jobKey: entry.jobKey,
                    body: { decision: "reject" },
                  })
                }
              >
                <X size={14} aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Mark ${entry.title || entry.jobKey} as stale`}
                title="Mark stale"
                disabled={feedback.isPending}
                onClick={() => sendFeedback(entry, "stale")}
              >
                <Ban size={14} aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Mark source ${entry.sourceId} useful`}
                title="Useful source"
                disabled={feedback.isPending}
                onClick={() => sendFeedback(entry, "useful")}
              >
                <ThumbsUp size={14} aria-hidden="true" />
              </Button>
            </div>
          </div>
        ))}
        {!entries.length ? (
          <Empty
            title={
              loading ? "Loading quarantined leads." : "No quarantined leads."
            }
          />
        ) : null}
      </div>
    </div>
  );
}

function ManualCapturePanel({
  items,
  loading,
}: {
  items: ManualCaptureItem[];
  loading: boolean;
}) {
  const importCapture = useManualCaptureImportMutation();
  const dismiss = useManualCaptureDismissMutation();

  const importItem = (itemId: string, body: ManualCaptureImportRequest) => {
    importCapture.mutate({ itemId, body });
  };

  return (
    <div className="discovery-control-panel">
      <div className="discovery-panel-head">
        <h3>Manual capture</h3>
        <span className="meta">{items.length} pending</span>
      </div>
      <div className="rows compact">
        {items.map((item) => (
          <ManualCaptureRow
            key={item.itemId}
            item={item}
            importing={importCapture.isPending}
            dismissing={dismiss.isPending}
            onImport={importItem}
            onDismiss={(itemId) => dismiss.mutate(itemId)}
          />
        ))}
        {!items.length ? (
          <Empty
            title={loading ? "Loading manual queue." : "No manual captures."}
          />
        ) : null}
      </div>
    </div>
  );
}

function ManualCaptureRow({
  item,
  importing,
  dismissing,
  onImport,
  onDismiss,
}: {
  item: ManualCaptureItem;
  importing: boolean;
  dismissing: boolean;
  onImport: (itemId: string, body: ManualCaptureImportRequest) => void;
  onDismiss: (itemId: string) => void;
}) {
  const [captureMode, setCaptureMode] =
    useState<ManualCaptureImportRequest["captureMode"]>("copied_url");
  const [capturedUrl, setCapturedUrl] = useState(item.originatingUrl);
  const [content, setContent] = useState("");
  const [note, setNote] = useState("");
  const [futureManualActionRequired, setFutureManualActionRequired] =
    useState(false);
  const contentRequired = requiresContent(captureMode);
  const urlRequired =
    captureMode === "copied_url" || captureMode === "current_page";
  const contentLabel = manualCaptureContentLabel(captureMode);
  const canImport =
    (!urlRequired || capturedUrl.trim().length > 0) &&
    (!contentRequired || content.trim().length > 0);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canImport) return;
    onImport(
      item.itemId,
      buildManualCapturePayload({
        captureMode,
        capturedUrl,
        content,
        note,
        futureManualActionRequired,
      }),
    );
  };

  return (
    <div className="discovery-review-row manual-capture-row">
      <ExternalLink size={16} aria-hidden="true" />
      <span className="title-stack manual-capture-body">
        <b>{item.sourceId ?? "Unassigned source"}</b>
        <span>
          {label(item.reason)} ·{" "}
          <span className="mono">{item.originatingUrl}</span>
        </span>
        <form className="manual-capture-form" onSubmit={submit}>
          <label className="field">
            <span>Capture mode</span>
            <select
              value={captureMode}
              onChange={(event) =>
                setCaptureMode(
                  event.target
                    .value as ManualCaptureImportRequest["captureMode"],
                )
              }
            >
              {CAPTURE_MODES.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{urlRequired ? "Captured URL" : "Source URL"}</span>
            <input
              type="url"
              value={capturedUrl}
              onChange={(event) => setCapturedUrl(event.target.value)}
              required={urlRequired}
            />
          </label>
          {contentRequired ? (
            <label className="field wide">
              <span>{contentLabel}</span>
              <textarea
                value={content}
                onChange={(event) => setContent(event.target.value)}
                required
                rows={3}
              />
            </label>
          ) : null}
          <label className="field wide">
            <span>Note</span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <label className="checkline wide">
            <input
              type="checkbox"
              checked={futureManualActionRequired}
              onChange={(event) =>
                setFutureManualActionRequired(event.target.checked)
              }
            />
            <span>Needs manual follow-up</span>
          </label>
          <Button
            type="submit"
            size="sm"
            aria-label={`Import ${item.originatingUrl}`}
            disabled={importing || !canImport}
          >
            <Upload size={14} aria-hidden="true" />
            Import
          </Button>
        </form>
      </span>
      <div className="row-actions">
        <Button size="icon" variant="ghost" asChild title="Open page">
          <a
            aria-label={`Open ${item.originatingUrl}`}
            href={item.originatingUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={`Dismiss ${item.originatingUrl}`}
          title="Dismiss"
          disabled={dismissing}
          onClick={() => onDismiss(item.itemId)}
        >
          <X size={14} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

function requiresContent(
  captureMode: ManualCaptureImportRequest["captureMode"],
): boolean {
  return (
    captureMode === "saved_html" ||
    captureMode === "pasted_text" ||
    captureMode === "email_import"
  );
}

function manualCaptureContentLabel(
  captureMode: ManualCaptureImportRequest["captureMode"],
): string {
  if (captureMode === "saved_html") return "Saved HTML";
  if (captureMode === "email_import") return "Email content";
  return "Pasted text";
}

function buildManualCapturePayload(input: {
  captureMode: ManualCaptureImportRequest["captureMode"];
  capturedUrl: string;
  content: string;
  note: string;
  futureManualActionRequired: boolean;
}): ManualCaptureImportRequest {
  const payload: ManualCaptureImportRequest = {
    captureMode: input.captureMode,
    futureManualActionRequired: input.futureManualActionRequired,
  };
  const capturedUrl = input.capturedUrl.trim();
  const content = input.content.trim();
  const note = input.note.trim();
  if (capturedUrl) payload.capturedUrl = capturedUrl;
  if (note) payload.note = note;
  if (input.captureMode === "saved_html") {
    payload.contentHtmlBase64 = encodeUtf8Base64(content);
  } else if (requiresContent(input.captureMode)) {
    payload.contentText = content;
  }
  return payload;
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
