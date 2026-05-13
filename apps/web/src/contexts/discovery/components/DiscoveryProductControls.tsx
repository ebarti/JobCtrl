import type {
  DiscoveryFeedbackKind,
  ManualCaptureListResponse,
  QuarantineListResponse,
  SourceRegistryEntrySummary,
} from "@jobhunter/contracts";
import {
  AlertTriangle,
  Ban,
  Check,
  ExternalLink,
  Plus,
  ThumbsUp,
  Upload,
  X,
} from "lucide-react";
import { type FormEvent, useState } from "react";

import {
  useDiscoveryQuarantineQuery,
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
  useUpsertDiscoverySourceMutation,
} from "../hooks/useDiscoveryProductControlMutations.js";

type QuarantineEntry = QuarantineListResponse["entries"][number];
type ManualCaptureItem = ManualCaptureListResponse["items"][number];

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

export function DiscoveryProductControls() {
  const sources = useSourceRegistryQuery();
  const locatorCandidates = useSourceLocatorCandidatesQuery();
  const quarantine = useDiscoveryQuarantineQuery();
  const manualCapture = useManualCaptureQueueQuery();
  const sourceCount = sources.data?.sources.length ?? 0;
  const quarantineCount = quarantine.data?.entries.length ?? 0;
  const manualCount = manualCapture.data?.items.length ?? 0;
  const candidateCount = locatorCandidates.data?.candidates.length ?? 0;
  const error = sources.error ?? quarantine.error ?? manualCapture.error ?? locatorCandidates.error;
  const message = error instanceof Error ? error.message : null;

  return (
    <section className="card full discovery-controls">
      <CardHeader
        title="Discovery controls"
        meta={`${sourceCount} sources · ${candidateCount} candidates · ${quarantineCount + manualCount} review`}
      />
      {message ? <div className="banner inline">{message}</div> : null}
      <div className="discovery-control-grid">
        <SourceRegistryPanel sources={sources.data?.sources ?? []} loading={sources.isLoading} />
        <QuarantinePanel entries={quarantine.data?.entries ?? []} loading={quarantine.isLoading} />
        <ManualCapturePanel items={manualCapture.data?.items ?? []} loading={manualCapture.isLoading} />
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
  const [sourceId, setSourceId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [kind, setKind] = useState<(typeof SOURCE_KINDS)[number]>("employer_careers_page");
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
          <input value={sourceId} onChange={(event) => setSourceId(event.target.value)} required />
        </label>
        <label className="field">
          <span>Name</span>
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
        </label>
        <label className="field">
          <span>Kind</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as (typeof SOURCE_KINDS)[number])}
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
        <Button type="submit" size="sm" disabled={upsert.isPending || !sourceId.trim() || !displayName.trim()}>
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
            <span className={`tag ${source.recommendedState === "quarantined" ? "danger" : "info"}`}>
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
                    body: { state: "active", reason: "User enabled source from product controls." },
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
                disabled={patchState.isPending || source.state === "quarantined"}
                onClick={() =>
                  patchState.mutate({
                    sourceId: source.sourceId,
                    body: { state: "quarantined", reason: "User quarantined source from product controls." },
                  })
                }
              >
                <Ban size={14} aria-hidden="true" />
              </Button>
            </div>
          </div>
        ))}
        {!sources.length ? <Empty title={loading ? "Loading sources." : "No sources registered."} /> : null}
      </div>
    </div>
  );
}

function QuarantinePanel({ entries, loading }: { entries: QuarantineEntry[]; loading: boolean }) {
  const decision = useDiscoveryQuarantineDecisionMutation();
  const feedback = useDiscoveryFeedbackMutation();

  const sendFeedback = (entry: QuarantineEntry, kind: DiscoveryFeedbackKind) => {
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
                {entry.company || "Unknown company"} · {label(entry.reason)} · confidence{" "}
                {entry.confidence === null ? "n/a" : Math.round(entry.confidence * 100)}
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
                  decision.mutate({ jobKey: entry.jobKey, body: { decision: "approve" } })
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
                onClick={() => decision.mutate({ jobKey: entry.jobKey, body: { decision: "reject" } })}
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
          <Empty title={loading ? "Loading quarantined leads." : "No quarantined leads."} />
        ) : null}
      </div>
    </div>
  );
}

function ManualCapturePanel({ items, loading }: { items: ManualCaptureItem[]; loading: boolean }) {
  const importCapture = useManualCaptureImportMutation();
  const dismiss = useManualCaptureDismissMutation();
  return (
    <div className="discovery-control-panel">
      <div className="discovery-panel-head">
        <h3>Manual capture</h3>
        <span className="meta">{items.length} pending</span>
      </div>
      <div className="rows compact">
        {items.map((item) => (
          <div className="discovery-review-row" key={item.itemId}>
            <ExternalLink size={16} aria-hidden="true" />
            <span className="title-stack">
              <b>{item.sourceId ?? "Unassigned source"}</b>
              <span>
                {label(item.reason)} · <span className="mono">{item.originatingUrl}</span>
              </span>
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
                aria-label={`Import ${item.originatingUrl}`}
                title="Import copied URL"
                disabled={importCapture.isPending}
                onClick={() =>
                  importCapture.mutate({
                    itemId: item.itemId,
                    body: {
                      captureMode: "copied_url",
                      capturedUrl: item.originatingUrl,
                      futureManualActionRequired: false,
                    },
                  })
                }
              >
                <Upload size={14} aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Dismiss ${item.originatingUrl}`}
                title="Dismiss"
                disabled={dismiss.isPending}
                onClick={() => dismiss.mutate(item.itemId)}
              >
                <X size={14} aria-hidden="true" />
              </Button>
            </div>
          </div>
        ))}
        {!items.length ? <Empty title={loading ? "Loading manual queue." : "No manual captures."} /> : null}
      </div>
    </div>
  );
}
