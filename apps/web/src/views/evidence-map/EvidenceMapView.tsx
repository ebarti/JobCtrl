import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  IconAlertTriangle,
  IconCalendar,
  IconChevronDown,
  IconFileText,
  IconLink,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";

import { EvidenceStatusBadge } from "../../contexts/operations/components/EvidenceStatusBadge.js";
import {
  useEvidenceMapEntryQuery,
  useEvidenceMapQuery,
} from "../../contexts/operations/hooks/useEvidenceMapQuery.js";
import type {
  EvidenceGap,
  EvidenceMapEntry,
  EvidenceUsageRef,
} from "../../contexts/operations/types.js";
import type { EvidenceMapSearch } from "../../routes/-evidence-map.search.js";
import { Alert, AlertDescription, AlertTitle } from "../../shared/ui/alert.js";
import { Button, buttonVariants } from "../../shared/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../shared/ui/collapsible.js";
import { Empty } from "../../shared/ui/empty.js";
import { Input } from "../../shared/ui/input.js";
import { PageHead } from "../../shared/ui/page-head.js";

const EXCERPT_DISCLOSURE_THRESHOLD = 140;
type EvidenceMobileView = "evidence" | "details" | "gaps";

function entryKindLabel(entry: EvidenceMapEntry): string {
  return entry.kind === "skill" ? "Skill" : "Achievement";
}

function compactDate(value: string | null): string {
  return value || "No date range";
}

function includesText(
  value: string | null | undefined,
  needle: string,
): boolean {
  return Boolean(value && value.toLowerCase().includes(needle));
}

function usageMatchesJob(usage: EvidenceUsageRef, jobKey: string): boolean {
  return !jobKey || usage.jobKey === jobKey;
}

function entryMatchesJob(entry: EvidenceMapEntry, jobKey: string): boolean {
  return (
    entry.resumeUsages.some((usage) => usageMatchesJob(usage, jobKey)) ||
    entry.requirementUsages.some((usage) => usageMatchesJob(usage, jobKey)) ||
    entry.coverageUsages.some((usage) => usageMatchesJob(usage, jobKey))
  );
}

function gapMatchesJob(gap: EvidenceGap, jobKey: string): boolean {
  return !jobKey || gap.jobRefs.some((usage) => usageMatchesJob(usage, jobKey));
}

function entryMatchesQuery(entry: EvidenceMapEntry, q: string): boolean {
  if (!q) return true;
  return [
    entry.title,
    entry.evidenceId,
    entry.skillId,
    entry.story?.scope,
    entry.story?.action,
    entry.story?.outcome,
    ...entry.skills,
    ...entry.tags,
  ].some((value) => includesText(value, q));
}

function displayText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function jobLinkLabel(usage: EvidenceUsageRef): string {
  const title = displayText(usage.jobTitle);
  if (title) return title;
  const employer = displayText(usage.employer);
  return employer ? `Role at ${employer}` : "Job";
}

function usageSubjectLabel(usage: EvidenceUsageRef): string {
  if (usage.kind === "resume_bullet") {
    return displayText(usage.generatedTextPreview) || "Resume bullet";
  }
  if (usage.kind === "requirement_fit") {
    return displayText(usage.requirementText) || "Requirement";
  }
  const keyword = displayText(usage.keyword);
  return keyword ? `${keyword} coverage` : "Skill coverage";
}

function usageExcerpt(usage: EvidenceUsageRef): string | null {
  if (usage.kind === "resume_bullet") {
    return displayText(usage.generatedTextPreview);
  }
  if (usage.kind === "requirement_fit") {
    return displayText(usage.requirementText);
  }
  return null;
}

function hasLongExcerpt(usage: EvidenceUsageRef): boolean {
  return (usageExcerpt(usage)?.length ?? 0) > EXCERPT_DISCLOSURE_THRESHOLD;
}

function requirementLinkLabel(usage: EvidenceUsageRef): string {
  return [
    jobLinkLabel(usage),
    usageSubjectLabel(usage),
    usage.requirementFitKind,
  ]
    .filter(Boolean)
    .join(" · ");
}

