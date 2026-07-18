import type {
  DiscoveryFeedbackKind,
  DiscoveryPreviewResponse,
  ManualCaptureImportRequest,
  ManualCaptureListResponse,
  QuarantineListResponse,
  RoleMatchFeedbackListResponse,
  SourceLocatorListResponse,
  SourceRegistryEntrySummary,
} from "@jobctrl/contracts";
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
import {
  useDiscoveryQuarantineQuery,
  useDiscoverySourcePreviewQuery,
  useManualCaptureQueueQuery,
  useRoleMatchFeedbackQuery,
  useSourceLocatorCandidatesQuery,
  useSourceRegistryQuery,
} from "../../operations/hooks/useDiscoveryProductControlsQuery.js";
import { Button } from "../../../shared/ui/button.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { Checkbox } from "../../../shared/ui/checkbox.js";
import { Empty } from "../../../shared/ui/empty.js";
import {
  Field,
  FieldLabel,
} from "../../../shared/ui/field.js";
import {
  FilterableDataGrid,
  type DataGridColumn,
  type DataGridFilterState,
} from "../../../shared/ui/filterable-data-grid.js";
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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../../shared/ui/tabs.js";
import {
  useDiscoveryFeedbackMutation,
  useDiscoveryQuarantineDecisionMutation,
  useManualCaptureDismissMutation,
  useManualCaptureImportMutation,
  usePatchDiscoverySourceStateMutation,
  usePromoteSourceLocatorCandidateMutation,
  useRejectSourceLocatorCandidateMutation,
  useRoleMatchFeedbackDecisionMutation,
  useUpsertDiscoverySourceMutation,
} from "../hooks/useDiscoveryProductControlMutations.js";

type QuarantineEntry = QuarantineListResponse["entries"][number];
type ManualCaptureItem = ManualCaptureListResponse["items"][number];
type LocatorCandidate = SourceLocatorListResponse["candidates"][number];
type RoleMatchSuggestion = RoleMatchFeedbackListResponse["suggestions"][number];
type PreviewLead = DiscoveryPreviewResponse["leads"][number];
type SourceMetricTone = "good" | "warn" | "bad" | "unknown";
type DiscoveryControlsLayout = "grid" | "tabs";
type SourceRegistryStateFilter = "all" | SourceRegistryEntrySummary["state"];

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
  if (sourceId.startsWith("jobspy:")) return "JobSpy board";
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
    case "protected_internal_site":
      return "Protected internal site";
    case "ambiguous_career_system":
      return "Unconfirmed careers page";
    case "browser_extension_capture":
      return "Browser extension capture";
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
    case "protected_internal_site":
      return "The posting appears to be on a protected company or internal site.";
    case "ambiguous_career_system":
      return "The URL looks useful, but the app cannot confirm which careers system or parser should handle it yet.";
    case "browser_extension_capture":
      return "The user saved this posting from the browser extension.";
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
      : "Ready to auto-approve",
    `discovered ${new Date(candidate.discoveredAt).toLocaleDateString()}`,
  ].join(" · ");
}

