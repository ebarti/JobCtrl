import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  IconCalendar,
  IconChevronDown,
  IconFileText,
  IconLink,
} from "@tabler/icons-react";
import { useMemo } from "react";

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
import { Button } from "../../shared/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../shared/ui/collapsible.js";
import { Empty } from "../../shared/ui/empty.js";
import { PageHead } from "../../shared/ui/page-head.js";

function entryKindLabel(entry: EvidenceMapEntry): string {
  return entry.kind === "skill" ? "Skill" : "Achievement";
}

function compactDate(value: string | null): string {
  return value || "No date range";
}

function includesText(value: string | null | undefined, needle: string): boolean {
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

function requirementLinkLabel(usage: EvidenceUsageRef): string {
  return [
    jobLinkLabel(usage),
    usageSubjectLabel(usage),
    usage.requirementFitKind,
  ].filter(Boolean).join(" · ");
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

function UsageTechnicalDetails({ usage }: { readonly usage: EvidenceUsageRef }) {
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
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="m-0">
                <code className="break-all text-[13px]">{value}</code>
              </dd>
            </div>
          ))}
        </dl>
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
          <span>{resumeLinkLabel(usage)}</span>
          <span className="evidence-meta-label">
            <IconFileText aria-hidden="true" />
            artifact
          </span>
        </Link>
        {technicalDetails}
      </div>
    );
  }
  const statusType = usage.requirementFitKind ? "fit" : "coverage";
  return (
    <div className="flex flex-col">
      <Link className="evidence-usage-link" params={{ jobId: usage.jobKey }} to="/jobs/$jobId">
        <span>{requirementLinkLabel(usage)}</span>
        {statusType === "fit" ? (
          <EvidenceStatusBadge type="fit" value={usage.requirementFitKind} />
        ) : (
          <EvidenceStatusBadge
            type="coverage"
            value={usage.coverageState ?? usage.artifactCoverageState}
          />
        )}
      </Link>
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
      <h3>{title}</h3>
      <ul className="evidence-usage-list">
        {usages.map((usage, index) => (
          <li key={`${usage.kind}:${usage.jobKey}:${usage.artifactId ?? ""}:${usage.requirementId ?? ""}:${index}`}>
            <UsageLink usage={usage} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function EvidenceEntryButton({
  entry,
  search,
  selected,
}: {
  readonly entry: EvidenceMapEntry;
  readonly search: EvidenceMapSearch;
  readonly selected: boolean;
}) {
  const usageCount =
    entry.resumeUsages.length + entry.requirementUsages.length + entry.coverageUsages.length;
  return (
    <li>
      <Link
        aria-current={selected ? "true" : undefined}
        className={`evidence-entry-link ${selected ? "selected" : ""}`}
        search={{ ...search, entry: entry.entryId }}
        to="/evidence-map"
      >
        <span>
          <strong>{entry.title}</strong>
          <span className="muted">{entryKindLabel(entry)}</span>
        </span>
        <span className="evidence-entry-meta">
          <EvidenceStatusBadge type="strength" value={entry.freshness.evidenceStrength} />
          <span className="evidence-meta-label">
            <IconLink aria-hidden="true" />
            {usageCount} uses
          </span>
        </span>
      </Link>
    </li>
  );
}

function EvidenceDetail({ entry }: { readonly entry: EvidenceMapEntry | null }) {
  if (!entry) {
    return <Empty title="Select evidence to inspect usage." />;
  }
  const freshness = entry.freshness;
  return (
    <aside className="evidence-detail" aria-labelledby="evidence-detail-title">
      <header>
        <p className="meta">{entryKindLabel(entry)}</p>
        <h2 id="evidence-detail-title">{entry.title}</h2>
        <div className="evidence-tags">
          <EvidenceStatusBadge type="strength" value={freshness.evidenceStrength} />
          <EvidenceStatusBadge type="confirmation" value={freshness.userConfirmed} />
          <span className="evidence-meta-label">
            <IconCalendar aria-hidden="true" />
            {compactDate(freshness.evidenceDateRange)}
          </span>
        </div>
      </header>

      {entry.story ? (
        <section className="evidence-story">
          <h3>Reusable story</h3>
          <dl>
            <div>
              <dt>Scope</dt>
              <dd>{entry.story.scope || "Not recorded"}</dd>
            </div>
            <div>
              <dt>Action</dt>
              <dd>{entry.story.action || "Not recorded"}</dd>
            </div>
            <div>
              <dt>Outcome</dt>
              <dd>{entry.story.outcome || "Not recorded"}</dd>
            </div>
          </dl>
          {entry.story.metrics.length ? (
            <ul className="evidence-chip-list" aria-label="Story metrics">
              {entry.story.metrics.map((metric) => (
                <li className="evidence-inline-value" key={metric}>{metric}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section className="evidence-detail-group">
        <h3>Skills and tags</h3>
        <div className="evidence-attribute-list">
          <div className="evidence-attribute-row">
            <span>Skills</span>
            <ul className="evidence-chip-list" aria-label="Skills">
              {entry.skills.map((value) => (
                <li className="evidence-inline-value" key={value}>{value}</li>
              ))}
            </ul>
          </div>
          <div className="evidence-attribute-row">
            <span>Tags</span>
            <ul className="evidence-chip-list" aria-label="Tags">
              {entry.tags.map((value) => (
                <li className="evidence-inline-value" key={value}>{value}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <UsageGroup title="Used in resumes" usages={entry.resumeUsages} />
      <UsageGroup title="Requirement fit history" usages={entry.requirementUsages} />
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
            <strong>{gap.requirementText}</strong>
            <p className="muted">{gap.reason}</p>
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

function StoryList({ entries }: { readonly entries: readonly EvidenceMapEntry[] }) {
  const stories = entries.filter((entry) => entry.story);
  if (!stories.length) {
    return <Empty title="No reusable stories match this view." />;
  }
  return (
    <ul className="evidence-story-list">
      {stories.map((entry) => (
        <li key={entry.entryId}>
          <strong>{entry.title}</strong>
          <span>{entry.story?.outcome}</span>
        </li>
      ))}
    </ul>
  );
}

export function EvidenceMapView() {
  const search = useSearch({ from: "/evidence-map" });
  const navigate = useNavigate({ from: "/evidence-map" });
  const evidenceMap = useEvidenceMapQuery();
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
  const errorMessage = evidenceMap.error instanceof Error ? evidenceMap.error.message : null;

  const setSearch = (next: Partial<EvidenceMapSearch>) => {
    void navigate({ search: (prev: EvidenceMapSearch) => ({ ...prev, ...next }) });
  };

  return (
    <>
      <PageHead
        eyebrow="Library"
        title="Career evidence map"
        subtitle={evidenceMap.data ? `${filteredEntries.length} entries` : "loading"}
      />
      <section className="card full evidence-map-view">
        {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
        <div className="toolbar evidence-map-toolbar">
          <label>
            <span>Search evidence</span>
            <input
              value={search.q}
              onChange={(event) => setSearch({ q: event.target.value, entry: "" })}
              placeholder="Skill, story, metric..."
            />
          </label>
          {search.job ? (
            <Link className="tab" search={{ ...search, job: "", entry: "" }} to="/evidence-map">
              Clear job filter
            </Link>
          ) : null}
        </div>
        <div className="evidence-map-shell">
          <nav className="evidence-entry-list" aria-label="Evidence entries">
            {evidenceMap.isFetching && !evidenceMap.data ? (
              <Empty title="Loading evidence map." />
            ) : filteredEntries.length ? (
              <ul>
                {filteredEntries.map((entry) => (
                  <EvidenceEntryButton
                    entry={entry}
                    key={entry.entryId}
                    search={search}
                    selected={entry.entryId === selectedEntryId}
                  />
                ))}
              </ul>
            ) : (
              <Empty title="No evidence entries match." />
            )}
          </nav>
          <EvidenceDetail entry={selected} />
          <section className="evidence-side-panel" aria-labelledby="evidence-gaps-title">
            <h2 id="evidence-gaps-title">Gaps</h2>
            <GapList gaps={filteredGaps} />
            <h2>Reusable stories</h2>
            <StoryList entries={filteredEntries} />
          </section>
        </div>
      </section>
    </>
  );
}
