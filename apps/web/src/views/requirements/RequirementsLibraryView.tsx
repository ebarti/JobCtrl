import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import {
  AssociationStateAction, RequirementAssociationPicker, requirementQualifierText, achievementChoices,
  useCurrentWordingActions, useCurrentWordingHistory, useRequirementAssociationHistory, useRequirementLibrary,
  type AchievementChoice, type LibraryRequirement, type UserAssociation,
} from "../../contexts/fit/index.js";
import { useRequirementHistory } from "../../contexts/requirements/index.js";
import { useProfileQuery, useWordingHistory, useWordingLibrary } from "../../contexts/profile/index.js";
import { Button } from "../../shared/ui/button.js";
import { Input } from "../../shared/ui/input.js";
import { PageHead } from "../../shared/ui/page-head.js";

type Coverage = LibraryRequirement["coverage"][number];
type Assignment = LibraryRequirement["wording_assignments"][number];
type Library = NonNullable<ReturnType<typeof useRequirementLibrary>["data"]>;

function readable(value: string) {
  const text = value.replaceAll("_", " ");
  return text ? text[0]!.toLocaleUpperCase() + text.slice(1) : text;
}

function WordingAssignmentHistory({ assignment }: { assignment: Assignment }) {
  const [offset, setOffset] = useState(0);
  const query = useCurrentWordingHistory(assignment.assignment_id, { profileId: assignment.profile_id, limit: 20, offset });
  return <div className="requirement-history__content">
    {query.isPending ? <p>Loading wording selection history…</p> : null}
    {query.error ? <p className="requirement-error" role="alert">{query.error.message}</p> : null}
    {query.data ? <>
      <ul className="requirement-history__list">{query.data.rows.map((row) => <li key={row.revision}>
        <strong>Selection revision {row.revision} · {row.state === "active" ? "Selected" : "Removed"}</strong>
        <span>Requirement revision {row.requirement_revision} · wording revision {row.variant_revision} · {row.current ? "source pins current" : "needs review"}</span>
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
  const valid = library.profile_revision !== null && Number.isSafeInteger(requirementRevision) && requirementRevision > 0
    && Number.isSafeInteger(variantRevision) && variantRevision > 0
    && relation.current && relation.covered && relation.status === "covered" && variant.status === "approved"
    && !!requirement.assessment?.current && ["matched", "transferable"].includes(requirement.assessment.kind)
    && requirement.assessment.achievement_ids.includes(achievementId)
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

function AssociationHistory({ association }: { association: UserAssociation }) {
  const [offset, setOffset] = useState(0);
  const query = useRequirementAssociationHistory(association.association_id, { profileId: association.profile_id, limit: 20, offset });
  return <div className="requirement-history__content">
    {query.isPending ? <p>Loading link history…</p> : null}
    {query.error ? <p className="requirement-error" role="alert">{query.error.message}</p> : null}
    {query.data ? <>
      <ul className="requirement-history__list">{query.data.rows.map((row) => <li key={row.revision}>
        <strong>Revision {row.revision} · {row.state === "active" ? "Linked" : "Removed"}</strong>
        <span>Requirement revision {row.requirement_revision} · {row.current ? "original pins current" : "original pins need review"} · {row.updated_at}</span>
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

function RequirementHistory({ requirementId, kind, filter }: { requirementId: string; kind: "revisions" | "occurrences"; filter: string }) {
  const [offset, setOffset] = useState(0);
  const query = useRequirementHistory(requirementId, { kind, limit: 20, offset });
  const result = query.data;
  return <div className="requirement-history__content">
    {query.isPending ? <p>Loading history…</p> : null}
    {query.error ? <p className="requirement-error" role="alert">{query.error.message}</p> : null}
    {result?.kind === "revisions" ? result.rows.length ? <ul className="requirement-history__list">{result.rows.map((row) => <li key={row.revision}>
      <strong>Revision {row.revision} · {row.current ? "Current" : "Earlier meaning"}</strong>
      <p>{row.definition}</p><span>{requirementQualifierText(row)}</span>
      {row.stale_reasons.length ? <span>Needs review: {row.stale_reasons.map(readable).join("; ")}</span> : null}
    </li>)}</ul> : <p>No revisions recorded.</p> : null}
    {result?.kind === "occurrences" ? result.rows.length ? <ul className="requirement-history__list">{result.rows.map((row) => <li key={`${row.job_id}:${row.occurrence_id}:${row.snapshot_revision}`}>
      <div className="requirement-history__line"><strong>{row.current ? "Current posting reference" : "Earlier posting reference"}</strong>
        <Link to="/jobs/$jobId" params={{ jobId: row.job_id }} search={(previous) => ({ ...previous, returnRequirement: requirementId, returnRequirementsFilter: filter, jobTab: "fit" })}>Open source job</Link></div>
      <blockquote>{row.text}</blockquote>
      <p>Recorded meaning: {row.definition}</p><span>{requirementQualifierText(row)} · {readable(row.tier)} · weight {row.weight}</span>
      <details><summary>Source and provenance</summary>
        <p>Requirement revision {row.requirement_revision} · posting revision {row.posting_revision} · snapshot {row.snapshot_revision}{row.accepted ? " · accepted snapshot" : " · superseded snapshot"}</p>
        <p>Source {row.source_id} · revision {row.source_revision} · hash {row.source_hash}</p>
        {row.spans.map((span, index) => <blockquote key={`${span.start}:${span.end}:${index}`}>{span.quote}</blockquote>)}
        <p>Extraction {row.extraction_determination_id}{row.equivalence_determination_ids.length ? ` · equivalence ${row.equivalence_determination_ids.join(", ")}` : ""}</p>
        {row.stale_reasons.length ? <p>Needs review: {row.stale_reasons.map(readable).join("; ")}</p> : null}
      </details>
    </li>)}</ul> : <p>No posting references recorded.</p> : null}
    {result && result.total > result.limit ? <HistoryPagination total={result.total} offset={offset} limit={result.limit} onOffset={setOffset} /> : null}
  </div>;
}

function HistoryDisclosure({ requirementId, kind, title, filter }: { requirementId: string; kind: "revisions" | "occurrences"; title: string; filter: string }) {
  const [open, setOpen] = useState(false);
  return <details className="requirement-history" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{title}</summary>
    {open ? <RequirementHistory requirementId={requirementId} kind={kind} filter={filter} /> : null}
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
  const coverage = requirement.coverage.filter((row) => row.achievement_id === achievementId);
  const assignments = requirement.current_wordings.filter((row) => row.achievement_id === achievementId);
  const associations = requirement.associations.filter((row) => row.achievement_id === achievementId && row.state === "active");
  return <article className="requirement-achievement">
    <div className="requirement-achievement__heading"><div><h4>{achievement?.roleLabel ?? (sourceState === "loading" ? "Loading achievement…" : "Unavailable achievement")}</h4>{achievement?.dateRange ? <p className="muted">{achievement.dateRange}</p> : null}</div>
      {achievement && onOpenAchievement ? <Button type="button" variant="ghost" size="sm" onClick={() => onOpenAchievement(achievement.roleId, achievementId)}>Open achievement →</Button> : null}</div>
    <p className="requirement-achievement__fact">{achievement?.text ?? (sourceState === "loading" ? "Loading saved achievement details…" : sourceState === "error" ? "The achievement could not be loaded." : "This achievement is no longer available in the saved Profile.")}</p>
    {assessment ? <div className="requirement-assessment"><span className="requirement-badge">{assessment.current ? "Factual assessment" : "Earlier assessment · needs review"}: {readable(assessment.kind)}</span>
      <details><summary>Assessment and evidence</summary><p>{assessment.rationale}</p>
        {assessment.evidence_refs.map((ref, index) => <blockquote key={`${ref.source_id}:${ref.revision}:${index}`}>{ref.quote}<footer>Source {ref.source_id} · revision {ref.revision}</footer></blockquote>)}
        <p>Requirement revision {assessment.requirement_revision} · {readable(assessment.origin)} · determination {assessment.determination_id}</p>
        {assessment.stale_reasons.length ? <p>Needs review: {assessment.stale_reasons.map(readable).join("; ")}</p> : null}
      </details></div> : null}
    {associations.filter((association) => !association.wording).map((association) => <AssociationRecord key={association.association_id} association={association} onEdit={canLink && achievement ? () => onEditLink(achievementId) : undefined} />)}
    <div className="requirement-section-heading"><h5>Wordings for this requirement</h5>
      {achievement && canLink ? <Button type="button" variant="outline" size="sm" onClick={() => onLinkWording(achievementId)}>Link wording</Button> : null}</div>
    <WordingConnections library={library} requirement={requirement} achievementId={achievementId} canLink={canLink} coverage={coverage} associations={associations} assignments={assignments} achievement={achievement} sourceState={sourceState} recordsAligned={recordsAligned} onEditLink={canLink && achievement ? () => onEditLink(achievementId) : undefined} />
  </article>;
}

function RequirementDetail({ library, requirement, choices, canLink, onOpenAchievement, onLinkAchievement, onLinkWording, onEditLink, filter, sourceState, recordsAligned }: {
  library: Library; requirement: LibraryRequirement; choices: AchievementChoice[]; canLink: boolean; filter: string; sourceState: "loading" | "error" | "ready"; recordsAligned: boolean;
  onOpenAchievement?: ((roleId: string, achievementId: string) => void) | undefined;
  onLinkAchievement: () => void; onLinkWording: (achievementId: string) => void; onEditLink: (achievementId: string) => void;
}) {
  const active = requirement.associations.filter((association) => association.state === "active");
  const removed = requirement.associations.filter((association) => association.state === "removed");
  const achievementIds = [...new Set([
    ...(requirement.assessment?.achievement_ids ?? []),
    ...requirement.coverage.map((item) => item.achievement_id),
    ...requirement.current_wordings.map((item) => item.achievement_id),
    ...active.map((item) => item.achievement_id),
  ])];
  return <section className="requirements-detail" aria-labelledby="requirement-definition-title" tabIndex={-1}>
    <div className="requirements-definition"><span className="requirements-definition__eyebrow">Reusable requirement · revision {requirement.revision}</span>
      <h2 id="requirement-definition-title">{requirement.definition}</h2>
      <p>{requirementQualifierText(requirement)}</p>
      <details><summary>Definition identity</summary><p>Requirement {requirement.requirement_id} · revision {requirement.revision}</p></details>
    </div>
    <div className="requirement-section-heading"><h3>Linked achievements <span className="requirement-count">{achievementIds.length}</span></h3>
      {canLink ? <Button type="button" variant="outline" size="sm" onClick={onLinkAchievement}>Link achievement</Button> : null}</div>
    {!achievementIds.length ? <div className="requirement-empty"><strong>No achievements linked yet.</strong><p>Link a saved achievement, or update affected matches to assess available evidence.</p></div> : null}
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
    <HistoryDisclosure requirementId={requirement.requirement_id} kind="revisions" title="Definition history" filter={filter} />
    <HistoryDisclosure requirementId={requirement.requirement_id} kind="occurrences" title="Source history and posting references" filter={filter} />
  </section>;
}

export function RequirementsLibraryView({ selectedRequirementId, onSelectRequirement, onOpenAchievement, filter, onFilterChange }: {
  selectedRequirementId?: string | null;
  onSelectRequirement?: ((id: string | null) => void) | undefined;
  onOpenAchievement?: ((roleId: string, achievementId: string) => void) | undefined;
  filter?: string;
  onFilterChange?: ((value: string) => void) | undefined;
}) {
  const library = useRequirementLibrary();
  const profile = useProfileQuery();
  const wording = useWordingLibrary();
  const choices = achievementChoices(profile.data?.profile, wording.data);
  const [localFilter, setLocalFilter] = useState("");
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ achievementId?: string; requireWording?: boolean } | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const requirements = library.data?.requirements ?? [];
  const search = filter ?? localFilter;
  const needle = search.trim().toLocaleLowerCase();
  const shown = requirements.filter((requirement) => requirement.definition.toLocaleLowerCase().includes(needle));
  useEffect(() => {
    if (!selectedRequirementId && !localSelected && requirements.length) {
      const firstId = requirements[0]!.requirement_id;
      setLocalSelected(firstId);
      onSelectRequirement?.(firstId);
    }
  }, [selectedRequirementId, localSelected, requirements, onSelectRequirement]);
  const selectedId = selectedRequirementId || localSelected;
  const selected = selectedId ? requirements.find((item) => item.requirement_id === selectedId) : requirements[0];
  const select = (id: string) => {
    setLocalSelected(id); onSelectRequirement?.(id);
    detailRef.current?.focus();
  };
  const setSearch = (value: string) => { setLocalFilter(value); onFilterChange?.(value); };
  const sourceState = profile.isPending || wording.isPending ? "loading" : profile.error || wording.error ? "error" : "ready";
  const mismatch = !!library.data && library.data.readiness === "ready" && !!profile.data && !!wording.data
    && (library.data.profile_revision !== profile.data.profileVersion || library.data.profile_revision !== wording.data.profileVersion);
  const canLink = !!library.data && library.data.readiness === "ready" && !library.error && !profile.error && !wording.error
    && library.data.profile_revision === profile.data?.profileVersion && library.data.profile_revision === wording.data?.profileVersion;
  return <>
    <PageHead eyebrow="Library" title="Requirements library" subtitle="Reusable requirements, linked achievements, and the wording recorded for each." />
    <section className="requirements-library" aria-label="Requirements library">
      <div className="requirements-library__toolbar"><label>Find a requirement<Input value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Search saved definitions" /></label>
        {search ? <Button type="button" variant="outline" size="sm" onClick={() => setSearch("")}>Clear filter</Button> : null}
        {library.data ? <span className="muted">{shown.length} of {requirements.length} requirements</span> : null}</div>
      {library.isPending ? <p role="status">Loading saved requirements…</p> : null}
      {library.error ? <div className="requirement-error" role="alert"><p>{library.error.message}{library.data ? " Showing the last available data." : ""}</p><Button type="button" variant="outline" size="sm" onClick={() => void library.refetch()}>Retry</Button></div> : null}
      {profile.error || wording.error ? <p className="requirement-error" role="alert">Achievement details could not be refreshed. Saved requirement records remain available.</p> : null}
      {mismatch ? <p role="status">The Profile and requirement records are from different revisions. Refresh them before changing links or wording. <Button type="button" variant="outline" size="sm" onClick={() => { void Promise.all([library.refetch(), profile.refetch(), wording.refetch()]); }}>Refresh records</Button></p> : null}
      {library.data?.readiness === "profile_required" ? <p className="muted">Save a Profile to link achievements to requirements.</p> : null}
      {library.data && !requirements.length ? <div className="requirement-empty"><strong>No requirements recorded yet.</strong><p>Requirements appear here after they are extracted from a saved job.</p></div> : null}
      {requirements.length ? <div className="requirements-library__layout">
        <nav className="requirements-list" aria-label="Saved requirements"><div className="requirement-section-heading"><h2>Requirements</h2><span>{shown.length}</span></div>
          {shown.length ? <ul>{shown.map((requirement) => {
            const count = new Set([...(requirement.assessment?.achievement_ids ?? []), ...requirement.coverage.map((item) => item.achievement_id), ...requirement.current_wordings.map((item) => item.achievement_id), ...requirement.associations.filter((item) => item.state === "active").map((item) => item.achievement_id)]).size;
            return <li key={requirement.requirement_id}><button type="button" aria-pressed={requirement.requirement_id === selected?.requirement_id} onClick={() => select(requirement.requirement_id)}>
              <strong>{requirement.definition}</strong><span>{requirementQualifierText(requirement)}</span><small>{count} linked {count === 1 ? "achievement" : "achievements"}</small></button></li>;
          })}</ul> : <p>No requirements match this filter.</p>}
        </nav>
        <div className="requirements-library__detail" ref={detailRef} tabIndex={-1}>
          {selected && needle && !shown.some((item) => item.requirement_id === selected.requirement_id) ? <p className="muted" role="status">The selected requirement is outside the current filter.</p> : null}
          {selected ? <RequirementDetail key={selected.requirement_id} library={library.data!} requirement={selected} choices={choices} canLink={canLink} filter={search} sourceState={sourceState} recordsAligned={sourceState === "ready" && !mismatch} onOpenAchievement={onOpenAchievement}
            onLinkAchievement={() => setPicker({})} onLinkWording={(achievementId) => setPicker({ achievementId, requireWording: true })} onEditLink={(achievementId) => setPicker({ achievementId })} />
            : <div className="requirement-empty"><strong>Requirement unavailable.</strong><p>Select another saved definition from the list.</p></div>}
        </div>
      </div> : null}
    </section>
    {picker && selected && library.data ? <RequirementAssociationPicker library={library.data} choices={choices} profileVersion={profile.data?.profileVersion} wordingProfileVersion={wording.data?.profileVersion} sourceLoading={profile.isPending || wording.isPending} sourceError={profile.error?.message ?? wording.error?.message} requirementId={selected.requirement_id} achievementId={picker.achievementId} requireWording={picker.requireWording} onClose={() => setPicker(null)} /> : null}
  </>;
}