export function DiscoveryProductControls({
  layout = "grid",
}: {
  readonly layout?: DiscoveryControlsLayout;
} = {}) {
  const sources = useSourceRegistryQuery();
  const locatorCandidates = useSourceLocatorCandidatesQuery();
  const quarantine = useDiscoveryQuarantineQuery();
  const manualCapture = useManualCaptureQueueQuery();
  const roleMatchFeedback = useRoleMatchFeedbackQuery();
  const sourceCount = sources.data?.sources.length ?? 0;
  const quarantineCount = quarantine.data?.entries.length ?? 0;
  const manualCount = manualCapture.data?.items.length ?? 0;
  const candidateCount = locatorCandidates.data?.candidates.length ?? 0;
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

  return (
    <section className="card full discovery-controls">
      <CardHeader
        title="Discovery controls"
        meta={`${sourceCount} sources · ${candidateCount} candidates · ${quarantineCount + manualCount + pendingRoleSuggestionCount} review`}
      />
      {message ? <div className="banner inline">{message}</div> : null}
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
            <SourceRegistryPanel
              defaultStateFilter="active"
              sources={sources.data?.sources ?? []}
              loading={sources.isLoading}
            />
          </TabsContent>
          <TabsContent value="locator" className="discovery-tab-panel">
            <SourceLocatorPanel
              candidates={locatorCandidates.data?.candidates ?? []}
              loading={locatorCandidates.isLoading}
            />
          </TabsContent>
          <TabsContent value="quarantine" className="discovery-tab-panel">
            <QuarantinePanel
              entries={quarantine.data?.entries ?? []}
              loading={quarantine.isLoading}
            />
          </TabsContent>
          <TabsContent value="role-match" className="discovery-tab-panel">
            <RoleMatchFeedbackPanel
              suggestions={roleMatchFeedback.data?.suggestions ?? []}
              loading={roleMatchFeedback.isLoading}
            />
          </TabsContent>
          <TabsContent value="manual" className="discovery-tab-panel">
            <ManualCapturePanel
              items={manualCapture.data?.items ?? []}
              loading={manualCapture.isLoading}
            />
          </TabsContent>
        </Tabs>
      ) : (
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
          <RoleMatchFeedbackPanel
            suggestions={roleMatchFeedback.data?.suggestions ?? []}
            loading={roleMatchFeedback.isLoading}
          />
          <ManualCapturePanel
            items={manualCapture.data?.items ?? []}
            loading={manualCapture.isLoading}
          />
        </div>
      )}
    </section>
  );
}

