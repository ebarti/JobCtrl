import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo } from "react";

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
import { Empty } from "../../shared/ui/empty.js";
import { Field, FieldLabel } from "../../shared/ui/field.js";
import { Input } from "../../shared/ui/input.js";
import { PageHead } from "../../shared/ui/page-head.js";
import { RouteWorkspace } from "../../shared/ui/route-workspace.js";
import { StatusLabel } from "../../shared/ui/status-label.js";
import { ToolRow } from "../../shared/ui/tool-row.js";

function entryKindLabel(entry: EvidenceMapEntry): string {
  return entry.kind === "skill" ? "Skill" : "Achievement";
}

function gapKindLabel(gap: EvidenceGap): string {
  switch (gap.kind) {
    case "blocked_requirement":
      return "Blocked requirement";
    case "transferable_requirement":
      return "Transferable requirement";
    case "missing_skill":
      return "Missing skill";
    case "missing_requirement":
    default:
      return "Missing requirement";
  }
}

function tagTone(
  value: string | null | undefined,
): "danger" | "info" | "muted" | "ok" | "warn" {
  if (!value) return "muted";
  if (["covered", "matched", "verified", "declared"].includes(value))
    return "ok";
  if (["missing", "missing_from_profile", "blocked"].includes(value))
    return "danger";
  if (["transferable", "declared_only"].includes(value)) return "warn";
  return "info";
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

function requirementLinkLabel(usage: EvidenceUsageRef): string {
  return [usage.jobTitle || usage.jobKey, usage.requirementText]
    .filter(Boolean)
    .join(" · ");
}

function resumeLinkLabel(usage: EvidenceUsageRef): string {
  return [
    usage.jobTitle || usage.jobKey,
    usage.generatedTextPreview || usage.bulletId,
  ]
    .filter(Boolean)
    .join(" · ");
}

function UsageLink({ usage }: { readonly usage: EvidenceUsageRef }) {
  if (usage.kind === "resume_bullet" && usage.artifactId) {
    return (
      <Link
        className="evidence-usage-link"
        params={{ artifactId: usage.artifactId }}
        to="/artifacts/$artifactId"
      >
        <span>{resumeLinkLabel(usage)}</span>
        <span className="evidence-usage-kind mono">artifact</span>
      </Link>
    );
  }
  return (
    <Link
      className="evidence-usage-link"
      params={{ jobId: usage.jobKey }}
      to="/jobs/$jobId"
    >
      <span>{requirementLinkLabel(usage) || usage.jobKey}</span>
      <StatusLabel
        tone={tagTone(usage.requirementFitKind ?? usage.coverageState)}
      >
        {usage.requirementFitKind ?? usage.coverageState ?? "job"}
      </StatusLabel>
    </Link>
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
  search,
  selected,
}: {
  readonly entry: EvidenceMapEntry;
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
          <StatusLabel tone={tagTone(entry.freshness.evidenceStrength)}>
            {entry.freshness.evidenceStrength ?? "unrated"}
          </StatusLabel>
          <span className="meta">{usageCount} uses</span>
        </span>
      </Link>
    </li>
  );
}

function EvidenceDetail({
  entry,
}: {
  readonly entry: EvidenceMapEntry | null;
}) {
  if (!entry) {
    return <Empty title="Select evidence to inspect usage." />;
  }
  const freshness = entry.freshness;
  return (
    <div
      className="evidence-detail evidence-detail--workspace"
      aria-labelledby="evidence-detail-title"
    >
      <header>
        <p className="meta">{entryKindLabel(entry)}</p>
        <h2 id="evidence-detail-title">{entry.title}</h2>
        <div className="evidence-tags">
          <StatusLabel tone={tagTone(freshness.evidenceStrength)}>
            {freshness.evidenceStrength ?? "unrated"}
          </StatusLabel>
          <StatusLabel tone={freshness.userConfirmed ? "ok" : "warn"}>
            {freshness.userConfirmed ? "confirmed" : "unconfirmed"}
          </StatusLabel>
          <span className="evidence-date mono">
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
            <ul className="evidence-inline-list" aria-label="Story metrics">
              {entry.story.metrics.map((metric) => (
                <li key={metric}>{metric}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section className="evidence-detail-group">
        <h3>Skills and tags</h3>
        <ul className="evidence-inline-list">
          {[...entry.skills, ...entry.tags].map((value) => (
            <li key={value}>{value}</li>
          ))}
        </ul>
      </section>

      <UsageGroup title="Used in resumes" usages={entry.resumeUsages} />
      <UsageGroup
        title="Requirement fit history"
        usages={entry.requirementUsages}
      />
      <UsageGroup title="Coverage history" usages={entry.coverageUsages} />
    </div>
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
            <StatusLabel tone={tagTone(gap.fitKind ?? gap.kind)}>
              {gapKindLabel(gap)}
            </StatusLabel>
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
  const errorMessage =
    evidenceMap.error instanceof Error ? evidenceMap.error.message : null;

  const setSearch = (next: Partial<EvidenceMapSearch>) => {
    void navigate({
      search: (prev: EvidenceMapSearch) => ({ ...prev, ...next }),
    });
  };

  return (
    <div className="route-page route-page--evidence-map">
      <PageHead
        className="editorial-page-head"
        eyebrow="Library"
        title="Career evidence map"
        subtitle={
          <>
            <span>
              Trace canonical evidence through requirements, artifacts, and
              visible gaps.
            </span>
            <span className="page-head-count">
              {evidenceMap.data
                ? `${filteredEntries.length} entries`
                : "loading"}
            </span>
          </>
        }
      />
      {errorMessage ? (
        <div className="banner inline">{errorMessage}</div>
      ) : null}
      <RouteWorkspace
        aria-label="Career evidence workspace"
        className="evidence-map-view evidence-map-workspace"
        contentLabel="Selected evidence detail"
        inspectorLabel="Evidence gaps and reusable stories"
        navigationLabel="Evidence library"
        header={
          <ToolRow
            aria-label="Evidence map search"
            className="data-surface__tools evidence-map-workspace__tools"
            role="search"
            primary={
              <Field className="tool-row__search">
                <FieldLabel htmlFor="evidence-map-search">
                  Search evidence
                </FieldLabel>
                <Input
                  id="evidence-map-search"
                  value={search.q}
                  onChange={(event) =>
                    setSearch({ q: event.target.value, entry: "" })
                  }
                  placeholder="Skill, story, metric..."
                />
              </Field>
            }
            secondary={
              search.job ? (
                <Button asChild size="sm" variant="outline">
                  <Link
                    search={{ ...search, job: "", entry: "" }}
                    to="/evidence-map"
                  >
                    Clear job filter
                  </Link>
                </Button>
              ) : null
            }
          />
        }
        navigation={
          <nav
            className="evidence-entry-list evidence-entry-list--workspace"
            aria-label="Evidence entries"
          >
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
        }
        inspector={
          <section
            className="evidence-side-panel evidence-side-panel--workspace"
            aria-labelledby="evidence-gaps-title"
          >
            <h2 id="evidence-gaps-title">Gaps</h2>
            <GapList gaps={filteredGaps} />
            <h2>Reusable stories</h2>
            <StoryList entries={filteredEntries} />
          </section>
        }
      >
        <EvidenceDetail entry={selected} />
      </RouteWorkspace>
    </div>
  );
}
