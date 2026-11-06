import type {
  DiscoveryFeedbackKind,
  ManualCaptureImportRequest,
  ManualCaptureListResponse,
  QuarantineListResponse,
  SourceRegistryEntrySummary,
} from "@jobctrl/contracts";
import { SourceUpsertRequestSchema } from "@jobctrl/contracts";
import type { SavedTableView } from "@jobctrl/contracts";
import {
  IconAlertTriangle,
  IconBan,
  IconCheck,
  IconExternalLink,
  IconEye,
  IconPlus,
  IconThumbUp,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
import { type FormEvent, useMemo, useState } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useDiscoverySettingsQuery } from "../hooks/useDiscoverySettingsQuery.js";
import {
  useDiscoveryQuarantineQuery,
  useDiscoverySourcePreviewQuery,
  useManualCaptureQueueQuery,
  useRoleMatchFeedbackQuery,
  useSourceLocatorCandidatesQuery,
  useSourceRegistryQuery,
} from "../hooks/useDiscoveryProductControlsQuery.js";
import { Button } from "../../../shared/ui/button.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { Checkbox } from "../../../shared/ui/checkbox.js";
import { Empty } from "../../../shared/ui/empty.js";
import { Field, FieldLabel } from "../../../shared/ui/field.js";
import {
  FilterableDataGrid,
  type DataGridColumn,
  type DataGridColumnVisibilityState,
  type DataGridColumnWidthsState,
  type DataGridFilterState,
  type DataGridSortState,
} from "../../../shared/ui/filterable-data-grid.js";
import {
  DISCOVERY_SOURCES_TABLE_ID,
  type SavedTablePresentation,
  type SavedTableViewSnapshot,
} from "../../../shared/stores/saved-table-views.js";
import {
  SavedTableViewsControl,
  type SavedTableColumnOption,
} from "../../../shared/ui/saved-table-views-control.js";
import { Input } from "../../../shared/ui/input.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../shared/ui/select.js";
import { StatusBadge } from "../../../shared/ui/status-badge.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import {
  SourcePolitenessBadges,
  hasPolitenessOutcomes,
  politenessOutcomeSummary,
} from "./SourcePolitenessBadges.js";
import { DiscoveryFeedbackRefresh } from "./DiscoveryFeedbackRefresh.js";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../../shared/ui/tabs.js";
import {
  type CaptureDraftEdits,
  type CaptureImportState,
  useDiscoveryFeedbackMutation,
  useDiscoveryQuarantineDecisionMutation,
  useManualCaptureDismissMutation,
  useManualCaptureImportMutation,
  usePatchDiscoverySourceStateMutation,
  usePromoteSourceLocatorCandidateMutation,
  useRejectSourceLocatorCandidateMutation,
  useResetSourceLocatorCandidateMutation,
  useRoleMatchFeedbackDecisionMutation,
  useUpsertDiscoverySourceMutation,
} from "../hooks/useDiscoveryProductControlMutations.js";

type QuarantineEntry = QuarantineListResponse["entries"][number];
type ManualCaptureItem = ManualCaptureListResponse["items"][number];
type LocatorCandidate = import("../contracts.js").LocatorCandidate;
type RoleMatchSuggestion = import("../contracts.js").RoleFeedback["suggestions"][number];
type PreviewLead = import("../contracts.js").DiscoveryPreview["leads"][number];
function sourceRevision(source: SourceRegistryEntrySummary): number | null {
  const revision = (source as SourceRegistryEntrySummary & { revision?: unknown }).revision;
  return typeof revision === "number" && Number.isInteger(revision) && revision > 0 ? revision : null;
}
type SourceMetricTone = "good" | "warn" | "bad" | "unknown";
type DiscoveryControlsLayout = "grid" | "tabs";
type SourceRegistryStateFilter = "all" | SourceRegistryEntrySummary["state"];

export interface DiscoverySourceTableControls {
  readonly filters: DataGridFilterState;
  readonly sort: DataGridSortState;
  readonly presentation: SavedTablePresentation;
  readonly onFiltersChange: (filters: DataGridFilterState) => void;
  readonly onSortChange: (sort: DataGridSortState) => void;
  readonly onPresentationChange: (presentation: SavedTablePresentation) => void;
  readonly onApplyView: (view: SavedTableView) => void;
}

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

function sourceStateTone(
  state: SourceRegistryEntrySummary["state"],
): "danger" | "info" | "muted" | "ok" | "warn" {
  switch (state) {
    case "active":
      return "ok";
    case "experimental":
      return "info";
    case "quarantined":
      return "warn";
    case "disabled":
      return "muted";
    default:
      return "muted";
  }
}

function label(value: string): string {
  return value.replaceAll("_", " ");
}

