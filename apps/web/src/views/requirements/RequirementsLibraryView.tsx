import { Link } from "@tanstack/react-router";
import type { SavedTableView } from "@jobctrl/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  AssociationStateAction, RequirementAssociationPicker, requirementQualifierText, achievementChoices,
  applicableAchievementIds, linkedAchievementIds, earlierAchievementRecords, earlierOnlyAchievementCount, requirementProfileMatch,
  useCurrentWordingActions, useCurrentWordingHistory, useRequirementAssociationHistory, useRequirementLibrary,
  type AchievementChoice, type LibraryRequirement, type UserAssociation,
} from "../../contexts/fit/index.js";
import { RequirementConsolidationPanel, requirementTableReturnState, requirementsLibrarySearchSchema, useRequirementCatalog, useRequirementHistory,
  type RequirementsTableState } from "../../contexts/requirements/index.js";
import { useProfileQuery, useWordingHistory, useWordingLibrary } from "../../contexts/profile/index.js";
import { useJobsReturnSearch } from "../../contexts/jobs/index.js";
import { DEFAULT_REQUIREMENTS_HIDDEN_COLUMN_IDS, REQUIREMENTS_TABLE_COLUMN_IDS, REQUIREMENTS_TABLE_ID,
  useRequirementsTableViewsStore, type SavedTablePresentation, type SavedTableViewSnapshot } from "../../shared/stores/saved-table-views.js";
import { Button } from "../../shared/ui/button.js";
import { FilterableDataGrid, isActiveDataGridFilter, type DataGridColumn } from "../../shared/ui/filterable-data-grid.js";
import { Input } from "../../shared/ui/input.js";
import { PageHead } from "../../shared/ui/page-head.js";
import { SavedTableViewsControl } from "../../shared/ui/saved-table-views-control.js";

type Coverage = LibraryRequirement["coverage"][number];
type Assignment = LibraryRequirement["wording_assignments"][number];
type EarlierRecords = NonNullable<LibraryRequirement["historical_alias_records"]>[number];
type Library = NonNullable<ReturnType<typeof useRequirementLibrary>["data"]>;
const DEFAULT_TABLE_PRESENTATION: SavedTablePresentation = {
  columns: { order: [...REQUIREMENTS_TABLE_COLUMN_IDS], hidden: [...DEFAULT_REQUIREMENTS_HIDDEN_COLUMN_IDS], widths: {} },
  density: null, grouping: null, colorRules: [],
};

function categoryLabel(requirement: LibraryRequirement) {
  return requirement.category === "skill" ? "Skill" : "Professional experience";
}

function readable(value: string) {
  const text = value.replaceAll("_", " ");
  return text ? text[0]!.toLocaleUpperCase() + text.slice(1) : text;
}

function WordingAssignmentHistory({ assignment, historical = false }: { assignment: Pick<Assignment, "assignment_id" | "profile_id">; historical?: boolean }) {
  const [offset, setOffset] = useState(0);
  const query = useCurrentWordingHistory(assignment.assignment_id, { profileId: assignment.profile_id, limit: 20, offset });
  return <div className="requirement-history__content">
    {query.isPending ? <p>Loading wording selection history…</p> : null}
    {query.error ? <p className="requirement-error" role="alert">{query.error.message}</p> : null}
    {query.data ? <>
      <ul className="requirement-history__list">{query.data.rows.map((row) => <li key={row.revision}>
        <strong>Selection revision {row.revision} · {row.state === "active" ? "Selected" : "Removed"}</strong>
        <span>Requirement revision {row.requirement_revision} · wording revision {row.variant_revision} · {historical ? "earlier record" : row.current ? "source pins current" : "needs review"}</span>
        <span>Wording {row.variant_id} · coverage {row.relation_id} · approval {row.approval_id}</span>
        {row.stale_reasons.length ? <span>Needs review: {row.stale_reasons.map(readable).join("; ")}</span> : null}
        <details><summary>Selection provenance</summary><pre>{JSON.stringify(row.selection_provenance, null, 2)}</pre></details>
      </li>)}</ul>
      {query.data.total > query.data.limit ? <HistoryPagination total={query.data.total} offset={offset} limit={query.data.limit} onOffset={setOffset} /> : null}
    </> : null}
  </div>;
}

function WordingAssignmentRecord({ assignment }: { assignment: Assignment }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Selection history</summary>
    <p>Requirement revision {assignment.requirement_revision} · wording revision {assignment.variant_revision}</p>
    {assignment.stale_reasons.length ? <p>Needs review: {assignment.stale_reasons.map(readable).join("; ")}</p> : null}
    {open ? <WordingAssignmentHistory assignment={assignment} /> : null}
  </details>;
}

function WordingSelectionAction({ library, requirement, achievementId, relation, variant }: {
  library: Library; requirement: LibraryRequirement; achievementId: string; relation: Coverage;
  variant: AchievementChoice["variants"][number];
}) {
  const actions = useCurrentWordingActions();
  const previous = requirement.wording_assignments.find((item) => item.achievement_id === achievementId);
  const others = library.requirements.flatMap((item) => item.current_wordings)
    .filter((item) => item.achievement_id === achievementId && item.requirement_id !== requirement.requirement_id);
  const variants = new Set(others.map((item) => JSON.stringify([item.variant_id, item.variant_revision])));
  variants.add(JSON.stringify([variant.variant_id, variant.revision]));
  const oneWording = variants.size <= 1;
  const requirementRevision = Number(relation.requirement_revision);
  const variantRevision = Number(relation.variant_revision);
  const supportingAssessment = requirement.demand_assessments
    ? requirement.demand_assessments.find((demand) => demand.current && demand.assessment?.assessment_id === relation.assessment_id)?.assessment
    : requirement.assessment?.assessment_id === relation.assessment_id ? requirement.assessment : null;
  const valid = library.profile_revision !== null && Number.isSafeInteger(requirementRevision) && requirementRevision > 0
    && Number.isSafeInteger(variantRevision) && variantRevision > 0
    && requirement.assessment_scope !== "consolidation_required"
    && relation.current && relation.covered && relation.status === "covered" && variant.status === "approved"
    && !!supportingAssessment?.current && ["matched", "transferable"].includes(supportingAssessment.kind)
    && supportingAssessment.achievement_ids.includes(achievementId)
    && relation.approval_id === variant.approval_id && requirementRevision === requirement.revision;
  if (!valid) return null;
  if (!oneWording) return <p className="muted">Update affected matches to review all linked requirements before maintaining a different wording.</p>;
  return <div className="requirement-wording__selection"><Button type="button" variant="outline" size="sm" disabled={actions.set.isPending} onClick={() => {
    if (library.profile_revision === null) return;
    actions.set.mutate({ profile_id: library.profile_id, expected_profile_revision: library.profile_revision,
      expected_revision: previous?.revision ?? 0, achievement_id: achievementId, requirement_id: requirement.requirement_id,
      requirement_revision: requirementRevision, variant_id: variant.variant_id, variant_revision: variantRevision,
      approval_id: relation.approval_id, relation_id: relation.relation_id });
  }}>{actions.set.isPending ? "Saving…" : "Use as current wording"}</Button>
    {actions.set.error ? <p className="requirement-error" role="alert">{actions.set.error.message} Reload to verify whether the selection was saved.</p> : null}
  </div>;
}