function resumeLinkLabel(usage: EvidenceUsageRef): string {
  return [jobLinkLabel(usage), usageSubjectLabel(usage)].join(" · ");
}

function hasSparseUsageLabel(usage: EvidenceUsageRef): boolean {
  if (!displayText(usage.jobTitle)) return true;
  if (usage.kind === "resume_bullet") {
    return !displayText(usage.generatedTextPreview);
  }
  if (usage.kind === "requirement_fit") {
    return !displayText(usage.requirementText);
  }
  return !displayText(usage.keyword);
}

function UsageTechnicalDetails({
  usage,
}: {
  readonly usage: EvidenceUsageRef;
}) {
  const identifiers = [
    ["Job record key", usage.jobKey],
    ["Artifact ID", usage.artifactId],
    ["Bullet ID", usage.bulletId],
    ["Requirement ID", usage.requirementId],
  ].filter((item): item is [string, string] => Boolean(item[1]));
  return (
    <Collapsible className="flex flex-col items-start">
      <CollapsibleTrigger
        render={
          <Button
            className="h-auto min-h-0 px-0 py-0"
            size="sm"
            type="button"
            variant="link"
          />
        }
      >
        Technical details
        <IconChevronDown aria-hidden="true" data-icon="inline-end" />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1">
        <dl className="m-0 grid gap-1">
          {identifiers.map(([label, value]) => (
            <div className="grid gap-0.5" key={label}>
              <dt data-typography="label">{label}</dt>
              <dd className="m-0" data-typography="code">
                <code className="break-all">{value}</code>
              </dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

function UsageExcerpt({ usage }: { readonly usage: EvidenceUsageRef }) {
  const excerpt = usageExcerpt(usage);
  if (!excerpt || !hasLongExcerpt(usage)) {
    return null;
  }
  return (
    <Collapsible className="evidence-excerpt">
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
        View full excerpt
        <IconChevronDown aria-hidden="true" data-icon="inline-end" />
      </CollapsibleTrigger>
      <CollapsibleContent className="evidence-excerpt__content">
        <p data-typography="body">{excerpt}</p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function UsageLink({ usage }: { readonly usage: EvidenceUsageRef }) {
  const technicalDetails = hasSparseUsageLabel(usage) ? (
    <UsageTechnicalDetails usage={usage} />
  ) : null;
  if (usage.kind === "resume_bullet" && usage.artifactId) {
    return (
      <div className="flex flex-col">
        <Link
          className="evidence-usage-link"
          params={{ artifactId: usage.artifactId }}
          to="/artifacts/$artifactId"
        >
          <span
            className="evidence-usage-subject"
            data-clamped={hasLongExcerpt(usage) ? "true" : undefined}
            data-typography="body"
          >
            {resumeLinkLabel(usage)}
          </span>
          <span className="evidence-meta-label" data-typography="metadata">
            <IconFileText aria-hidden="true" />
            artifact
          </span>
        </Link>
        <UsageExcerpt usage={usage} />
        {technicalDetails}
      </div>
    );
  }
  const statusType = usage.requirementFitKind ? "fit" : "coverage";
  return (
    <div className="flex flex-col">
      <Link
        className="evidence-usage-link"
        params={{ jobId: usage.jobKey }}
        to="/jobs/$jobId"
      >
        <span
          className="evidence-usage-subject"
          data-clamped={hasLongExcerpt(usage) ? "true" : undefined}
          data-typography="body"
        >
          {requirementLinkLabel(usage)}
        </span>
        {statusType === "fit" ? (
          <EvidenceStatusBadge type="fit" value={usage.requirementFitKind} />
        ) : (
          <EvidenceStatusBadge
            type="coverage"
            value={usage.coverageState ?? usage.artifactCoverageState}
          />
        )}
      </Link>
      <UsageExcerpt usage={usage} />
      {technicalDetails}
    </div>
  );
}

function UsageGroup({
  title,
  usages,
}: {
  readonly title: string;
  readonly usages: readonly EvidenceUsageRef[];
}) {
  if (!usages.length) {
    return null;
  }
  return (
    <section className="evidence-detail-group">
      <h3 data-typography="component-title">{title}</h3>
      <ul className="evidence-usage-list">
        {usages.map((usage, index) => (
          <li
            key={`${usage.kind}:${usage.jobKey}:${usage.artifactId ?? ""}:${usage.requirementId ?? ""}:${index}`}
          >
            <UsageLink usage={usage} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function EvidenceEntryButton({
  entry,
  onOpenDetails,
  search,
  selected,
}: {
  readonly entry: EvidenceMapEntry;
  readonly onOpenDetails: () => void;
  readonly search: EvidenceMapSearch;
  readonly selected: boolean;
}) {
  const usageCount =
    entry.resumeUsages.length +
    entry.requirementUsages.length +
    entry.coverageUsages.length;
  return (
    <li>
      <Link
        aria-current={selected ? "page" : undefined}
        className={`evidence-entry-link ${selected ? "selected" : ""}`}
        data-selected={selected ? "true" : undefined}
        search={{ ...search, entry: entry.entryId }}
        to="/evidence-map"
        onClick={onOpenDetails}
      >
        <span>
          <strong
            className="evidence-entry-title"
            data-typography="strong-body"
          >
            {entry.title}
          </strong>
          <span className="muted" data-typography="metadata">
            {entryKindLabel(entry)}
          </span>
        </span>
        <span className="evidence-entry-meta">
          <EvidenceStatusBadge
            type="strength"
            value={entry.freshness.evidenceStrength}
          />
          <span className="evidence-meta-label" data-typography="metadata">
            <IconLink aria-hidden="true" />
            {usageCount} uses
          </span>
        </span>
      </Link>
    </li>
  );
}

function EvidenceTechnicalDetails({
  entry,
}: {
  readonly entry: EvidenceMapEntry;
}) {
  const details = [
    ["Evidence entry ID", entry.entryId],
    ["Evidence ID", entry.evidenceId],
    ["Skill ID", entry.skillId],
    [
      "Claim confidence",
      entry.freshness.claimConfidence === null
        ? null
        : `${Math.round(entry.freshness.claimConfidence * 100)}%`,
    ],
    ["Last used", entry.freshness.lastUsedAt],
  ].filter((detail): detail is [string, string] => Boolean(detail[1]));

  if (!details.length) {
    return null;
  }

  return (
    <Collapsible className="evidence-technical-details">
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
        <IconChevronDown aria-hidden="true" data-icon="inline-end" />
      </CollapsibleTrigger>
      <CollapsibleContent className="evidence-technical-details__content">
        <dl>
          {details.map(([label, value]) => (
            <div key={label}>
              <dt data-typography="label">{label}</dt>
              <dd data-typography="code">
                <code>{value}</code>
              </dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

function EvidenceDetail({
  entry,
  mobileActive,
}: {
  readonly entry: EvidenceMapEntry | null;
  readonly mobileActive: boolean;
}) {
  if (!entry) {
    return (
      <aside
        className="evidence-detail"
        data-mobile-active={mobileActive ? "true" : "false"}
        id="evidence-map-details-panel"
      >
        <Empty title="Select evidence to inspect usage." />
      </aside>
    );
  }
  const freshness = entry.freshness;
  return (
    <aside
      className="evidence-detail"
      aria-labelledby="evidence-detail-title"
      data-mobile-active={mobileActive ? "true" : "false"}
      id="evidence-map-details-panel"
    >
      <header>
        <p className="meta" data-typography="metadata">
          {entryKindLabel(entry)}
        </p>
        <h2 data-typography="section-title" id="evidence-detail-title">
          {entry.title}
        </h2>
        <div className="evidence-tags">
          <EvidenceStatusBadge
            type="strength"
            value={freshness.evidenceStrength}
          />
          <EvidenceStatusBadge
            type="confirmation"
            value={freshness.userConfirmed}
          />
          <span className="evidence-meta-label" data-typography="metadata">
            <IconCalendar aria-hidden="true" />
            {compactDate(freshness.evidenceDateRange)}
          </span>
        </div>
      </header>

      {entry.story ? (
        <section className="evidence-story">
          <h3 data-typography="component-title">Reusable story</h3>
          <dl>
            <div>
              <dt data-typography="label">Scope</dt>
              <dd data-typography="body">
                {entry.story.scope || "Not recorded"}
              </dd>
            </div>
            <div>
              <dt data-typography="label">Action</dt>
              <dd data-typography="body">
                {entry.story.action || "Not recorded"}
              </dd>
            </div>
            <div>
              <dt data-typography="label">Outcome</dt>
              <dd data-typography="body">
                {entry.story.outcome || "Not recorded"}
              </dd>
            </div>
          </dl>
          {entry.story.metrics.length ? (
            <ul className="evidence-chip-list" aria-label="Story metrics">
              {entry.story.metrics.map((metric) => (
                <li
                  className="evidence-inline-value"
                  data-typography="body"
                  key={metric}
                >
                  {metric}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section className="evidence-detail-group">
        <h3 data-typography="component-title">Skills and tags</h3>
        <div className="evidence-attribute-list">
          <div className="evidence-attribute-row">
            <span data-typography="label">Skills</span>
            <ul className="evidence-chip-list" aria-label="Skills">
              {entry.skills.map((value) => (
                <li
                  className="evidence-inline-value"
                  data-typography="body"
                  key={value}
                >
                  {value}
                </li>
              ))}
            </ul>
          </div>
          <div className="evidence-attribute-row">
            <span data-typography="label">Tags</span>
            <ul className="evidence-chip-list" aria-label="Tags">
              {entry.tags.map((value) => (
                <li
                  className="evidence-inline-value"
                  data-typography="body"
                  key={value}
                >
                  {value}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="evidence-detail-group evidence-detail-technical-group">
        <EvidenceTechnicalDetails entry={entry} />
      </section>

      <UsageGroup title="Used in resumes" usages={entry.resumeUsages} />
      <UsageGroup
        title="Requirement fit history"
        usages={entry.requirementUsages}
      />
      <UsageGroup title="Coverage history" usages={entry.coverageUsages} />
    </aside>
  );
}

function GapList({ gaps }: { readonly gaps: readonly EvidenceGap[] }) {
  if (!gaps.length) {
    return <Empty title="No evidence gaps in this view." />;
  }
  return (
    <ul className="evidence-gap-list">
      {gaps.map((gap) => (
        <li key={gap.gapId}>
          <div>
            <EvidenceStatusBadge type="gap" value={gap.kind} />
            <strong
              className="evidence-gap-title"
              data-typography="strong-body"
            >
              {gap.requirementText}
            </strong>
            <p className="muted evidence-gap-reason" data-typography="body">
              {gap.reason}
            </p>
          </div>
          <div className="evidence-gap-links">
            {gap.jobRefs.map((usage, index) => (
              <UsageLink
                key={`${gap.gapId}:${usage.jobKey}:${usage.requirementId ?? index}`}
                usage={usage}
              />
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

function StoryList({
  entries,
}: {
  readonly entries: readonly EvidenceMapEntry[];
}) {
  const stories = entries.filter((entry) => entry.story);
  if (!stories.length) {
    return <Empty title="No reusable stories match this view." />;
  }
  return (
    <ul className="evidence-story-list">
      {stories.map((entry) => (
        <li key={entry.entryId}>
          <strong data-typography="strong-body">{entry.title}</strong>
          <span className="evidence-story-outcome" data-typography="body">
            {entry.story?.outcome}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function EvidenceMapView() {
  const search = useSearch({ from: "/evidence-map" });
  const navigate = useNavigate({ from: "/evidence-map" });
  const evidenceMap = useEvidenceMapQuery();
  const [mobileView, setMobileView] = useState<EvidenceMobileView>("evidence");
  const normalizedQuery = search.q.trim().toLowerCase();
  const filteredEntries = useMemo(() => {
    const entries = evidenceMap.data?.entries ?? [];
    return entries.filter(
      (entry) =>
        entryMatchesQuery(entry, normalizedQuery) &&
        (!search.job || entryMatchesJob(entry, search.job)),
    );
  }, [evidenceMap.data?.entries, normalizedQuery, search.job]);
  const filteredGaps = useMemo(() => {
    const gaps = evidenceMap.data?.gaps ?? [];
    return gaps.filter((gap) => gapMatchesJob(gap, search.job));
  }, [evidenceMap.data?.gaps, search.job]);
  const selectedEntryId = search.entry || filteredEntries[0]?.entryId || null;
  const selectedEntry = useEvidenceMapEntryQuery(selectedEntryId);
  const selected =
    selectedEntry.data ??
    filteredEntries.find((entry) => entry.entryId === selectedEntryId) ??
    null;
  const errorMessage =
    evidenceMap.error instanceof Error ? evidenceMap.error.message : null;

  const setSearch = (next: Partial<EvidenceMapSearch>) => {
    void navigate({
      search: (prev: EvidenceMapSearch) => ({ ...prev, ...next }),
    });
  };

  return (
    <>
      <PageHead
        eyebrow="Library"
        title="Career evidence map"
        subtitle={
          evidenceMap.data ? `${filteredEntries.length} entries` : "loading"
        }
      />
      <section className="card full evidence-map-view">
        {errorMessage ? (
          <Alert className="evidence-map-error" variant="destructive">
            <IconAlertTriangle aria-hidden="true" />
            <AlertTitle>Could not load evidence</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}
        <div className="toolbar evidence-map-toolbar">
          <label>
            <span data-typography="label">Search evidence</span>
            <Input
              value={search.q}
              onChange={(event) =>
                setSearch({ q: event.target.value, entry: "" })
              }
              placeholder="Skill, story, metric..."
            />
          </label>
          {search.job ? (
            <Link
              className={buttonVariants({ size: "sm", variant: "ghost" })}
              data-typography="control"
              search={{ ...search, job: "", entry: "" }}
              to="/evidence-map"
            >
              Clear job filter
            </Link>
          ) : null}
        </div>
        <div
          className="evidence-map-mobile-switcher"
          aria-label="Evidence map view"
          role="group"
        >
          <Button
            aria-controls="evidence-map-entry-panel"
            aria-pressed={mobileView === "evidence"}
            size="sm"
            type="button"
            variant={mobileView === "evidence" ? "default" : "ghost"}
            onClick={() => setMobileView("evidence")}
          >
            Evidence ({filteredEntries.length})
          </Button>
          <Button
            aria-controls="evidence-map-details-panel"
            aria-pressed={mobileView === "details"}
            disabled={!selected}
            size="sm"
            type="button"
            variant={mobileView === "details" ? "default" : "ghost"}
            onClick={() => setMobileView("details")}
          >
            Details
          </Button>
          <Button
            aria-controls="evidence-map-gaps-panel"
            aria-pressed={mobileView === "gaps"}
            size="sm"
            type="button"
            variant={mobileView === "gaps" ? "default" : "ghost"}
            onClick={() => setMobileView("gaps")}
          >
            Gaps ({filteredGaps.length})
          </Button>
        </div>
        <div className="evidence-map-shell">
          <nav
            className="evidence-entry-list"
            aria-label="Evidence entries"
            data-mobile-active={mobileView === "evidence" ? "true" : "false"}
            id="evidence-map-entry-panel"
          >
            {evidenceMap.isFetching && !evidenceMap.data ? (
              <Empty title="Loading evidence map." />
            ) : filteredEntries.length ? (
              <ul>
                {filteredEntries.map((entry) => (
                  <EvidenceEntryButton
                    entry={entry}
                    key={entry.entryId}
                    onOpenDetails={() => setMobileView("details")}
                    search={search}
                    selected={entry.entryId === selectedEntryId}
                  />
                ))}
              </ul>
            ) : (
              <Empty title="No evidence entries match." />
            )}
          </nav>
          <EvidenceDetail
            entry={selected}
            mobileActive={mobileView === "details"}
          />
          <section
            className="evidence-side-panel"
            aria-labelledby="evidence-gaps-title"
            data-mobile-active={mobileView === "gaps" ? "true" : "false"}
            id="evidence-map-gaps-panel"
          >
            <h2 data-typography="component-title" id="evidence-gaps-title">
              Gaps
            </h2>
            <GapList gaps={filteredGaps} />
            <h2 data-typography="component-title">Reusable stories</h2>
            <StoryList entries={filteredEntries} />
          </section>
        </div>
      </section>
    </>
  );
}