function titleCaseSourceName(value: string): string {
  return value
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) =>
      part.length <= 3 && part === part.toUpperCase()
        ? part
        : `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
    )
    .join(" ");
}

function sourceCompanyName(source: SourceRegistryEntrySummary): string {
  const rawName = source.displayName.trim();
  const rawSourceId = source.sourceId.split(":").at(1) ?? source.sourceId;
  if (rawName && !rawName.includes(".") && !rawName.includes("-"))
    return rawName;
  const candidate = rawName || rawSourceId;
  const withoutKnownHost = candidate
    .replace(/\.wd\d+\.myworkdayjobs\.com$/i, "")
    .replace(/\.myworkdayjobs\.com$/i, "")
    .replace(/\.greenhouse\.io$/i, "")
    .replace(/\.lever\.co$/i, "")
    .replace(/\.ashbyhq\.com$/i, "")
    .replace(/-wd\d+-myworkdayjobs-com$/i, "")
    .replace(/-myworkdayjobs-com$/i, "")
    .replace(/-greenhouse-io$/i, "")
    .replace(/-lever-co$/i, "")
    .replace(/-ashbyhq-com$/i, "");

  return titleCaseSourceName(withoutKnownHost || rawName || rawSourceId);
}

function sourceTypeLabel(source: SourceRegistryEntrySummary): string {
  const sourceId = source.sourceId.toLowerCase();
  const policyId = source.policyId.toLowerCase();
  if (sourceId.startsWith("workday:") || policyId.includes("workday"))
    return "Workday ATS";
  if (sourceId.startsWith("greenhouse:") || policyId.includes("greenhouse"))
    return "Greenhouse ATS";
  if (sourceId.startsWith("lever:") || policyId.includes("lever"))
    return "Lever ATS";
  if (sourceId.startsWith("ashby:") || policyId.includes("ashby"))
    return "Ashby ATS";
  if (sourceId.startsWith("jobspy:")) return "Broad board";
  if (sourceId.startsWith("smart_extract:")) return "Smart extract";
  if (source.kind === "ats_api") return "ATS API";
  if (source.kind === "employer_careers_page") return "Employer careers page";
  if (source.kind === "official_api") return "Official API";
  if (source.kind === "licensed_feed") return "Licensed feed";
  if (source.kind === "niche_board") return "Niche board";
  if (source.kind === "broad_board") return "Broad board";
  return "Manual capture";
}

function manualActionLabel(value: ManualCaptureItem["reason"]): string {
  switch (value) {
    case "captcha":
      return "CAPTCHA required";
    case "login_required":
      return "Sign-in required";
    case "paywall":
      return "Paywall";
    case "bot_detection":
      return "Bot protection";
    case "rate_limit":
      return "Rate limited";
    case "robots_disallowed":
      return "Blocked by robots.txt";
    case "protected_internal_site":
      return "Protected internal site";
    case "ambiguous_career_system":
      return "Unconfirmed careers page";
    case "browser_extension_capture":
      return "Browser extension capture";
    default:
      return "Manual capture required";
  }
}

function manualActionDetail(value: ManualCaptureItem["reason"]): string {
  switch (value) {
    case "captcha":
      return "The posting is visible only after a CAPTCHA challenge.";
    case "login_required":
      return "The posting is behind a sign-in step.";
    case "paywall":
      return "The posting is behind a paid or gated view.";
    case "bot_detection":
      return "The site blocked automated parsing.";
    case "rate_limit":
      return "The site temporarily limited repeated access.";
    case "robots_disallowed":
      return "The site does not permit JobCtrl to fetch this posting automatically.";
    case "protected_internal_site":
      return "The posting appears to be on a protected company or internal site.";
    case "ambiguous_career_system":
      return "The URL looks useful, but the app cannot confirm which careers system or parser should handle it yet.";
    case "browser_extension_capture":
      return "The user saved this posting from the browser extension.";
    default:
      return "A more specific reason was not recorded.";
  }
}

function sourceRegistryStats(sources: SourceRegistryEntrySummary[]) {
  return sources.reduce(
    (stats, source) => {
      if (source.state === "active") stats.active += 1;
      if (source.state !== "active") stats.inactive += 1;
      if (source.observedJobs > 0) stats.withObservedJobs += 1;
      stats.observedJobs += source.observedJobs;
      stats.newJobs += source.newJobs;
      return stats;
    },
    {
      active: 0,
      inactive: 0,
      withObservedJobs: 0,
      observedJobs: 0,
      newJobs: 0,
    },
  );
}

function sourceMetricTone(
  value: number | null,
  direction: "higher" | "lower",
): SourceMetricTone {
  if (value === null) return "unknown";
  if (direction === "higher") {
    if (value >= 0.8) return "good";
    if (value >= 0.5) return "warn";
    return "bad";
  }
  if (value <= 0.1) return "good";
  if (value <= 0.3) return "warn";
  return "bad";
}

function sourceMetricStatus(tone: SourceMetricTone): string {
  switch (tone) {
    case "good":
      return "healthy";
    case "warn":
      return "needs attention";
    case "bad":
      return "poor";
    case "unknown":
      return "no data";
  }
}

function sourceQualityMetrics(source: SourceRegistryEntrySummary) {
  return [
    {
      label: "Active",
      value: pct(source.activeVerificationRate),
      tone: sourceMetricTone(source.activeVerificationRate, "higher"),
    },
    {
      label: "Full text",
      value: pct(source.fullDescriptionSuccessRate),
      tone: sourceMetricTone(source.fullDescriptionSuccessRate, "higher"),
    },
    {
      label: "Apply URL",
      value: pct(source.applyUrlSuccessRate),
      tone: sourceMetricTone(source.applyUrlSuccessRate, "higher"),
    },
    {
      label: "Duplicate",
      value: pct(source.duplicateRate),
      tone: sourceMetricTone(source.duplicateRate, "lower"),
    },
  ];
}

function sourceQualityMetric(
  source: SourceRegistryEntrySummary,
  index: number,
): ReturnType<typeof sourceQualityMetrics>[number] {
  return (
    sourceQualityMetrics(source)[index] ?? {
      label: "Metric",
      value: "n/a",
      tone: "unknown",
    }
  );
}

function SourceMetricText({
  label: metricLabel,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: SourceMetricTone;
}) {
  return (
    <span
      className={`source-table-metric ${tone}`}
      data-typography="strong-body"
      aria-label={`${metricLabel}: ${value}, ${sourceMetricStatus(tone)}`}
      title={`${metricLabel}: ${value}, ${sourceMetricStatus(tone)}`}
    >
      {value}
    </span>
  );
}

function candidateEvidence(candidate: LocatorCandidate): string {
  return [
    candidate.employerDomainMatched ? "Domain matched" : "Domain not verified",
    candidate.manualActionReason
      ? `Manual review: ${manualActionLabel(candidate.manualActionReason)}`
      : "Awaiting your review",
    `discovered ${new Date(candidate.discoveredAt).toLocaleDateString()}`,
  ].join(" · ");
}

export function DiscoveryProductControls({
  layout = "grid",
  sourceTable,
}: {
  readonly layout?: DiscoveryControlsLayout;
  readonly sourceTable?: DiscoverySourceTableControls;
} = {}) {
  const sources = useSourceRegistryQuery();
  const locatorCandidates = useSourceLocatorCandidatesQuery();
  const quarantine = useDiscoveryQuarantineQuery();
  const manualCapture = useManualCaptureQueueQuery();
  const roleMatchFeedback = useRoleMatchFeedbackQuery();
  const sourceCount = sources.data ? String(sources.data.sources.length) : sources.isPending ? "loading" : "unavailable";
  const candidateCount = locatorCandidates.data ? String(locatorCandidates.data.candidates.length) : locatorCandidates.isPending ? "loading" : "unavailable";
  const pendingRoleSuggestionCount =
    roleMatchFeedback.data?.suggestions.filter(
      (suggestion) => suggestion.status === "pending",
    ).length ?? 0;
  const error =
    sources.error ??
    quarantine.error ??
    manualCapture.error ??
    locatorCandidates.error ??
    roleMatchFeedback.error;
  const message = error instanceof Error ? error.message : null;
  const reviewCount = quarantine.data && manualCapture.data && roleMatchFeedback.data
    ? String(quarantine.data.entries.length + manualCapture.data.items.length + pendingRoleSuggestionCount)
    : quarantine.isPending || manualCapture.isPending || roleMatchFeedback.isPending ? "loading" : "unavailable";
  const sourcePanel = sources.data || sources.isPending ? <SourceRegistryPanel defaultStateFilter={layout === "tabs" ? "active" : "all"} sources={sources.data?.sources ?? []} loading={sources.isLoading} {...(sourceTable ? { sourceTable } : {})} /> : <p role="alert">Source registry unavailable.</p>;
  const locatorPanel = locatorCandidates.data || locatorCandidates.isPending ? <SourceLocatorPanel candidates={locatorCandidates.data?.candidates ?? []} loading={locatorCandidates.isLoading} /> : <p role="alert">Source candidates unavailable.</p>;
  const quarantinePanel = quarantine.data || quarantine.isPending ? <QuarantinePanel entries={quarantine.data?.entries ?? []} loading={quarantine.isLoading} /> : <p role="alert">Quarantine unavailable.</p>;
  const feedbackPanel = roleMatchFeedback.data || roleMatchFeedback.isPending ? <RoleMatchFeedbackPanel suggestions={roleMatchFeedback.data?.suggestions ?? []} loading={roleMatchFeedback.isLoading} /> : <p role="alert">Role matching feedback unavailable.</p>;
  const capturePanel = manualCapture.data || manualCapture.isPending ? <ManualCapturePanel items={manualCapture.data?.items ?? []} loading={manualCapture.isLoading} /> : <p role="alert">Manual capture queue unavailable.</p>;

  return (
    <section className="card full discovery-controls">
      <CardHeader
        title="Discovery controls"
        meta={`${sourceCount} sources · ${candidateCount} candidates · ${reviewCount} review`}
      />
      {message ? <div className="banner inline" role="alert">{message} Previously loaded results remain visible where available.</div> : null}
      {layout === "tabs" ? (
        <Tabs defaultValue="sources" className="discovery-tabs">
          <TabsList aria-label="Discovery tools" className="discovery-tab-list">
            <TabsTrigger value="sources">Source registry</TabsTrigger>
            <TabsTrigger value="locator">Source locator</TabsTrigger>
            <TabsTrigger value="quarantine">Quarantine review</TabsTrigger>
            <TabsTrigger value="role-match">Role matching</TabsTrigger>
            <TabsTrigger value="manual">Manual capture</TabsTrigger>
          </TabsList>
          <TabsContent value="sources" className="discovery-tab-panel">
            {sourcePanel}
          </TabsContent>
          <TabsContent value="locator" className="discovery-tab-panel">
            {locatorPanel}
          </TabsContent>
          <TabsContent value="quarantine" className="discovery-tab-panel">
            {quarantinePanel}
          </TabsContent>
          <TabsContent value="role-match" className="discovery-tab-panel">
            {feedbackPanel}
          </TabsContent>
          <TabsContent value="manual" className="discovery-tab-panel" keepMounted>
            {capturePanel}
          </TabsContent>
        </Tabs>
      ) : (
        <div className="discovery-control-grid">
          {sourcePanel}
          {locatorPanel}
          {quarantinePanel}
          {feedbackPanel}
          {capturePanel}
        </div>
      )}
    </section>
  );
}

function SourceRegistryPanel({
  sources,
  loading,
  defaultStateFilter = "all",
  sourceTable,
}: {
  sources: SourceRegistryEntrySummary[];
  loading: boolean;
  defaultStateFilter?: SourceRegistryStateFilter;
  sourceTable?: DiscoverySourceTableControls;
}) {
  const { featureFlags } = usePorts();
  const isDemo = featureFlags.get("demoMode", false);
  const upsert = useUpsertDiscoverySourceMutation();
  const patchState = usePatchDiscoverySourceStateMutation();
  const [previewSourceId, setPreviewSourceId] = useState<string | null>(null);
  const preview = useDiscoverySourcePreviewQuery(previewSourceId);
  const [sourceId, setSourceId] = useState("");
  const [sourceFormError, setSourceFormError] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [kind, setKind] = useState<(typeof SOURCE_KINDS)[number]>(
    "employer_careers_page",
  );
  const [seedUrl, setSeedUrl] = useState("");
  const stats = sourceRegistryStats(sources);
  const initialFilters = useMemo<DataGridFilterState>(
    () =>
      defaultStateFilter === "all"
        ? {}
        : {
            state: {
              operator: "contains",
              text: "",
              selectedValues: [label(defaultStateFilter)],
            },
          },
    [defaultStateFilter],
  );
  const sourceColumns = useMemo<
    Array<DataGridColumn<SourceRegistryEntrySummary>>
  >(
    () => [
      {
        id: "displayName",
        label: "Company",
        rowHeader: true,
        render: (source) => (
          <span className="source-company-cell">
            <b data-typography="strong-body">{sourceCompanyName(source)}</b>
            {source.displayName !== sourceCompanyName(source) ? (
              <span data-typography="metadata">{source.displayName}</span>
            ) : null}
          </span>
        ),
        getSortValue: (source) => sourceCompanyName(source).toLowerCase(),
        getFilterValue: sourceCompanyName,
        getFilterSearchValue: (source) =>
          `${sourceCompanyName(source)} ${source.displayName}`,
      },
      {
        id: "sourceId",
        label: "Source id",
        className: "mono",
        render: (source) => (
          <span data-typography="code">{source.sourceId}</span>
        ),
        getSortValue: (source) => source.sourceId.toLowerCase(),
        getFilterValue: (source) => source.sourceId,
      },
      {
        id: "type",
        label: "Type",
        render: (source) => (
          <span className="source-table-category" data-typography="label">
            {sourceTypeLabel(source)}
          </span>
        ),
        getSortValue: (source) => sourceTypeLabel(source).toLowerCase(),
        getFilterValue: sourceTypeLabel,
      },
      {
        id: "state",
        label: "State",
        render: (source) => (
          <span className="source-state-cell">
            <StatusBadge tone={sourceStateTone(source.state)}>
              {label(source.state)}
            </StatusBadge>
          </span>
        ),
        getSortValue: (source) => label(source.state),
        getFilterValue: (source) => label(source.state),
      },
      {
        id: "priority",
        label: "Priority",
        render: (source) => (
          <span className="source-table-category" data-typography="label">
            {label(source.priority)}
          </span>
        ),
        getSortValue: (source) => label(source.priority),
        getFilterValue: (source) => label(source.priority),
      },
      {
        id: "recommendedState",
        label: "Recommendation",
        render: (source) => (
          <span className="source-table-category" data-typography="label">
            {label(source.recommendedState)}
          </span>
        ),
        getSortValue: (source) => label(source.recommendedState),
        getFilterValue: (source) => label(source.recommendedState),
      },
      {
        id: "observedJobs",
        label: "Observed",
        render: (source) => source.observedJobs,
        getSortValue: (source) => source.observedJobs,
        getFilterValue: (source) => String(source.observedJobs),
      },
      {
        id: "newJobs",
        label: "New",
        render: (source) => source.newJobs,
        getSortValue: (source) => source.newJobs,
        getFilterValue: (source) => String(source.newJobs),
      },
      {
        id: "lastRunCompletedAt",
        label: "Last run",
        render: (source) =>
          source.lastRunCompletedAt
            ? new Date(source.lastRunCompletedAt).toLocaleDateString()
            : "n/a",
        getSortValue: (source) =>
          source.lastRunCompletedAt ? Date.parse(source.lastRunCompletedAt) : 0,
        getFilterValue: (source) =>
          source.lastRunCompletedAt
            ? new Date(source.lastRunCompletedAt).toLocaleDateString()
            : "n/a",
      },
      {
        id: "consecutiveFailures",
        label: "Failures",
        render: (source) => source.consecutiveFailures,
        getSortValue: (source) => source.consecutiveFailures,
        getFilterValue: (source) => String(source.consecutiveFailures),
      },
      {
        id: "activeVerificationRate",
        label: "Active",
        render: (source) => {
          const metric = sourceQualityMetric(source, 0);
          return (
            <SourceMetricText
              label={metric.label}
              value={metric.value}
              tone={metric.tone}
            />
          );
        },
        getSortValue: (source) => source.activeVerificationRate ?? -1,
        getFilterValue: (source) => sourceQualityMetric(source, 0).value,
      },
      {
        id: "fullDescriptionSuccessRate",
        label: "Full text",
        render: (source) => {
          const metric = sourceQualityMetric(source, 1);
          return (
            <SourceMetricText
              label={metric.label}
              value={metric.value}
              tone={metric.tone}
            />
          );
        },
        getSortValue: (source) => source.fullDescriptionSuccessRate ?? -1,
        getFilterValue: (source) => sourceQualityMetric(source, 1).value,
      },
      {
        id: "applyUrlSuccessRate",
        label: "Apply URL",
        render: (source) => {
          const metric = sourceQualityMetric(source, 2);
          return (
            <SourceMetricText
              label={metric.label}
              value={metric.value}
              tone={metric.tone}
            />
          );
        },
        getSortValue: (source) => source.applyUrlSuccessRate ?? -1,
        getFilterValue: (source) => sourceQualityMetric(source, 2).value,
      },
      {
        id: "duplicateRate",
        label: "Duplicate",
        render: (source) => {
          const metric = sourceQualityMetric(source, 3);
          return (
            <SourceMetricText
              label={metric.label}
              value={metric.value}
              tone={metric.tone}
            />
          );
        },
        getSortValue: (source) => source.duplicateRate ?? -1,
        getFilterValue: (source) => sourceQualityMetric(source, 3).value,
      },
      {
        id: "politeness",
        label: "Access",
        render: (source) =>
          hasPolitenessOutcomes(source.politeness) ? (
            <SourcePolitenessBadges
              politeness={source.politeness}
              sourceLabel={sourceCompanyName(source)}
            />
          ) : (
            <span
              className="source-table-metric unknown"
              data-typography="metadata"
              aria-label="No crawl-access outcomes recorded"
            >
              —
            </span>
          ),
        getSortValue: (source) =>
          source.politeness.robotsDisallowedCount +
          source.politeness.rateLimitedCount +
          source.politeness.budgetExhaustedCount,
        getFilterValue: (source) =>
          hasPolitenessOutcomes(source.politeness)
            ? politenessOutcomeSummary(source.politeness)
            : "none",
      },
      {
        id: "actions",
        label: "Actions",
        className: "source-table-action-cell",
        render: (source) => (
          <div className="row-actions source-table-actions">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={`Activate ${source.displayName}`}
              title="Activate source"
              disabled={patchState.isPending || source.state === "active" || sourceRevision(source) === null}
              onClick={() =>
                patchState.mutate({
                  sourceId: source.sourceId,
                  body: {
                    state: "active",
                    reason: "User enabled source from product controls.",
                    expectedRevision: sourceRevision(source)!,
                  },
                })
              }
            >
              <IconCheck size={14} aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={`Quarantine ${source.displayName}`}
              title="Quarantine source"
              disabled={patchState.isPending || source.state === "quarantined" || sourceRevision(source) === null}
              onClick={() =>
                patchState.mutate({
                  sourceId: source.sourceId,
                  body: {
                    state: "quarantined",
                    reason: "User quarantined source from product controls.",
                    expectedRevision: sourceRevision(source)!,
                  },
                })
              }
            >
              <IconBan size={14} aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={
                isDemo
                  ? `Bundled preview — no fetch for ${source.displayName}`
                  : `Preview ${source.displayName}`
              }
              title={
                isDemo ? "Bundled preview — no fetch" : "Preview observed leads"
              }
              disabled={
                preview.isFetching && previewSourceId === source.sourceId
              }
              onClick={() => setPreviewSourceId(source.sourceId)}
            >
              <IconEye size={14} aria-hidden="true" />
            </Button>
          </div>
        ),
      },
    ],
    [isDemo, patchState, preview.isFetching, previewSourceId],
  );
  const columnOptions = useMemo<SavedTableColumnOption[]>(
    () =>
      sourceColumns.map((column) => ({
        id: column.id,
        label: column.label,
        locked: column.id === "actions",
      })),
    [sourceColumns],
  );
  const columnVisibility = useMemo<DataGridColumnVisibilityState | undefined>(
    () =>
      sourceTable
        ? Object.fromEntries(
            sourceTable.presentation.columns.hidden.map((columnId) => [
              columnId,
              false,
            ]),
          )
        : undefined,
    [sourceTable],
  );
  const savedViewSnapshot = useMemo<SavedTableViewSnapshot | null>(
    () =>
      sourceTable
        ? {
            ...sourceTable.presentation,
            sort: sourceTable.sort,
            urlFilters: { sourceFilters: sourceTable.filters },
            gridFilters: {},
          }
        : null,
    [sourceTable],
  );

  const handleColumnWidthsChange = (widths: DataGridColumnWidthsState) => {
    if (!sourceTable) return;
    sourceTable.onPresentationChange({
      ...sourceTable.presentation,
      columns: { ...sourceTable.presentation.columns, widths },
    });
  };

  const handleColumnOrderChange = (order: readonly string[]) => {
    if (!sourceTable) return;
    sourceTable.onPresentationChange({
      ...sourceTable.presentation,
      columns: { ...sourceTable.presentation.columns, order: [...order] },
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = SourceUpsertRequestSchema.safeParse({
      sourceId: sourceId.trim(),
      displayName: displayName.trim(),
      kind,
      priority: "standard",
      state: "experimental",
      ...(seedUrl.trim() ? { seedUrl: seedUrl.trim() } : {}),
    });
    if (!parsed.success) { setSourceFormError(parsed.error.issues[0]?.message ?? "Review the source fields."); return; }
    setSourceFormError("");
    const original = { sourceId, displayName, seedUrl };
    upsert.mutate(parsed.data, { onSuccess: () => {
      setSourceId((current) => current === original.sourceId ? "" : current);
      setDisplayName((current) => current === original.displayName ? "" : current);
      setSeedUrl((current) => current === original.seedUrl ? "" : current);
    } });
  };

  return (
    <div className="discovery-control-panel">
      <div className="discovery-panel-head">
        <h3 data-typography="component-title">Source registry</h3>
        <span className="meta" data-typography="metadata">
          {sources.length} total
        </span>
      </div>
      {upsert.error || patchState.error ? <p role="alert">The source change could not be confirmed. Review the current registry before retrying.</p> : null}
      {sourceFormError ? <p role="alert">{sourceFormError}</p> : null}
      <div
        className="discovery-source-summary"
        aria-label="Source registry summary"
      >
        <span>
          <strong data-typography="metric">{stats.active}</strong>{" "}
          <span data-typography="metadata">active</span>
        </span>
        <span>
          <strong data-typography="metric">{stats.inactive}</strong>{" "}
          <span data-typography="metadata">inactive</span>
        </span>
        <span>
          <strong data-typography="metric">{stats.withObservedJobs}</strong>{" "}
          <span data-typography="metadata">with leads</span>
        </span>
        <span>
          <strong data-typography="metric">{stats.newJobs}</strong>{" "}
          <span data-typography="metadata">new leads</span>
        </span>
      </div>
      <FilterableDataGrid
        title="Grid view"
        data={sources}
        columns={sourceColumns}
        getRowId={(source) => source.sourceId}
        loading={loading}
        loadingMessage="Loading sources."
        emptyMessage="No sources registered."
        initialSort={{ columnId: "displayName", direction: "asc" }}
        mobileLayout="cards"
        initialFilters={initialFilters}
        {...(sourceTable
          ? {
              filters: sourceTable.filters,
              onFiltersChange: sourceTable.onFiltersChange,
              sort: sourceTable.sort,
              onSortChange: sourceTable.onSortChange,
              columnVisibility: columnVisibility ?? {},
              columnOrder: sourceTable.presentation.columns.order,
              onColumnOrderChange: handleColumnOrderChange,
              columnWidths: sourceTable.presentation.columns.widths,
              onColumnWidthsChange: handleColumnWidthsChange,
              density: sourceTable.presentation.density,
              grouping: sourceTable.presentation.grouping,
              colorRules: sourceTable.presentation.colorRules,
              toolbarActions: savedViewSnapshot ? (
                <SavedTableViewsControl
                  tableId={DISCOVERY_SOURCES_TABLE_ID}
                  columnOptions={columnOptions}
                  snapshot={savedViewSnapshot}
                  onApplyView={sourceTable.onApplyView}
                  onPresentationChange={sourceTable.onPresentationChange}
                />
              ) : null,
            }
          : {})}
        paginate
        initialPageSize={25}
      />
      <form className="source-upsert-form" onSubmit={submit}>
        <Field className="field">
          <FieldLabel htmlFor="source-id">Source ID</FieldLabel>
          <Input
            id="source-id"
            value={sourceId}
            onChange={(event) => setSourceId(event.target.value)}
            required
          />
        </Field>
        <Field className="field">
          <FieldLabel htmlFor="source-name">Name</FieldLabel>
          <Input
            id="source-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            required
          />
        </Field>
        <Field className="field">
          <FieldLabel htmlFor="source-kind">Kind</FieldLabel>
          <Select
            items={SOURCE_KINDS.map((value) => ({
              label: label(value),
              value,
            }))}
            value={kind}
            onValueChange={(value) => {
              if (value !== null) {
                setKind(value as (typeof SOURCE_KINDS)[number]);
              }
            }}
          >
            <SelectTrigger
              id="source-kind"
              aria-label="Kind"
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {SOURCE_KINDS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {label(value)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field className="field wide">
          <FieldLabel htmlFor="source-seed-url">Seed URL</FieldLabel>
          <Input
            id="source-seed-url"
            type="url"
            value={seedUrl}
            onChange={(event) => setSeedUrl(event.target.value)}
            placeholder="https://example.com/careers"
          />
        </Field>
        <Button
          type="submit"
          size="sm"
          disabled={upsert.isPending || !sourceId.trim() || !displayName.trim()}
        >
          <IconPlus size={14} aria-hidden="true" />
          Add source
        </Button>
      </form>
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
        <h3 data-typography="component-title">Preview</h3>
        <span className="meta" data-typography="metadata">
          {sourceId}
        </span>
      </div>
      <div className="rows compact">
        {leads.map((lead) => (
          <div className="discovery-preview-row" key={lead.candidateUrl}>
            <span className="title-stack">
              <b data-typography="strong-body">
                {lead.title || lead.candidateUrl}
              </b>
              <span>
                {lead.company || "Unknown company"} ·{" "}
                {lead.location || "Unknown location"} · confidence{" "}
                {pct(lead.estimatedConfidence ?? null)}
              </span>
              <span className="mono" data-typography="code">
                {lead.candidateUrl}
              </span>
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
  const reset = useResetSourceLocatorCandidateMutation();

  return (
    <div className="discovery-control-panel">
      <div className="discovery-panel-head">
        <h3 data-typography="component-title">Source locator</h3>
        <span className="meta" data-typography="metadata">
          {candidates.length} candidates
        </span>
      </div>
      {promote.error || reject.error || reset.error ? <p role="alert">Source decision could not be saved. Refresh and review the current candidate before retrying.</p> : null}
      <div className="rows compact">
        {candidates.map((candidate) => (
          <div className="discovery-review-row" key={candidate.candidateId}>
            <IconExternalLink size={16} aria-hidden="true" />
            <span className="title-stack">
              <b data-typography="strong-body">{candidate.candidateUrl}</b>
              <span>
                {label(candidate.sourceKind)} · {candidate.proposal ? "Saved posting history · Review required" : `confidence ${pct(candidate.confidence)}`} ·{" "}
                {candidate.detectedAtsKind
                  ? `${candidate.detectedAtsKind} detected`
                  : "ATS unknown"}
              </span>
              <span>{candidateEvidence(candidate)}</span>
              <span>Decision: {candidate.decision ?? "unknown"}{!Number.isInteger(candidate.revision) ? " · revision unavailable" : ""}</span>
              {candidate.proposal ? (
                <>
                  <span>Board: {candidate.proposal.sourceId}{candidate.proposal.boardToken ? ` · ${candidate.proposal.boardToken}` : ""} · Completeness unknown</span>
                  <span>{candidate.proposal.overlaps.length
                    ? `Existing sources: ${candidate.proposal.overlaps.map((entry) => `${entry.sourceId} (${entry.state})`).join(", ")}`
                    : "No existing source overlap"}</span>
                  {candidate.proposal.promotionBlockedReason ? <span>{candidate.proposal.promotionBlockedReason}</span> : null}
                  <span>{candidate.proposal.evidence.length} saved origin records · Up to 3 samples shown</span>
                  {candidate.proposal.evidence.slice(0, 3).map((evidence, index) => (
                    <span key={`${evidence.originJobId}:${evidence.urlKind}:${index}`}>
                      {evidence.sample.title} · {evidence.sample.company} · {evidence.sample.descriptionExcerpt}
                      <br />Origin posting: {evidence.originPostingUrl} · Job: {evidence.originJobId} · {evidence.urlKind}: {evidence.inputUrl}
                      <br />Runs: {evidence.observations.map((observation) => observation.runId || "No recorded run").join(", ") || "No recorded run"}
                      {` · Extraction: ${evidence.extraction.tier ?? "unknown"} · Snapshot: ${evidence.extraction.snapshotVersion ?? "unknown"}`}
                      {evidence.extraction.snapshotEvidence?.length ? <><br />Saved extraction evidence: {evidence.extraction.snapshotEvidence.join(" · ")}</> : null}
                    </span>
                  ))}
                </>
              ) : null}
            </span>
            <div className="row-actions">
              <Button
                size="icon"
                variant="ghost"
                nativeButton={false}
                render={
                  <a
                    aria-label={`Open ${candidate.candidateUrl}`}
                    href={candidate.candidateUrl}
                    role="link"
                    target="_blank"
                    rel="noreferrer"
                  />
                }
                title="Open candidate"
              >
                <IconExternalLink size={14} aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Promote ${candidate.candidateUrl}`}
                title="Promote candidate"
                disabled={promote.isPending || reject.isPending || reset.isPending || !Number.isInteger(candidate.revision) || !candidate.decision || candidate.decision === "reject" || candidate.decision === "promote" || Boolean(candidate.proposal?.promotionBlockedReason) || candidate.proposal?.overlaps.some((entry) => entry.state !== "active")}
                onClick={() =>
                  promote.mutate({
                    candidateId: candidate.candidateId,
                    body: {
                      reason:
                        "User promoted source locator candidate from product controls.",
                      expectedRevision: candidate.revision!,
                    },
                  })
                }
              >
                <IconCheck size={14} aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Reject ${candidate.candidateUrl}`}
                title="Reject candidate"
                disabled={promote.isPending || reject.isPending || reset.isPending || !Number.isInteger(candidate.revision) || !candidate.decision || candidate.decision === "reject" || candidate.decision === "promote"}
                onClick={() =>
                  reject.mutate({
                    candidateId: candidate.candidateId,
                    body: {
                      reason:
                        "User rejected source locator candidate from product controls.",
                      expectedRevision: candidate.revision!,
                    },
                  })
                }
              >
                <IconX size={14} aria-hidden="true" />
              </Button>
              {candidate.decision === "reject" ? <Button type="button" variant="outline" size="sm" disabled={reset.isPending || promote.isPending || reject.isPending || !Number.isInteger(candidate.revision)} onClick={() => reset.mutate({ candidateId: candidate.candidateId, expectedRevision: candidate.revision! })}>Reopen rejected candidate</Button> : null}
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
        <h3 data-typography="component-title">Quarantine review</h3>
        <span className="meta" data-typography="metadata">
          {entries.length} pending
        </span>
      </div>
      <div className="rows compact">
        {entries.map((entry) => (
          <div className="discovery-review-row" key={entry.jobKey}>
            <IconAlertTriangle size={16} aria-hidden="true" />
            <span className="title-stack">
              <b data-typography="strong-body">{entry.title || entry.jobKey}</b>
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
                <IconCheck size={14} aria-hidden="true" />
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
                <IconX size={14} aria-hidden="true" />
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
                <IconBan size={14} aria-hidden="true" />
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
                <IconThumbUp size={14} aria-hidden="true" />
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

function RoleMatchFeedbackPanel({
  suggestions,
  loading,
}: {
  suggestions: RoleMatchSuggestion[];
  loading: boolean;
}) {
  const decision = useRoleMatchFeedbackDecisionMutation();
  const settings = useDiscoverySettingsQuery();
  const exclusions = settings.data?.settings.exactTitleExclusions;
  const knownExclusions = !settings.error && !settings.isFetching && Array.isArray(exclusions) && exclusions.every((item): item is string => typeof item === "string") ? exclusions : null;
  const pendingCount = suggestions.filter(
    (suggestion) => suggestion.status === "pending",
  ).length;

  return (
    <div className="discovery-control-panel">
      <div className="discovery-panel-head">
        <h3 data-typography="component-title">Role matching</h3>
        <span className="meta" data-typography="metadata">
          {pendingCount} pending · {suggestions.length} total
        </span>
      </div>
      {decision.error ? <p role="alert">Proposal decision could not be confirmed. Review the current proposal before retrying.</p> : null}
      <DiscoveryFeedbackRefresh />
      <div className="rows compact">
        {suggestions.map((suggestion) => (
          <div
            className="discovery-review-row role-match-feedback-row"
            key={suggestion.suggestionId}
          >
            <IconAlertTriangle size={16} aria-hidden="true" />
            <span className="title-stack">
              <b data-typography="strong-body">
                {suggestion.ruleKind === "exact_title_exclusion" ? "Proposed exact-title exclusion" : "Proposed target review"}: “{suggestion.titleDisplay}”
              </b>
              <span>
                {label(suggestion.status)} · {label(suggestion.ruleKind)}
              </span>
              <span>{suggestion.reason}</span>
              {suggestion.appliedFilter ? <span>{knownExclusions === null ? "Exclusion recorded at approval; current settings unavailable" : knownExclusions.includes(suggestion.appliedFilter.literal) ? "Current exact-title exclusion" : "Exclusion recorded at approval; no longer in current settings"}: {suggestion.appliedFilter.literal}</span>
                : suggestion.status === "approved" ? <span>Reviewed proposal; no active filter is recorded.</span> : null}
              <details><summary>Feedback sources and model provenance</summary>
                {suggestion.evidence.map((item, index) => <blockquote key={index}><code>{item.source_id}</code>: {item.quote}</blockquote>)}
                <span>{suggestion.provenance.provider} · {suggestion.provenance.model} · {suggestion.provenance.prompt_version}</span>
                <code className="break-all">{suggestion.provenance.receipt_id} · {suggestion.provenance.input_fingerprint}</code>
              </details>
            </span>
            <div className="row-actions">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Approve proposal for ${suggestion.titleDisplay}`}
                title="Approve proposal"
                disabled={
                  decision.isPending || suggestion.status !== "pending"
                }
                onClick={() =>
                  decision.mutate({
                    suggestionId: suggestion.suggestionId,
                    body: {
                      decision: "approve",
                      reason: "User approved the reviewed Discovery proposal.",
                    },
                  })
                }
              >
                <IconCheck size={14} aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Decline proposal for ${suggestion.titleDisplay}`}
                title="Decline proposal"
                disabled={
                  decision.isPending || suggestion.status !== "pending"
                }
                onClick={() =>
                  decision.mutate({
                    suggestionId: suggestion.suggestionId,
                    body: {
                      decision: "decline",
                      reason: "User declined the reviewed Discovery proposal.",
                    },
                  })
                }
              >
                <IconX size={14} aria-hidden="true" />
              </Button>
            </div>
          </div>
        ))}
        {!suggestions.length ? (
          <Empty
            title={
              loading
                ? "Loading role-match feedback."
                : "No role-match feedback suggestions."
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
  const importCapture = useManualCaptureImportMutation(items);
  // A reopened capture can have the same ID even if no queue read saw it absent.
  const [dismissalVersions, setDismissalVersions] = useState<ReadonlyMap<string, number>>(() => new Map());
  const dismiss = useManualCaptureDismissMutation((itemId) => setDismissalVersions((current) => {
    const next = new Map(current);
    next.set(itemId, (current.get(itemId) ?? 0) + 1);
    return next;
  }));

  const importItem = (itemId: string, body: ManualCaptureImportRequest, edits: CaptureDraftEdits, submittedDraft: CaptureDraftEdits, lifecycleId: string | null) => {
    importCapture.mutate({ itemId, body: { ...body, ...(lifecycleId ? { expectedLifecycleId: lifecycleId } : {}) }, edits, submittedDraft, lifecycleId });
  };

  return (
    <div className="discovery-control-panel">
      <div className="discovery-panel-head">
        <h3 data-typography="component-title">Manual capture</h3>
        <span className="meta" data-typography="metadata">
          {items.length} to review
        </span>
      </div>
      {[...importCapture.states].filter(([itemId, state]) =>
        state.status === "refresh_failed" && !items.some((item) => item.itemId === itemId),
      ).map(([itemId]) => (
        <div key={itemId}>
          <span role="status">The capture queue could not refresh for {itemId}.</span>
          <Button type="button" size="sm" onClick={() => importCapture.retryReconciliation(itemId)}>Retry queue refresh</Button>
        </div>
      ))}
      <div className="rows compact">
        {[...importCapture.states].filter(([, state]) => ["local_copy", "unconfirmed", "in_progress", "needs_fence", "refresh_failed", "recovery_failed"].includes(state.status)).map(([itemId, state]) => (
          <div key={`saved-${itemId}`} className="discovery-review-row">
            <div className="title-stack">
              <span role="status">{state.outcome === "unsubmitted" ? "Your unsubmitted edits are available below." : state.outcome === "confirmed" ? "Your submission completed. Its local copy is available below." : state.outcome === "in_progress" ? "Your submission did not start. Its local copy is available below." : state.outcome === "rejected" ? "Your submission failed. Its local copy is available below." : "The submission's outcome is unconfirmed. Its local copy is available below."}</span>
              <span>Capture mode: {state.submittedDraft.captureMode}</span>
              <span>Captured URL: {state.submittedDraft.capturedUrl}</span>
              <FieldLabel htmlFor={`${itemId}-unsubmitted-content`}>Saved submission content</FieldLabel>
              <Textarea id={`${itemId}-unsubmitted-content`} readOnly value={state.submittedDraft.content ?? ""} rows={3} />
              <FieldLabel htmlFor={`${itemId}-unsubmitted-note`}>Saved submission note</FieldLabel>
              <Input id={`${itemId}-unsubmitted-note`} readOnly value={state.submittedDraft.note ?? ""} />
              <span>Manual follow-up: {state.submittedDraft.futureManualActionRequired ? "Yes" : "No"}</span>
              {state.status === "local_copy" ? <Button type="button" size="sm" onClick={() => importCapture.discardLocalCopy(itemId)}>Discard local copy</Button> : null}
            </div>
          </div>
        ))}
        {items.map((item) => {
          const cached = importCapture.states.get(item.itemId);
          const state = cached?.lifecycleId === (item.lifecycleId ?? null) ? cached : undefined;
          const durableUnresolved = item.retryContext.manual_capture_import_unresolved === true;
          const dismissing = dismiss.isPending && dismiss.variables?.itemId === item.itemId;
          const savedCopy = cached?.status === "local_copy"
            || (cached !== undefined && cached.lifecycleId !== (item.lifecycleId ?? null)
              && (cached.status === "submitting" || cached.status === "recovering" || cached.outcome !== "confirmed"));
          const fenced = item.lifecycleId == null || dismissing || savedCopy || durableUnresolved || (state !== undefined && !["editing", "rejected", "confirmed"].includes(state.status));
          return <ManualCaptureRow
            key={JSON.stringify([item.itemId, item.lifecycleId ?? null, dismissalVersions.get(item.itemId) ?? 0])}
            item={item}
            importing={fenced}
            editingDisabled={fenced}
            reconciliation={state ?? null}
            durableUnresolved={durableUnresolved && !savedCopy}
            importError={state?.status === "rejected" || state?.status === "needs_fence"
              ? state.outcome === "in_progress" ? "Your submission did not start. Review it and try again."
                : state.outcome === "unknown" ? "The previous outcome is unconfirmed. Review the retained capture before retrying."
                  : "Import failed. Review the retained capture and try again."
              : null}
            dismissing={dismiss.isPending}
            onImport={importItem}
            onDismiss={(itemId) => dismiss.mutate({ itemId, lifecycleId: item.lifecycleId ?? null })}
            onRetryRefresh={() => importCapture.retryReconciliation(item.itemId)}
            onSupersede={() => importCapture.supersede(item.itemId, item.lifecycleId ?? null)}
            onEdit={(changes, snapshot) => importCapture.updateEdits(item.itemId, item.lifecycleId ?? null, changes, snapshot)}
            onDiscardContent={(snapshot) => importCapture.updateEdits(item.itemId, item.lifecycleId ?? null, { content: manualCaptureDraft(item).content }, snapshot, true)}
          />;
        })}
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
  editingDisabled,
  reconciliation,
  durableUnresolved,
  importError,
  dismissing,
  onImport,
  onDismiss,
  onRetryRefresh,
  onSupersede,
  onEdit,
  onDiscardContent,
}: {
  item: ManualCaptureItem;
  importing: boolean;
  editingDisabled: boolean;
  reconciliation: CaptureImportState | null;
  durableUnresolved: boolean;
  importError: string | null;
  dismissing: boolean;
  onImport: (itemId: string, body: ManualCaptureImportRequest, edits: CaptureDraftEdits, submittedDraft: CaptureDraftEdits, lifecycleId: string | null) => void;
  onDismiss: (itemId: string) => void;
  onRetryRefresh: () => void;
  onSupersede: () => void;
  onEdit: (changes: CaptureDraftEdits, snapshot: CaptureDraftEdits) => void;
  onDiscardContent: (snapshot: CaptureDraftEdits) => void;
}) {
  const savedDraft = manualCaptureDraft(item);
  const [editedDraft, setEditedDraft] = useState<Partial<typeof savedDraft>>(() => reconciliation?.edits ?? {});
  const draft = { ...savedDraft, ...editedDraft };
  const { captureMode, capturedUrl, content, note, futureManualActionRequired } = draft;
  const updateDraft = (changes: Partial<typeof draft>) => {
    setEditedDraft((current) => ({ ...current, ...changes }));
    onEdit(changes, { ...draft, ...changes });
  };
  const decisionMatchesDraft = captureMode === savedDraft.captureMode
    && capturedUrl === savedDraft.capturedUrl
    && content === savedDraft.content;
  const editedContentWouldBeOmitted = captureMode === "copied_url"
    && editedDraft.content !== undefined
    && editedDraft.content !== savedDraft.content;
  const contentRequired = requiresContent(captureMode);
  const urlRequired =
    captureMode === "copied_url" || captureMode === "current_page";
  const contentLabel = editedContentWouldBeOmitted ? "Edited content" : manualCaptureContentLabel(captureMode);
  const needsRecapture = item.retryContext.manual_capture_recovery_unverified === true;
  const canImport =
    !editedContentWouldBeOmitted &&
    (!urlRequired || capturedUrl.trim().length > 0) &&
    (!contentRequired || content.trim().length > 0) &&
    (!needsRecapture || (captureMode !== "copied_url" && content.trim().length > 0));

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
      editedDraft,
      draft,
      item.lifecycleId ?? null,
    );
  };

  return (
    <div className="discovery-review-row manual-capture-row">
      <IconExternalLink size={16} aria-hidden="true" />
      <span className="title-stack manual-capture-body">
        <b data-typography="strong-body">
          {item.sourceId ?? "Unassigned source"}
        </b>
        <span>
          {manualActionLabel(item.reason)} ·{" "}
          <span className="mono" data-typography="code">
            {item.originatingUrl}
          </span>
        </span>
        <span className="manual-capture-reason">
          {manualActionDetail(item.reason)}
        </span>
        {needsRecapture ? <span>Previous import has no matching saved snapshot. Its outcome is unverified; select saved HTML or pasted text and provide the page again.</span> : null}
        {item.lifecycleId == null ? <span>This capture's review lifetime could not be verified. Refresh the queue or update JobCtrl before editing or dismissing it.</span> : null}
        {decisionMatchesDraft && item.retryContext.manual_capture_page_decision === "access_blocked" ? <span>The captured page was identified as a login or access challenge.</span> : null}
        {decisionMatchesDraft && item.retryContext.manual_capture_page_decision === "posting_unverified" ? <span>The captured page was not identified as one job posting.</span> : null}
        {editedContentWouldBeOmitted ? <span>Choose a content capture mode to include your edited content, or discard it.</span> : null}
        {reconciliation?.status === "submitting" ? <span role="status">Importing capture. Editing resumes if it needs review.</span> : null}
        {reconciliation?.status === "checking" ? <span role="status">Checking the capture queue.</span> : null}
        {reconciliation?.status === "refresh_failed" ? <span role="status">{reconciliation.outcome === "confirmed" ? "Import completed, but the capture queue could not refresh." : reconciliation.outcome === "rejected" ? "Import failed, but the capture queue could not refresh." : reconciliation.outcome === "in_progress" ? "Your submission did not start. The capture queue could not refresh." : "Import outcome is unconfirmed. The capture queue could not refresh."}</span> : null}
        {reconciliation?.status === "recovery_failed" ? <span role="status">Could not prepare this capture for review. Its local copy is still available.</span> : null}
        {reconciliation?.status === "unconfirmed" ? <span role="status">Import outcome is unconfirmed and the capture remains in the queue. Check again before editing.</span> : null}
        {durableUnresolved && (!reconciliation || reconciliation.status === "editing") ? <span role="status">An earlier import may still finish. Review the retained capture before retrying.</span> : null}
        {reconciliation?.status === "in_progress" ? <span role="status">Your submission did not start because another import was running.</span> : null}
        {reconciliation?.status === "recovering" ? <span role="status">Preparing the capture for review.</span> : null}
        {reconciliation?.status === "confirmed" ? <span role="status">Import completed, but this capture remains in the queue. Review it before another import.</span> : null}
        {reconciliation?.status === "refresh_failed" || reconciliation?.status === "recovery_failed" || reconciliation?.status === "unconfirmed" || reconciliation?.status === "in_progress" ? <Button type="button" size="sm" onClick={onRetryRefresh}>Retry queue refresh</Button> : null}
        {(durableUnresolved && (!reconciliation || reconciliation.status === "editing")) || (reconciliation && ["refresh_failed", "recovery_failed", "unconfirmed", "in_progress", "needs_fence"].includes(reconciliation.status)) ? <>
          <span>Prevent earlier imports for this capture from saving before you review and retry.</span>
          <Button type="button" size="sm" onClick={onSupersede}>Prevent earlier imports from saving</Button>
        </> : null}
        {importError ? <span role="alert">{importError}</span> : null}
        <form className="manual-capture-form" onSubmit={submit}>
          <Field className="field">
            <FieldLabel htmlFor={`${item.itemId}-capture-mode`}>
              Capture mode
            </FieldLabel>
            <Select
              items={CAPTURE_MODES}
              value={captureMode}
              disabled={editingDisabled}
              onValueChange={(value) => {
                if (value !== null) {
                  updateDraft({ captureMode: value as ManualCaptureImportRequest["captureMode"] });
                }
              }}
            >
              <SelectTrigger
                id={`${item.itemId}-capture-mode`}
                aria-label="Capture mode"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {CAPTURE_MODES.map((mode) => (
                    <SelectItem key={mode.value} value={mode.value}>
                      {mode.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field className="field">
            <FieldLabel htmlFor={`${item.itemId}-captured-url`}>
              {urlRequired ? "Captured URL" : "Source URL"}
            </FieldLabel>
            <Input
              id={`${item.itemId}-captured-url`}
              type="url"
              value={capturedUrl}
              disabled={editingDisabled}
              onChange={(event) => updateDraft({ capturedUrl: event.target.value })}
              required={urlRequired}
            />
          </Field>
          {contentRequired || (captureMode === "current_page" && draft.content) || editedContentWouldBeOmitted ? (
            <Field className="field wide">
              <FieldLabel htmlFor={`${item.itemId}-captured-content`}>
                {contentLabel}
              </FieldLabel>
              <Textarea
                id={`${item.itemId}-captured-content`}
                value={content}
                disabled={editingDisabled}
                onChange={(event) => updateDraft({ content: event.target.value })}
                required={contentRequired}
                rows={3}
              />
            </Field>
          ) : null}
          {editedContentWouldBeOmitted ? (
            <Button type="button" size="sm" disabled={editingDisabled} onClick={() => {
              const { content: _content, ...remaining } = editedDraft;
              setEditedDraft((current) => {
                const remaining = { ...current };
                delete remaining.content;
                return remaining;
              });
              onDiscardContent({ ...savedDraft, ...remaining });
            }}>
              Discard edited content
            </Button>
          ) : null}
          <Field className="field wide">
            <FieldLabel htmlFor={`${item.itemId}-capture-note`}>
              Note
            </FieldLabel>
            <Input
              id={`${item.itemId}-capture-note`}
              value={note}
              disabled={editingDisabled}
              onChange={(event) => updateDraft({ note: event.target.value })}
            />
          </Field>
          <Field className="checkline wide" orientation="horizontal">
            <Checkbox
              id={`${item.itemId}-manual-follow-up`}
              checked={futureManualActionRequired}
              disabled={editingDisabled}
              onCheckedChange={(checked) => updateDraft({ futureManualActionRequired: checked })}
            />
            <FieldLabel htmlFor={`${item.itemId}-manual-follow-up`}>
              Needs manual follow-up
            </FieldLabel>
          </Field>
          <Button
            type="submit"
            size="sm"
            aria-label={`Import ${item.originatingUrl}`}
            disabled={importing || !canImport}
          >
            <IconUpload size={14} aria-hidden="true" />
            Import
          </Button>
        </form>
      </span>
      <div className="row-actions">
        <Button
          size="icon"
          variant="ghost"
          nativeButton={false}
          render={
            <a
              aria-label={`Open ${item.originatingUrl}`}
              href={item.originatingUrl}
              role="link"
              target="_blank"
              rel="noreferrer"
            />
          }
          title="Open page"
        >
          <IconExternalLink size={14} aria-hidden="true" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={`Dismiss ${item.originatingUrl}`}
          title="Dismiss"
          disabled={dismissing || editingDisabled}
          onClick={() => onDismiss(item.itemId)}
        >
          <IconX size={14} aria-hidden="true" />
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

function manualCaptureDraft(item: ManualCaptureItem): {
  captureMode: ManualCaptureImportRequest["captureMode"];
  capturedUrl: string;
  content: string;
  note: string;
  futureManualActionRequired: boolean;
} {
  const value = item.retryContext.manual_capture_draft;
  const draft = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const captureMode = CAPTURE_MODES.find((mode) => mode.value === draft.capture_mode)?.value ?? "copied_url";
  return {
    captureMode,
    capturedUrl: typeof draft.captured_url === "string" ? draft.captured_url : item.originatingUrl,
    content: typeof draft.content === "string" ? draft.content : "",
    note: typeof draft.note === "string" ? draft.note : "",
    futureManualActionRequired: draft.future_manual_action_required === true,
  };
}

function manualCaptureContentLabel(
  captureMode: ManualCaptureImportRequest["captureMode"],
): string {
  if (captureMode === "saved_html") return "Saved HTML";
  if (captureMode === "current_page") return "Captured page content";
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
  if (input.captureMode === "saved_html" || (input.captureMode === "current_page" && content)) {
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