function AssociationHistory({ association, historical = false }: { association: Pick<UserAssociation, "association_id" | "profile_id">; historical?: boolean }) {
  const [offset, setOffset] = useState(0);
  const query = useRequirementAssociationHistory(association.association_id, { profileId: association.profile_id, limit: 20, offset });
  return <div className="requirement-history__content">
    {query.isPending ? <p>Loading link history…</p> : null}
    {query.error ? <p className="requirement-error" role="alert">{query.error.message}</p> : null}
    {query.data ? <>
      <ul className="requirement-history__list">{query.data.rows.map((row) => <li key={row.revision}>
        <strong>Revision {row.revision} · {row.state === "active" ? "Linked" : "Removed"}</strong>
        <span>Requirement revision {row.requirement_revision} · {historical ? "earlier record" : row.current ? "original pins current" : "original pins need review"} · {row.updated_at}</span>
        {row.wording ? <><span>Wording revision {row.wording.variant_revision}</span><blockquote>{row.wording.exact_text}</blockquote></> : <span>No specific wording linked.</span>}
      </li>)}</ul>
      {query.data.total > query.data.limit ? <HistoryPagination total={query.data.total} offset={offset} limit={query.data.limit} onOffset={setOffset} /> : null}
    </> : null}
  </div>;
}

function AssociationRecord({ association, onEdit }: { association: UserAssociation; onEdit?: (() => void) | undefined }) {
  const [open, setOpen] = useState(false);
  return <div className="requirement-association-record">
    <div className="requirement-association-action"><AssociationStateAction association={association} />
      {onEdit && association.state === "active" ? <Button type="button" variant="ghost" size="sm" onClick={onEdit}>Edit link</Button> : null}</div>
    <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Link history and pinned sources</summary>
      <p>Requirement revision {association.requirement_revision} · {association.wording ? `wording revision ${association.wording.variant_revision}` : "achievement link"}</p>
      {association.achievement_source_refs.map((ref) => <p key={`${ref.source_id}:${ref.revision}`}>Source {ref.source_id} · revision {ref.revision}</p>)}
      {association.stale_reasons.length ? <p>Needs review: {association.stale_reasons.map(readable).join("; ")}.</p> : null}
      {open ? <AssociationHistory association={association} /> : null}
    </details>
  </div>;
}

function HistoryPagination({ total, offset, limit, onOffset }: { total: number; offset: number; limit: number; onOffset: (value: number) => void }) {
  return <div className="requirement-history__pagination"><span>Showing {offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
    <Button type="button" variant="outline" size="sm" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - limit))}>Previous</Button>
    <Button type="button" variant="outline" size="sm" disabled={offset + limit >= total} onClick={() => onOffset(offset + limit)}>Next</Button>
  </div>;
}

function RequirementHistory({ requirementId, kind, filter, returnTable, historical }: { requirementId: string; kind: "revisions" | "occurrences"; filter: string; returnTable: string; historical: boolean }) {
  const [offset, setOffset] = useState(0);
  const jobsSearch = useJobsReturnSearch();
  const query = useRequirementHistory(requirementId, { kind, limit: 20, offset });
  const result = query.data;
  return <div className="requirement-history__content">
    {query.isPending ? <p>Loading history…</p> : null}
    {query.error ? <p className="requirement-error" role="alert">{query.error.message}</p> : null}
    {result?.kind === "revisions" ? result.rows.length ? <ul className="requirement-history__list">{result.rows.map((row) => <li key={`${row.requirement_id}:${row.revision}`}>
      <strong>Revision {row.revision} · {historical ? "Recorded historical meaning" : row.current ? "Current" : "Earlier meaning"}</strong>
      <p>{row.definition}</p><span>{requirementQualifierText(row)}</span>
      {row.requirement_id !== requirementId ? <span>Earlier identity {row.requirement_id}</span> : null}
      {row.stale_reasons.length ? <span>Needs review: {row.stale_reasons.map(readable).join("; ")}</span> : null}
    </li>)}</ul> : <p>No revisions recorded.</p> : null}
    {result?.kind === "occurrences" ? result.rows.length ? <ul className="requirement-history__list">{result.rows.map((row) => <li key={`${row.requirement_id}:${row.job_id}:${row.occurrence_id}:${row.snapshot_revision}`}>
      <div className="requirement-history__line"><strong>{historical ? "Historical posting reference" : row.current ? "Current posting reference" : "Earlier posting reference"}</strong>
        <Link to="/jobs/$jobId" params={{ jobId: row.job_id }} search={{ ...jobsSearch, returnRequirement: requirementId, returnRequirementsFilter: filter, returnRequirementsTable: returnTable, jobTab: "fit" }}>Open source job</Link></div>
      <blockquote>{row.text ?? row.definition}</blockquote>
      <p>Recorded meaning: {row.definition}</p><span>{requirementQualifierText(row)}{row.contract_version !== "requirements-v2" && row.tier ? ` · historical ${readable(row.tier)}` : ""}{row.contract_version !== "requirements-v2" && row.weight !== undefined ? ` · historical weight ${row.weight}` : ""}</span>
      {row.source_note ? <p>Posting context: {row.source_note}</p> : null}
      <details><summary>Source and provenance</summary>
        <p>Requirement {row.requirement_id} · revision {row.requirement_revision} · posting revision {row.posting_revision} · snapshot {row.snapshot_revision}{row.accepted ? " · accepted snapshot" : " · superseded snapshot"}</p>
        <p>Source {row.source_id} · revision {row.source_revision} · hash {row.source_hash}</p>
        {row.spans.map((span, index) => <blockquote key={`${span.start}:${span.end}:${index}`}>{span.quote}</blockquote>)}
        <p>Extraction {row.extraction_determination_id}{row.equivalence_determination_ids.length ? ` · equivalence ${row.equivalence_determination_ids.join(", ")}` : ""}</p>
        {row.stale_reasons.length ? <p>Needs review: {row.stale_reasons.map(readable).join("; ")}</p> : null}
      </details>
    </li>)}</ul> : <p>No posting references recorded.</p> : null}
    {result && result.total > result.limit ? <HistoryPagination total={result.total} offset={offset} limit={result.limit} onOffset={setOffset} /> : null}
  </div>;
}