function SourceRegistryPanel({
  sources,
  loading,
  defaultStateFilter = "all",
}: {
  sources: SourceRegistryEntrySummary[];
  loading: boolean;
  defaultStateFilter?: SourceRegistryStateFilter;
}) {
  const { featureFlags } = usePorts();
  const isDemo = featureFlags.get("demoMode", false);
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
              <IconCheck size={14} aria-hidden="true" />
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
                  body: {
                    state: "quarantined",
                    reason: "User quarantined source from product controls.",
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
        <h3 data-typography="component-title">Source registry</h3>
        <span className="meta" data-typography="metadata">
          {sources.length} total
        </span>
      </div>
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
            <SelectTrigger id="source-kind" aria-label="Kind" className="w-full">
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
        <span className="meta" data-typography="metadata">{sourceId}</span>
      </div>
      <div className="rows compact">
        {leads.map((lead) => (
          <div className="discovery-preview-row" key={lead.candidateUrl}>
            <span className="title-stack">
              <b data-typography="strong-body">{lead.title || lead.candidateUrl}</b>
              <span>
                {lead.company || "Unknown company"} ·{" "}
                {lead.location || "Unknown location"} · confidence{" "}
                {pct(lead.estimatedConfidence)}
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

  return (
    <div className="discovery-control-panel">
      <div className="discovery-panel-head">
        <h3 data-typography="component-title">Source locator</h3>
        <span className="meta" data-typography="metadata">
          {candidates.length} candidates
        </span>
      </div>
      <div className="rows compact">
        {candidates.map((candidate) => (
          <div className="discovery-review-row" key={candidate.candidateId}>
            <IconExternalLink size={16} aria-hidden="true" />
            <span className="title-stack">
              <b data-typography="strong-body">{candidate.candidateUrl}</b>
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
                <IconCheck size={14} aria-hidden="true" />
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
                <IconX size={14} aria-hidden="true" />
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
      <div className="rows compact">
        {suggestions.map((suggestion) => (
          <div
            className="discovery-review-row role-match-feedback-row"
            key={suggestion.suggestionId}
          >
            <IconAlertTriangle size={16} aria-hidden="true" />
            <span className="title-stack">
              <b data-typography="strong-body">
                Exclude “{suggestion.titleDisplay}”
              </b>
              <span>
                {label(suggestion.status)} · {suggestion.sampleCount} low-score{" "}
                {suggestion.sampleCount === 1 ? "example" : "examples"} ·{" "}
                {label(suggestion.reasonCode)}
              </span>
              <span>{suggestion.reason}</span>
              {suggestion.sourceIds.length ? (
                <span className="mono" data-typography="code">
                  sources: {suggestion.sourceIds.join(", ")}
                </span>
              ) : null}
              {suggestion.evidence[0] ? (
                <span>
                  Latest: {suggestion.evidence[0].company || "Unknown company"}{" "}
                  · score {suggestion.evidence[0].fitScore}/10
                  {suggestion.evidence[0].roleFit === null
                    ? ""
                    : ` · role ${suggestion.evidence[0].roleFit}/10`}
                </span>
              ) : null}
            </span>
            <div className="row-actions">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Approve role-match rule for ${suggestion.titleDisplay}`}
                title="Approve rule"
                disabled={
                  decision.isPending || suggestion.status === "approved"
                }
                onClick={() =>
                  decision.mutate({
                    suggestionId: suggestion.suggestionId,
                    body: {
                      decision: "approve",
                      reason: "User approved low-score role-match suggestion.",
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
                aria-label={`Decline role-match rule for ${suggestion.titleDisplay}`}
                title="Decline rule"
                disabled={
                  decision.isPending || suggestion.status === "declined"
                }
                onClick={() =>
                  decision.mutate({
                    suggestionId: suggestion.suggestionId,
                    body: {
                      decision: "decline",
                      reason: "User declined low-score role-match suggestion.",
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
  const importCapture = useManualCaptureImportMutation();
  const dismiss = useManualCaptureDismissMutation();

  const importItem = (itemId: string, body: ManualCaptureImportRequest) => {
    importCapture.mutate({ itemId, body });
  };

  return (
    <div className="discovery-control-panel">
      <div className="discovery-panel-head">
        <h3 data-typography="component-title">Manual capture</h3>
        <span className="meta" data-typography="metadata">
          {items.length} pending
        </span>
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
      <IconExternalLink size={16} aria-hidden="true" />
      <span className="title-stack manual-capture-body">
        <b data-typography="strong-body">{item.sourceId ?? "Unassigned source"}</b>
        <span>
          {manualActionLabel(item.reason)} ·{" "}
          <span className="mono" data-typography="code">
            {item.originatingUrl}
          </span>
        </span>
        <span className="manual-capture-reason">
          {manualActionDetail(item.reason)}
        </span>
        <form className="manual-capture-form" onSubmit={submit}>
          <Field className="field">
            <FieldLabel htmlFor={`${item.itemId}-capture-mode`}>
              Capture mode
            </FieldLabel>
            <Select
              items={CAPTURE_MODES}
              value={captureMode}
              onValueChange={(value) => {
                if (value !== null) {
                  setCaptureMode(
                    value as ManualCaptureImportRequest["captureMode"],
                  );
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
              onChange={(event) => setCapturedUrl(event.target.value)}
              required={urlRequired}
            />
          </Field>
          {contentRequired ? (
            <Field className="field wide">
              <FieldLabel htmlFor={`${item.itemId}-captured-content`}>
                {contentLabel}
              </FieldLabel>
              <Textarea
                id={`${item.itemId}-captured-content`}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                required
                rows={3}
              />
            </Field>
          ) : null}
          <Field className="field wide">
            <FieldLabel htmlFor={`${item.itemId}-capture-note`}>Note</FieldLabel>
            <Input
              id={`${item.itemId}-capture-note`}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          <Field className="checkline wide" orientation="horizontal">
            <Checkbox
              id={`${item.itemId}-manual-follow-up`}
              checked={futureManualActionRequired}
              onCheckedChange={setFutureManualActionRequired}
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
          disabled={dismissing}
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