function HistoryDisclosure({ requirementId, kind, title, filter, returnTable, historical = false }: { requirementId: string; kind: "revisions" | "occurrences"; title: string; filter: string; returnTable: string; historical?: boolean }) {
  const [open, setOpen] = useState(false);
  return <details className={historical ? undefined : "requirement-history"} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{title}</summary>
    {open ? <RequirementHistory requirementId={requirementId} kind={kind} filter={filter} returnTable={returnTable} historical={historical} /> : null}
  </details>;
}

function ConsolidatedIdentityHistory({ aliases, filter, returnTable }: { aliases: string[]; filter: string; returnTable: string }) {
  if (!aliases.length) return null;
  return <details className="requirement-history"><summary>Earlier consolidated identities · {aliases.length}</summary>
    <div className="requirement-history__content">
      <p>These records retain the definitions and posting references saved before consolidation.</p>
      {aliases.map((alias, index) => <section className="requirement-alias-history" key={alias} aria-label={`Earlier identity ${index + 1}`}>
        <h4>Earlier identity {index + 1}</h4>
        <p>Recorded identity: {alias}</p>
        <HistoryDisclosure requirementId={alias} kind="revisions" title="Definition history" filter={filter} returnTable={returnTable} historical />
        <HistoryDisclosure requirementId={alias} kind="occurrences" title="Source history and posting references" filter={filter} returnTable={returnTable} historical />
      </section>)}
    </div>
  </details>;
}

function EarlierAssociation({ association }: { association: EarlierRecords["associations"][number] }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Earlier link · recorded as {readable(association.state)}</summary>
    <p>Link {association.association_id} · revision {association.revision} · achievement {association.achievement_id}</p>
    {open ? <AssociationHistory association={association} historical /> : null}
  </details>;
}

function EarlierWording({ assignment }: { assignment: EarlierRecords["wording_assignments"][number] }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Earlier wording selection · recorded as {readable(assignment.state)}</summary>
    <p>Selection {assignment.assignment_id} · revision {assignment.revision} · achievement {assignment.achievement_id}</p>
    {open ? <WordingAssignmentHistory assignment={assignment} historical /> : null}
  </details>;
}

function EarlierFitRecords({ records, title = "Earlier links and assessments", regionLabel = "Earlier records" }: { records: EarlierRecords[]; title?: string; regionLabel?: string }) {
  const saved = records.filter((group) => group.assessments.length || group.associations.length || group.wording_assignments.length || group.coverage.length);
  if (!saved.length) return null;
  return <details className="requirement-history"><summary>{title}</summary>
    <div className="requirement-history__content">
      <p>These retained records belong to an earlier identity or source binding. They do not establish current support or wording coverage.</p>
      {saved.map((group, groupIndex) => <section className="requirement-alias-history" key={group.requirement_id} aria-label={`${regionLabel} ${groupIndex + 1}`}>
        <h4>Recorded requirement: {group.requirement_id}</h4>
        {group.assessments.map((assessment) => <details key={assessment.assessment_id}>
          <summary>Earlier assessment{assessment.kind ? ` · ${readable(assessment.kind)}` : ""}</summary>
          {assessment.rationale ? <p>{assessment.rationale}</p> : null}
          {assessment.evidence_refs?.map((ref, index) => <blockquote key={`${ref.source_id}:${ref.revision}:${index}`}>{ref.quote}<footer>Source {ref.source_id} · revision {ref.revision}</footer></blockquote>)}
          <p>Assessment {assessment.assessment_id}{assessment.determination_id ? ` · determination ${assessment.determination_id}` : ""}</p>
          {assessment.achievement_ids?.length ? <p>Recorded achievements: {assessment.achievement_ids.join(", ")}</p> : null}
        </details>)}
        {group.associations.map((association) => <EarlierAssociation key={association.association_id} association={association} />)}
        {group.wording_assignments.map((assignment) => <EarlierWording key={assignment.assignment_id} assignment={assignment} />)}
        {group.coverage.map((relation) => <details key={relation.relation_id}>
          <summary>Earlier wording coverage · {readable(relation.status)}</summary>
          {relation.rationale ? <p>{relation.rationale}</p> : null}
          {relation.source_refs?.map((ref, index) => <blockquote key={`${ref.source_id}:${ref.revision}:${index}`}>{ref.quote}<footer>Source {ref.source_id} · revision {ref.revision}</footer></blockquote>)}
          <p>Coverage {relation.relation_id} · assessment {relation.assessment_id} · achievement {relation.achievement_id}</p>
          {relation.variant_id ? <p>Wording {relation.variant_id}{relation.variant_revision !== undefined ? ` · revision ${relation.variant_revision}` : ""}{relation.approval_id ? ` · approval ${relation.approval_id}` : ""}</p> : null}
          {relation.determination_id ? <p>Determination {relation.determination_id}</p> : null}
        </details>)}
      </section>)}
    </div>
  </details>;
}

function HistoricalWording({ variantId, revision, initiallyOpen }: { variantId: string; revision: number | string; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const query = useWordingHistory(variantId, open);
  const wording = query.data?.revisions.find((item) => String(item.revision) === String(revision));
  return <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Recorded wording revision</summary>
    {open && query.isPending ? <p>Loading the saved wording revision…</p> : null}
    {open && query.error ? <p className="requirement-error" role="alert">The saved wording revision could not be loaded. <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>Retry</Button></p> : null}
    {open && wording ? <p className="requirement-wording__text">{wording.text}</p> : null}
    {open && query.data && !wording ? <p>The recorded wording revision is unavailable.</p> : null}
  </details>;
}

function WordingConnections({ library, requirement, achievementId, canLink, coverage, associations, assignments, achievement, sourceState, recordsAligned, onEditLink }: {
  library: Library; requirement: LibraryRequirement; achievementId: string; canLink: boolean;
  coverage: Coverage[]; associations: UserAssociation[]; assignments: LibraryRequirement["current_wordings"];
  achievement?: AchievementChoice | undefined; sourceState: "loading" | "error" | "ready"; recordsAligned: boolean; onEditLink?: (() => void) | undefined;
}) {
  type Group = { variantId: string; revision: number | string; coverage: Coverage[]; associations: UserAssociation[]; assignments: LibraryRequirement["current_wordings"] };
  const groups = new Map<string, Group>();
  for (const relation of coverage) {
    const key = JSON.stringify([relation.variant_id, String(relation.variant_revision)]);
    const group = groups.get(key) ?? { variantId: relation.variant_id, revision: relation.variant_revision, coverage: [], associations: [], assignments: [] };
    group.coverage.push(relation); groups.set(key, group);
  }
  for (const association of associations) {
    if (!association.wording) continue;
    const key = JSON.stringify([association.wording.variant_id, String(association.wording.variant_revision)]);
    const group = groups.get(key) ?? { variantId: association.wording.variant_id, revision: association.wording.variant_revision, coverage: [], associations: [], assignments: [] };
    group.associations.push(association); groups.set(key, group);
  }
  for (const assignment of assignments) {
    const key = JSON.stringify([assignment.variant_id, String(assignment.variant_revision)]);
    const group = groups.get(key) ?? { variantId: assignment.variant_id, revision: assignment.variant_revision, coverage: [], associations: [], assignments: [] };
    group.assignments.push(assignment); groups.set(key, group);
  }
  if (!groups.size) return <p className="muted">No specific wordings are linked to this requirement.</p>;
  const entries = [...groups.values()];
  const variantFor = (group: Group) => achievement?.variants.find((item) => item.variant_id === group.variantId && String(item.revision) === String(group.revision));
  // Membership in current_wordings is the recorded selection; current is source freshness.
  const maintained = entries.filter((group) => group.assignments.length > 0);
  const history = entries.filter((group) => !group.assignments.length);
  const cards = (items: Group[]) => <div className="requirement-wordings">{items.map((group) => {
    const variant = variantFor(group);
    const pinnedText = group.associations[0]?.wording?.exact_text;
    return <article className="requirement-wording" key={JSON.stringify([group.variantId, group.revision])}>
      <div className="requirement-wording__heading"><h5>{requirement.definition}</h5>
        {variant ? <span className="requirement-badge">{readable(variant.status)}</span> : <span className="requirement-badge">{sourceState === "loading" ? "Loading wording" : sourceState === "error" ? "Wording unavailable" : "Earlier revision"}</span>}</div>
      {group.assignments.map((assignment) => <div key={assignment.assignment_id}><span className="requirement-badge">{assignment.current && recordsAligned ? "Current wording" : "Current wording · needs review"}</span><WordingAssignmentRecord assignment={assignment} /></div>)}
      {variant && pinnedText && variant.text !== pinnedText ? <div><strong>Saved link text</strong><p className="requirement-wording__text">{pinnedText}</p><strong>Current wording text</strong><p className="requirement-wording__text">{variant.text}</p></div>
        : variant || pinnedText ? <p className="requirement-wording__text">{variant?.text ?? pinnedText}</p>
        : sourceState === "loading" ? <p>Loading the recorded wording…</p>
        : <HistoricalWording variantId={group.variantId} revision={group.revision} initiallyOpen={group.assignments.length > 0} />}
      {group.coverage.map((relation) => <div className="requirement-wording__coverage" key={relation.relation_id}>
        <span className="requirement-badge">{relation.current ? "Wording coverage" : "Earlier coverage · needs review"}: {relation.covered ? "Covered" : "Not covered"}</span>
        <details><summary>Coverage details</summary><p>{relation.rationale}</p><p>Status: {readable(relation.status)} · requirement revision {relation.requirement_revision} · wording revision {relation.variant_revision}</p>
          <p>Determination {relation.determination_id} · approval {relation.approval_id}</p>
          {relation.stale_reasons.length ? <p>Needs review: {relation.stale_reasons.map(readable).join("; ")}</p> : null}
        </details>
      </div>)}
      {canLink && variant && !group.assignments.some((assignment) => assignment.current) && group.coverage.filter((relation) => relation.current && relation.covered && relation.status === "covered").slice(0, 1).map((relation) => <WordingSelectionAction key={relation.relation_id} library={library} requirement={requirement} achievementId={achievementId} relation={relation} variant={variant} />)}
      {group.associations.map((association) => <AssociationRecord key={association.association_id} association={association} onEdit={onEditLink} />)}
    </article>;
  })}</div>;
  return <div className="requirement-wording-groups">
    {maintained.length ? <>{maintained.length > 1 ? <p role="alert">More than one current selection is recorded for this requirement. Review the saved assignments.</p> : null}
      {cards(maintained)}</> : <p className="muted">No current wording has been selected for this requirement.</p>}
    {history.length ? <details open={!maintained.length}><summary>Other wordings, proposals and history · {history.length}</summary>{cards(history)}</details> : null}
  </div>;
}

function LinkedAchievement({ library, requirement, achievementId, achievement, onOpenAchievement, onLinkWording, onEditLink, canLink, sourceState, recordsAligned }: {
  library: Library; requirement: LibraryRequirement; achievementId: string; achievement?: AchievementChoice | undefined;
  onOpenAchievement?: ((roleId: string, achievementId: string) => void) | undefined;
  onLinkWording: (achievementId: string) => void; onEditLink: (achievementId: string) => void; canLink: boolean; sourceState: "loading" | "error" | "ready"; recordsAligned: boolean;
}) {
  const assessment = requirement.assessment?.achievement_ids.includes(achievementId) ? requirement.assessment : null;
  const demandCount = (requirement.demand_assessments ?? [])
    .filter((demand) => demand.assessment?.achievement_ids.includes(achievementId)).length;
  const coverage = requirement.coverage.filter((row) => row.achievement_id === achievementId);
  const assignments = requirement.current_wordings.filter((row) => row.achievement_id === achievementId);
  const associations = requirement.associations.filter((row) => row.achievement_id === achievementId && row.state === "active");
  const earlier = earlierAchievementRecords(requirement, achievementId);
  const earlierOnly = !applicableAchievementIds(requirement).includes(achievementId);
  return <article className="requirement-achievement" data-achievement-id={achievementId}>
    <div className="requirement-achievement__heading"><div><h4>{achievement?.roleLabel ?? (sourceState === "loading" ? "Loading achievement…" : "Unavailable achievement")}</h4>{achievement?.dateRange ? <p className="muted">{achievement.dateRange}</p> : null}</div>
      {achievement && onOpenAchievement ? <Button type="button" variant="ghost" size="sm" onClick={() => onOpenAchievement(achievement.roleId, achievementId)}>Open achievement →</Button> : null}</div>
    <p className="requirement-achievement__fact">{achievement?.text ?? (sourceState === "loading" ? "Loading saved achievement details…" : sourceState === "error" ? "The achievement could not be loaded." : "This achievement is no longer available in the saved Profile.")}</p>
    {earlierOnly ? <><span className="requirement-badge">Earlier relationship · needs review</span>
      <p className="muted">This retained relationship does not establish a current Profile match or wording coverage. Its original evidence remains available below.</p></> : null}
    {assessment ? <div className="requirement-assessment"><span className="requirement-badge">{assessment.current ? "Factual assessment" : "Earlier assessment · needs review"}: {readable(assessment.kind)}</span>
      <details><summary>Assessment and evidence</summary><p>{assessment.rationale}</p>
        {assessment.evidence_refs.map((ref, index) => <blockquote key={`${ref.source_id}:${ref.revision}:${index}`}>{ref.quote}<footer>Source {ref.source_id} · revision {ref.revision}</footer></blockquote>)}
        <p>Requirement revision {assessment.requirement_revision} · {readable(assessment.origin)} · determination {assessment.determination_id}</p>
        {assessment.stale_reasons.length ? <p>Needs review: {assessment.stale_reasons.map(readable).join("; ")}</p> : null}
      </details></div> : demandCount ? <p className="muted">Recorded support is linked to {demandCount} {demandCount === 1 ? "job-specific demand" : "job-specific demands"}. Review the demand evidence above.</p> : null}
    {associations.filter((association) => !association.wording).map((association) => <AssociationRecord key={association.association_id} association={association} onEdit={canLink && achievement ? () => onEditLink(achievementId) : undefined} />)}
    <div className="requirement-section-heading"><h5>Wordings for this requirement</h5>
      {achievement && canLink ? <Button type="button" variant="outline" size="sm" onClick={() => onLinkWording(achievementId)}>Link wording</Button> : null}</div>
    {earlierOnly ? <p className="muted">No current wording has been selected for this requirement.</p>
      : <WordingConnections library={library} requirement={requirement} achievementId={achievementId} canLink={canLink} coverage={coverage} associations={associations} assignments={assignments} achievement={achievement} sourceState={sourceState} recordsAligned={recordsAligned} onEditLink={canLink && achievement ? () => onEditLink(achievementId) : undefined} />}
    {earlier.length ? <details className="requirement-achievement__identity"><summary>Recorded achievement identity</summary><p>{achievementId}</p></details> : null}
    <EarlierFitRecords records={earlier} title="Earlier relationship sources" regionLabel="Earlier achievement sources" />
  </article>;
}

function JobSpecificDemands({ requirement, filter, returnTable }: { requirement: LibraryRequirement; filter: string; returnTable: string }) {
  const jobsSearch = useJobsReturnSearch();
  const demands = requirement.demand_assessments ?? [];
  if (!demands.length) return null;
  return <section className="requirement-demands" aria-label="Job-specific demands">
    <h3>Job-specific demands</h3>
    <p className="muted">{requirement.assessment_scope === "consolidation_required"
      ? "Some saved job demands need consolidation. The recorded demands below may be incomplete."
      : "Each demand records what the listed jobs require. Its Profile match depends on the saved assessment and its freshness."}</p>
    <ol className="requirement-demands__list">{demands.map((demand, index) => {
      const assessment = demand.assessment;
      const status = demand.state === "profile_required" ? "Profile required"
        : demand.state === "not_assessed" ? "Not assessed"
        : demand.state === "stale" ? assessment ? `Earlier · ${readable(assessment.kind)}` : "Needs review"
        : assessment ? readable(assessment.kind) : "Assessment unavailable";
      return <li key={demand.demand_fingerprint}><details>
        <summary>Demand {index + 1} · {status} · {demand.job_ids.length} {demand.job_ids.length === 1 ? "job" : "jobs"}</summary>
        <div className="requirement-demands__content">
          <p>{demand.definition}</p>
          {assessment ? <><p><strong>{assessment.origin === "bundled_synthetic_example" ? "Authored synthetic illustration" : assessment.current && demand.current ? "Recorded factual support" : "Earlier factual support · needs review"}:</strong> {readable(assessment.kind)}</p>
            {assessment.origin === "bundled_synthetic_example" && (!assessment.current || !demand.current) ? <p>Earlier example · needs review.</p> : null}
            <p>{assessment.rationale}</p>
            {assessment.wording_support === "section" ? <p>Supported by saved Profile section evidence.</p> : null}
            {assessment.evidence_refs.map((ref, evidenceIndex) => <blockquote key={`${ref.source_id}:${ref.revision}:${evidenceIndex}`}>{ref.quote}<footer>Source {ref.source_id} · revision {ref.revision}</footer></blockquote>)}
            <p>{assessment.origin === "bundled_synthetic_example" ? "Example" : "Determination"} {assessment.determination_id} · confidence {readable(assessment.confidence)}</p>
            {assessment.stale_reasons.length ? <p>Assessment needs review: {assessment.stale_reasons.map(readable).join("; ")}</p> : null}
          </> : <p>{status}.</p>}
          {demand.stale_reasons.length ? <p>Demand needs review: {demand.stale_reasons.map(readable).join("; ")}</p> : null}
          <details><summary>Source jobs and demand identity</summary>
            <p>Capability definition: {demand.capability_definition}</p>
            <p>Demand {demand.demand_fingerprint} · normalization {demand.normalization_version}</p>
            <ul>{demand.job_ids.map((jobId, jobIndex) => <li key={jobId}><Link to="/jobs/$jobId" params={{ jobId }} search={{ ...jobsSearch, returnRequirement: requirement.requirement_id, returnRequirementsFilter: filter, returnRequirementsTable: returnTable, jobTab: "fit" }}>Open source job {jobIndex + 1}</Link></li>)}</ul>
          </details>
        </div>
      </details></li>;
    })}</ol>
  </section>;
}

function RequirementDetail({ library, requirement, aliases, choices, canLink, onOpenAchievement, onLinkAchievement, onLinkWording, onEditLink, filter, returnTable, sourceState, recordsAligned }: {
  library: Library; requirement: LibraryRequirement; choices: AchievementChoice[]; canLink: boolean; filter: string; returnTable: string; sourceState: "loading" | "error" | "ready"; recordsAligned: boolean;
  aliases: string[];
  onOpenAchievement?: ((roleId: string, achievementId: string) => void) | undefined;
  onLinkAchievement: () => void; onLinkWording: (achievementId: string) => void; onEditLink: (achievementId: string) => void;
}) {
  const removed = requirement.associations.filter((association) => association.state === "removed");
  const achievementIds = linkedAchievementIds(requirement);
  return <section className="requirements-detail" aria-labelledby="requirement-definition-title" tabIndex={-1}>
    <div className="requirements-definition"><span className="requirements-definition__eyebrow">Reusable requirement · revision {requirement.revision}</span>
      <h2 id="requirement-definition-title">{requirement.name}</h2>
      <p>{requirement.definition}</p>
      <p>{requirementQualifierText(requirement)}</p>
      <details><summary>Definition identity</summary><p>Requirement {requirement.requirement_id} · revision {requirement.revision}</p></details>
      <p><strong>Profile match: {requirementProfileMatch(requirement)}</strong></p>
      <p className="muted">Profile match compares saved Profile facts with each job-specific demand. Earlier assessments need review; an achievement link alone does not prove a match.</p>
    </div>
    {requirement.demand_assessments?.length ? <JobSpecificDemands requirement={requirement} filter={filter} returnTable={returnTable} /> : requirement.assessment ? <section className="requirement-assessment" aria-label="Recorded factual support">
      <h3>Factual support</h3>
      <p>{requirement.assessment.origin === "bundled_synthetic_example" ? "Authored synthetic illustration" : requirement.assessment.current ? "Current assessment" : "Earlier assessment · needs review"}: {readable(requirement.assessment.kind)}</p>
      <p>{requirement.assessment.rationale}</p>
      {requirement.assessment.wording_support === "section" ? <p>Supported by saved Profile section evidence. This support does not need achievement wording.</p> : null}
      <details><summary>Supporting sources and determination</summary>
        {requirement.assessment.evidence_refs.map((ref, index) => <blockquote key={`${ref.source_id}:${ref.revision}:${index}`}>{ref.quote}<footer>Source {ref.source_id} · revision {ref.revision}</footer></blockquote>)}
        <p>Determination {requirement.assessment.determination_id} · confidence {readable(requirement.assessment.confidence)}</p>
        {requirement.assessment.stale_reasons.length ? <p>Needs review: {requirement.assessment.stale_reasons.map(readable).join("; ")}</p> : null}
      </details>
    </section> : null}
    <div className="requirement-section-heading"><h3>Linked achievements <span className="requirement-count">{achievementIds.length}</span></h3>
      {canLink ? <Button type="button" variant="outline" size="sm" onClick={onLinkAchievement}>Link achievement</Button> : null}</div>
    <p className="requirement-relationship-help muted">Includes earlier recorded relationships that need review. Removed links stay in history; this count does not assert current support.</p>
    {!achievementIds.length ? <div className="requirement-empty"><strong>No achievements linked.</strong><p>{requirement.assessment?.wording_support === "section" ? "The recorded support comes from a Profile section. An achievement link is optional." : "You can link a saved achievement. A link remains unassessed until you manually update affected matches."}</p></div> : null}
    <div className="requirements-achievements">{achievementIds.map((achievementId) => <LinkedAchievement key={achievementId} library={library} requirement={requirement} achievementId={achievementId}
      achievement={choices.find((choice) => choice.achievementId === achievementId)} onOpenAchievement={onOpenAchievement}
      onLinkWording={onLinkWording} onEditLink={onEditLink} canLink={canLink} sourceState={sourceState} recordsAligned={recordsAligned} />)}</div>
    {removed.length ? <details className="requirement-history"><summary>Removed links · {removed.length}</summary><div className="requirement-history__content">
      {removed.map((association) => { const achievement = choices.find((choice) => choice.achievementId === association.achievement_id);
        return <div className="requirement-removed" key={association.association_id}><strong>{achievement?.roleLabel ?? "Unavailable achievement"}</strong>
          <p>{association.wording?.exact_text ?? achievement?.text ?? "Achievement text unavailable"}</p>
          <AssociationRecord association={association} /></div>; })}</div></details> : null}
    {requirement.wording_assignments.some((item) => item.state === "removed") ? <details className="requirement-history"><summary>Removed wording selections</summary><div className="requirement-history__content">
      {requirement.wording_assignments.filter((item) => item.state === "removed").map((assignment) => <div className="requirement-removed" key={assignment.assignment_id}>
        <strong>{choices.find((choice) => choice.achievementId === assignment.achievement_id)?.roleLabel ?? "Unavailable achievement"}</strong>
        <p>Previously selected wording revision {assignment.variant_revision} · {assignment.current ? "source pins current" : "needs review"}</p>
        <WordingAssignmentRecord assignment={assignment} /></div>)}
    </div></details> : null}
    <HistoryDisclosure requirementId={requirement.requirement_id} kind="revisions" title="Definition history" filter={filter} returnTable={returnTable} />
    <HistoryDisclosure requirementId={requirement.requirement_id} kind="occurrences" title="Source history and posting references" filter={filter} returnTable={returnTable} />
    <EarlierFitRecords records={requirement.historical_alias_records ?? []} />
    <ConsolidatedIdentityHistory aliases={aliases} filter={filter} returnTable={returnTable} />
  </section>;
}

export function RequirementsLibraryView({ selectedRequirementId, onSelectRequirement, onOpenAchievement, tableState, onTableStateChange }: {
  selectedRequirementId?: string | null;
  onSelectRequirement?: ((id: string | null) => void) | undefined;
  onOpenAchievement?: ((roleId: string, achievementId: string) => void) | undefined;
  tableState?: RequirementsTableState;
  onTableStateChange?: ((state: RequirementsTableState) => void) | undefined;
}) {
  const library = useRequirementLibrary();
  const catalog = useRequirementCatalog({ limit: 1 });
  const profile = useProfileQuery();
  const wording = useWordingLibrary();
  const choices = achievementChoices(profile.data?.profile, wording.data);
  const [localTableState, setLocalTableState] = useState<RequirementsTableState>(() => requirementsLibrarySearchSchema.parse({}));
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ achievementId?: string; requireWording?: boolean } | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const previousSelection = useRef<string | null>(null);
  const presentation = useRequirementsTableViewsStore((state) => state.presentationByTable[REQUIREMENTS_TABLE_ID]) ?? DEFAULT_TABLE_PRESENTATION;
  const setPresentation = useRequirementsTableViewsStore((state) => state.setTablePresentation);
  const requirements = library.data?.requirements ?? [];
  const navigation = tableState ?? localTableState;
  const search = navigation.q;
  const needle = search.trim().toLocaleLowerCase();
  const shown = requirements.filter((requirement) => `${requirement.name}\n${requirement.definition}`.toLocaleLowerCase().includes(needle));
  const requestedId = selectedRequirementId === undefined ? localSelected : selectedRequirementId;
  const catalogAligned = Boolean(library.data && catalog.data && library.data.catalog_revision === catalog.data.catalog_revision);
  const selectedId = requestedId && catalogAligned ? catalog.data?.aliases?.[requestedId] ?? requestedId : requestedId;
  const selected = selectedId ? requirements.find((item) => item.requirement_id === selectedId) : undefined;
  const resolvedAlias = Boolean(requestedId && selectedId && requestedId !== selectedId);
  const filters = navigation.column_filters ?? {};
  const sort = { columnId: navigation.sort, direction: navigation.dir };
  const hasFilters = Boolean(needle) || Object.values(filters).some(isActiveDataGridFilter);
  const returnTable = requirementTableReturnState(navigation);
  useEffect(() => {
    if (selectedId && !library.isPending && selectedId !== previousSelection.current) detailRef.current?.focus();
    if (!selectedId && previousSelection.current) {
      const row = [...(tableRef.current?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [])]
        .find((item) => item.dataset["rowId"] === previousSelection.current && item.getClientRects().length > 0);
      const activation = row?.querySelector<HTMLButtonElement>("[data-grid-control='row-activation']");
      if (activation) activation.focus({ preventScroll: true });
      else tableRef.current?.focus({ preventScroll: true });
    }
    if (!library.isPending) previousSelection.current = selectedId;
  }, [selectedId, library.isPending]);
  const select = (id: string | null) => {
    setPicker(null); setLocalSelected(id); onSelectRequirement?.(id);
  };
  const changeTable = (next: RequirementsTableState) => {
    const normalized = requirementsLibrarySearchSchema.parse(next);
    setLocalTableState(normalized); onTableStateChange?.(normalized);
  };
  const setSearch = (q: string) => changeTable({ ...navigation, q, page: 1 });
  const applyView = (view: SavedTableView) => {
    changeTable(requirementsLibrarySearchSchema.parse({ q: view.urlFilters.q ?? "", sort: view.sort.columnId,
      dir: view.sort.direction, pageSize: view.urlFilters.pageSize ?? 25, column_filters: view.gridFilters }));
  };
  const columns = useMemo<Array<DataGridColumn<LibraryRequirement>>>(() => [
    { id: "name", label: "Requirement", rowHeader: true, width: 260, minWidth: 180,
      getSortValue: (row) => row.name, getFilterValue: (row) => row.name,
      render: (row) => <strong className="requirements-table__name">{row.name}</strong> },
    { id: "category", label: "Category", width: 200, minWidth: 160, getSortValue: categoryLabel, getFilterValue: categoryLabel,
      render: (row) => categoryLabel(row) },
    { id: "definition", label: "Definition", width: 340, minWidth: 200,
      getSortValue: (row) => row.definition, getFilterValue: (row) => row.definition,
      render: (row) => <span className="requirements-table__definition">{row.definition}</span> },
    { id: "support", label: "Profile match", width: 190, minWidth: 160, getSortValue: requirementProfileMatch, getFilterValue: requirementProfileMatch,
      filterDescription: "Recorded support from saved Profile facts for each job demand. Earlier assessments need review.",
      render: (row) => <span>{requirementProfileMatch(row)}{row.demand_assessments?.length ? <small className="requirements-table__secondary">{row.demand_assessments.length} job-specific {row.demand_assessments.length === 1 ? "demand" : "demands"}</small> : null}{row.assessment?.current && row.assessment.wording_support === "section" ? <small className="requirements-table__secondary">Profile section support</small> : null}</span> },
    { id: "achievements", label: "Linked achievements", width: 170, minWidth: 150,
      getSortValue: (row) => linkedAchievementIds(row).length, getFilterValue: (row) => String(linkedAchievementIds(row).length),
      render: (row) => <span>{linkedAchievementIds(row).length}{earlierOnlyAchievementCount(row) ? <small className="requirements-table__secondary">{earlierOnlyAchievementCount(row)} earlier · needs review</small> : null}</span> },
    { id: "wordings", label: "Current wordings", width: 160, minWidth: 140,
      getSortValue: (row) => row.current_wordings.length, getFilterValue: (row) => String(row.current_wordings.length),
      render: (row) => <span>{row.current_wordings.length}{row.current_wordings.some((item) => !item.current) ? <small className="requirements-table__secondary">Needs review</small> : null}</span> },
    { id: "revision", label: "Revision", width: 120, minWidth: 100,
      getSortValue: (row) => row.revision, getFilterValue: (row) => String(row.revision), render: (row) => row.revision },
  ], []);
  const snapshot: SavedTableViewSnapshot = { ...presentation, sort, urlFilters: { q: search, pageSize: navigation.pageSize }, gridFilters: filters };
  const sourceState = profile.isPending || wording.isPending ? "loading" : profile.error || wording.error ? "error" : "ready";
  const mismatch = !!library.data && library.data.readiness === "ready" && !!profile.data && !!wording.data
    && (library.data.profile_revision !== profile.data.profileVersion || library.data.profile_revision !== wording.data.profileVersion);
  const canLink = !!library.data && library.data.readiness === "ready" && !library.error && !profile.error && !wording.error
    && library.data.profile_revision === profile.data?.profileVersion && library.data.profile_revision === wording.data?.profileVersion;
  return <div className={`requirements-workspace${selectedId ? " requirements-workspace--selected" : ""}`}>
    <PageHead eyebrow="Library" title="Requirements library" subtitle="Reusable Skills and Professional Experience, their recorded support, and approved wording. Education and languages stay with each job." />
    {library.data?.synthetic ? <p role="note">Synthetic catalog: bundled source examples and your unassessed links. Illustrated support is authored teaching content; no model assessment ran.</p> : null}
    <section className="requirements-library" aria-label="Requirements library">
      {library.error ? <div className="requirement-error" role="alert"><p>{library.error.message}{library.data ? " Showing the last available data." : ""}</p><Button type="button" variant="outline" size="sm" onClick={() => void library.refetch()}>Retry</Button></div> : null}
      {catalog.error ? <div className="requirement-error" role="alert"><p>Catalog readiness and saved links could not be refreshed. {catalog.data ? "The last loaded catalog state remains available." : "Saved requirement records remain available."}</p><Button type="button" variant="outline" size="sm" onClick={() => void catalog.refetch()}>Retry catalog</Button></div> : null}
      {library.data && catalog.data && !catalogAligned ? <p role="status">The saved catalog and requirement relationships are from different revisions. Refresh both before following consolidated links. <Button type="button" variant="outline" size="sm" onClick={() => { void Promise.all([catalog.refetch(), library.refetch()]); }}>Refresh records</Button></p> : null}
      <RequirementConsolidationPanel normalization={catalog.data?.normalization} catalogUnavailable={!catalog.data || Boolean(catalog.error)} onSettled={() => { void library.refetch(); }} />
      {profile.error || wording.error ? <p className="requirement-error" role="alert">Achievement details could not be refreshed. Saved requirement records remain available.</p> : null}
      {mismatch ? <p role="status">The Profile and requirement records are from different revisions. Refresh them before changing links or wording. <Button type="button" variant="outline" size="sm" onClick={() => { void Promise.all([library.refetch(), profile.refetch(), wording.refetch()]); }}>Refresh records</Button></p> : null}
      {library.data?.readiness === "profile_required" ? <p className="muted">Save a Profile to link achievements to requirements.</p> : null}
      <p className="muted">Profile match compares saved Profile facts with job-specific demands. Linked achievements includes earlier recorded relationships that need review; links alone do not prove a match.</p>
      <div className="requirements-library__layout">
        <div className="requirements-library__table" ref={tableRef} tabIndex={-1}>
          <FilterableDataGrid title="Saved requirements" data={shown} columns={columns} getRowId={(row) => row.requirement_id}
            loading={library.isPending} loadingMessage="Loading saved requirements…"
            emptyMessage={library.error && !library.data ? "Saved requirements could not be loaded." : hasFilters ? "No requirements match these filters." : "No current requirements recorded yet. Extract requirements from a saved job to add its Skills and Professional Experience."}
            initialSort={{ columnId: "name", direction: "asc" }} sort={sort}
            onSortChange={(next) => changeTable(requirementsLibrarySearchSchema.parse({ ...navigation, sort: next.columnId, dir: next.direction, page: 1 }))}
            filters={filters} onFiltersChange={(column_filters) => changeTable({ ...navigation, column_filters, page: 1 })}
            pagination={{ page: navigation.page, pageSize: navigation.pageSize, pageSizeOptions: [25, 50, 100, 200],
              onPageChange: (page) => changeTable({ ...navigation, page }), onPageSizeChange: (pageSize) => changeTable({ ...navigation, pageSize, page: 1 }) }} manualPagination={false}
            columnOrder={presentation.columns.order} columnVisibility={Object.fromEntries(presentation.columns.hidden.map((id) => [id, false]))}
            onColumnOrderChange={(order) => setPresentation(REQUIREMENTS_TABLE_ID, { ...presentation, columns: { ...presentation.columns, order: [...order] } })}
            columnWidths={presentation.columns.widths} onColumnWidthsChange={(widths) => setPresentation(REQUIREMENTS_TABLE_ID, { ...presentation, columns: { ...presentation.columns, widths } })}
            density={presentation.density} grouping={presentation.grouping} colorRules={presentation.colorRules} showColumnFilterMenu
            tableClassName="requirements-data-grid-table" rowAriaSelected={(row) => row.requirement_id === selectedId}
            onRowActivate={(row) => select(row.requirement_id)} rowActivationLabel={(row) => `Open ${row.name}`}
            mobileLayout="cards" mobileListLabel="Saved requirements"
            renderMobileRow={(row) => <><strong className="requirements-table__name">{row.name}</strong><span className="requirements-table__secondary">{categoryLabel(row)}</span>
              <dl className="requirements-table__mobile-facts"><div><dt>Profile match</dt><dd>{requirementProfileMatch(row)}{row.demand_assessments?.length ? <small className="requirements-table__secondary">{row.demand_assessments.length} job-specific {row.demand_assessments.length === 1 ? "demand" : "demands"}</small> : null}</dd></div><div><dt>Linked achievements</dt><dd>{linkedAchievementIds(row).length}{earlierOnlyAchievementCount(row) ? <small className="requirements-table__secondary">{earlierOnlyAchievementCount(row)} earlier · needs review</small> : null}</dd></div><div><dt>Current wordings</dt><dd>{row.current_wordings.length}{row.current_wordings.some((item) => !item.current) ? " · Needs review" : ""}</dd></div></dl></>}
            toolbarActions={<><label className="requirements-table-search"><span className="sr-only">Find a requirement</span><Input value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Filter saved requirements" /></label>
              {hasFilters ? <Button type="button" variant="ghost" size="sm" onClick={() => changeTable({ ...navigation, q: "", column_filters: {}, page: 1 })}>Clear all filters</Button> : null}
              <SavedTableViewsControl tableId={REQUIREMENTS_TABLE_ID} useViewsStore={useRequirementsTableViewsStore} columnOptions={columns.map((column) => ({ id: column.id, label: column.label }))}
                snapshot={snapshot} onApplyView={applyView} onPresentationChange={(next) => setPresentation(REQUIREMENTS_TABLE_ID, next)} /></>}
          />
        </div>
        {selectedId ? <div className="requirements-library__detail" ref={detailRef} tabIndex={-1} role="region" aria-label="Requirement details">
          <div className="requirements-detail__navigation"><Button type="button" variant="ghost" size="sm" onClick={() => select(null)}>← Back to requirements</Button></div>
          {selected && resolvedAlias ? <p className="requirements-detail__filter-note" role="status">This saved link points to a consolidated requirement.</p> : null}
          {selected && needle && !shown.some((row) => row.requirement_id === selectedId) ? <p className="requirements-detail__filter-note" role="status">The selected requirement is outside the current search filter.</p> : null}
          {selected ? <RequirementDetail key={selected.requirement_id} library={library.data!} requirement={selected} aliases={catalogAligned ? Object.entries(catalog.data?.aliases ?? {}).filter(([, root]) => root === selected.requirement_id).map(([alias]) => alias).sort() : []} choices={choices} canLink={canLink} filter={search} returnTable={returnTable} sourceState={sourceState} recordsAligned={sourceState === "ready" && !mismatch} onOpenAchievement={onOpenAchievement}
            onLinkAchievement={() => setPicker({})} onLinkWording={(achievementId) => setPicker({ achievementId, requireWording: true })} onEditLink={(achievementId) => setPicker({ achievementId })} />
            : library.isPending || catalog.isPending ? <p role="status">Loading the selected requirement…</p> : catalog.error || !catalogAligned ? <div className="requirement-empty"><strong>Saved requirement links are unavailable.</strong><p>Refresh the catalog and relationships before following this link.</p></div> : <div className="requirement-empty"><strong>Requirement unavailable in the current library.</strong><p>Select another saved definition from the table.</p></div>}
        </div> : null}
      </div>
    </section>
    {picker && selected && library.data ? <RequirementAssociationPicker library={library.data} choices={choices} profileVersion={profile.data?.profileVersion} wordingProfileVersion={wording.data?.profileVersion} sourceLoading={profile.isPending || wording.isPending} sourceError={profile.error?.message ?? wording.error?.message} requirementId={selected.requirement_id} achievementId={picker.achievementId} requireWording={picker.requireWording} onClose={() => setPicker(null)} /> : null}
  </div>;
}
