import { Link } from "@tanstack/react-router";
import { z } from "zod";

import { useFitEvidenceMap } from "../../contexts/fit/index.js";
import { useProfileSources } from "../../contexts/profile/index.js";
import { useResumeArtifactCatalog } from "../../contexts/resumes/index.js";

const storySchema = z.object({
  source_text: z.string().optional(), scope: z.string().optional(), action: z.string().optional(),
  outcome: z.string().optional(), metrics: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(), tags: z.array(z.string()).optional(),
  evidence_strength: z.string().optional(),
}).passthrough();
const variantSchema = z.object({
  achievement_id: z.string(), variant_id: z.string(), text: z.string(),
  source_refs: z.array(z.object({ source_id: z.string(), revision: z.union([z.number(), z.string()]) })),
}).passthrough();
const skillCategorySchema = z.object({ id: z.string(), label: z.string(), items: z.array(z.string()) }).passthrough();

function savedSkillCategory(source: { text: string; path?: unknown } | undefined) {
  if (!source || !Array.isArray(source.path) || source.path[0] !== "resume" || source.path[1] !== "skill_categories") return null;
  try {
    const parsed = skillCategorySchema.safeParse(JSON.parse(source.text));
    return parsed.success && parsed.data.id === source.path[2] ? parsed.data : null;
  } catch { return null; }
}

/** Compose recorded source identities. No text comparison decides a connection. */
export function EvidenceMapConnections({ search = "", focusSourceId = "", jobId = "" }: {
  search?: string; focusSourceId?: string; jobId?: string;
}) {
  const sourcesQuery = useProfileSources();
  const fitQuery = useFitEvidenceMap();
  const artifactsQuery = useResumeArtifactCatalog();
  const sources = sourcesQuery.data?.sources ?? [];
  const fit = fitQuery.data;
  const artifacts = artifactsQuery.data?.artifacts ?? [];
  let unavailableVariants = 0;
  const artifactUses = artifacts.flatMap((artifact) => artifact.revision.selected_variants.flatMap((value) => {
    const parsed = variantSchema.safeParse(value);
    if (!parsed.success) { unavailableVariants += 1; return []; }
    return parsed.data.source_refs.map((ref) => ({ artifact, variant: parsed.data, ref }));
  }));
  const sourcesById = new Map(sources.map((source) => [source.source_id, source]));
  const usageBySource = new Map((fit?.sources ?? []).map((source) => [source.source_id, source.usages]));
  const coverageBySource = new Map<string, NonNullable<typeof fit>["coverage"]>();
  for (const coverage of fit?.coverage ?? []) {
    for (const sourceId of new Set(coverage.source_refs.map((ref) => ref.source_id))) {
      const rows = coverageBySource.get(sourceId) ?? [];
      rows.push(coverage);
      coverageBySource.set(sourceId, rows);
    }
  }
  const resumesBySource = new Map<string, typeof artifactUses>();
  for (const use of artifactUses) {
    const rows = resumesBySource.get(use.ref.source_id) ?? [];
    rows.push(use);
    resumesBySource.set(use.ref.source_id, rows);
  }
  const ids = new Set([...sourcesById.keys(), ...usageBySource.keys(), ...coverageBySource.keys(), ...resumesBySource.keys()]);

  const needle = search.trim().toLocaleLowerCase();
  const entries = [...ids].flatMap((sourceId) => {
    const source = sourcesById.get(sourceId);
    const record = storySchema.safeParse(source?.record);
    const story = record.success ? record.data : null;
    const skills = savedSkillCategory(source);
    const usages = (usageBySource.get(sourceId) ?? [])
      .filter((item) => !jobId || item.job_id === jobId);
    const coverage = (coverageBySource.get(sourceId) ?? []).filter((item) => !jobId || item.job_id === jobId);
    const resumes = (resumesBySource.get(sourceId) ?? []).filter((item) => !jobId || item.artifact.jobId === jobId);
    const searchable = [sourceId, source?.text, source?.kind, story?.source_text, story?.scope, story?.action, story?.outcome,
      ...(story?.metrics ?? []), ...(story?.tools ?? []), ...(story?.tags ?? [])].filter((value): value is string => typeof value === "string").join("\n").toLocaleLowerCase();
    if ((focusSourceId && focusSourceId !== sourceId) || (needle && !searchable.includes(needle))
      || (jobId && !usages.length && !coverage.length && !resumes.length)) return [];
    return [{ sourceId, source, story, skills, usages, coverage, resumes }];
  });
  const gaps = (fit?.gaps ?? []).filter((item) => !jobId || item.job_id === jobId);
  const wordingGaps = (fit?.wording_gaps ?? []).filter((item) => !jobId || item.job_id === jobId);
  const groupedGaps = new Map<string, typeof gaps>();
  for (const gap of gaps) {
    const key = JSON.stringify([gap.requirement_id, gap.requirement_revision, gap.kind]);
    const rows = groupedGaps.get(key) ?? [];
    rows.push(gap); groupedGaps.set(key, rows);
  }
  const groupedWordingGaps = new Map<string, typeof wordingGaps>();
  for (const gap of wordingGaps) {
    const key = JSON.stringify([gap.requirement_id, gap.requirement_revision, gap.status, gap.person_qualification]);
    const rows = groupedWordingGaps.get(key) ?? [];
    rows.push(gap); groupedWordingGaps.set(key, rows);
  }
  return <section className="card" aria-labelledby="evidence-connections-title">
    <h2 id="evidence-connections-title">Evidence connections across jobs</h2>
    <p>These links come from saved source references, assessments and rendered resume revisions. A stale connection is retained as history; it is not a current claim.</p>
    {sourcesQuery.error ? <p role="alert">Profile sources could not be refreshed: {sourcesQuery.error.message}{sourcesQuery.data ? " The sources below are from the last successful read." : ""}</p> : null}
    {fitQuery.error ? <p role="alert">Recorded fit connections could not be refreshed: {fitQuery.error.message}{fit ? " Their displayed status is from the last successful read." : ""}</p> : null}
    {artifactsQuery.error ? <p role="alert">Resume usage could not be refreshed: {artifactsQuery.error.message}{artifactsQuery.data ? " The artifacts below are from the last successful read." : ""}</p> : null}
    {unavailableVariants ? <p role="alert">Some saved resume source references could not be displayed; other recorded connections remain visible.</p> : null}
    {sourcesQuery.isPending || fitQuery.isPending || artifactsQuery.isPending ? <p>Loading saved connections…</p> : null}
    {entries.length ? <ul>{entries.map(({ sourceId, source, story, skills, usages, coverage, resumes }) => <li key={sourceId}>
      <h3>{source?.kind ?? "Unavailable source"} · {sourceId}</h3>
      {source ? <p>Saved source revision {source.revision} · {source.confirmation}{story?.evidence_strength ? ` · recorded strength ${story.evidence_strength}` : ""}</p>
        : <p>{sourcesQuery.isPending ? "Loading the saved source…" : sourcesQuery.error ? "The source could not be loaded; its availability is unknown." : "The saved source is unavailable; these references remain recorded in past assessments or artifacts."}</p>}
      {story ? <section aria-label={`Reusable story ${sourceId}`}><h4>Reusable story</h4>
        {story.source_text ? <p>{story.source_text}</p> : null}
        <dl><dt>Scope</dt><dd>{story.scope || "Not recorded"}</dd><dt>Action</dt><dd>{story.action || "Not recorded"}</dd><dt>Outcome</dt><dd>{story.outcome || "Not recorded"}</dd></dl>
        {story.metrics?.length ? <p>Recorded metrics: {story.metrics.join(" · ")}</p> : null}
        {story.tools?.length ? <p>Tools: {story.tools.join(" · ")}</p> : null}
        {story.tags?.length ? <p>Tags: {story.tags.join(" · ")}</p> : null}
      </section> : skills ? <section aria-label={`Saved skills ${skills.label}`}><h4>{skills.label}</h4><ul>{skills.items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul></section>
        : source?.text ? <p>{source.text}</p> : null}
      {usages.length ? <section><h4>Recorded requirement assessments</h4><ul>{usages.map((use, index) => <li key={`${use.job_id}:${use.requirement_id}:${use.score_revision}:${index}`}>
        <Link to="/jobs/$jobId" params={{ jobId: use.job_id }}>{use.job_id}</Link> · {use.kind} · {use.current ? "current assessment" : "stale assessment"} · score revision {use.score_revision}
        <p>Requirement {use.requirement_id}; determination {use.determination_id}; source revision {use.evidence_ref.revision}.</p><blockquote>{use.evidence_ref.quote}</blockquote>
      </li>)}</ul></section> : null}
      {coverage.length ? <section><h4>Recorded wording coverage</h4><ul>{coverage.map((item, index) => <li key={`${item.job_id}:${item.requirement_id}:${item.variant_id}:${index}`}>
        <Link to="/jobs/$jobId" params={{ jobId: item.job_id }}>{item.job_id}</Link> · {item.status} · {item.current ? "current" : "stale"}; requirement {item.requirement_id}, achievement {item.achievement_id}, wording {item.variant_id}.
        {item.determination_id ? ` Determination ${item.determination_id}.` : " No determination recorded."}
      </li>)}</ul></section> : null}
      {resumes.length ? <section><h4>Used in rendered resumes</h4><ul>{resumes.map(({ artifact, variant, ref }, index) => <li key={`${artifact.artifactId}:${variant.variant_id}:${index}`}>
        <Link to="/artifacts/$artifactId" params={{ artifactId: artifact.artifactId }}>{artifact.title}</Link> · {artifact.status.replaceAll("_", " ")} · source revision {ref.revision}{source && source.revision !== ref.revision ? " (different from the current source revision)" : ""}.
        <p>{variant.text}</p><p className="muted">Achievement {variant.achievement_id}; wording {variant.variant_id}; job {artifact.jobId}.</p>
      </li>)}</ul></section> : null}
      {!usages.length && !coverage.length && !resumes.length && fit && artifactsQuery.data && !fitQuery.error && !artifactsQuery.error && unavailableVariants === 0 ? <p>No saved connections recorded for this source in this view.</p> : null}
    </li>)}</ul> : !sourcesQuery.isPending && !fitQuery.isPending && !artifactsQuery.isPending && !sourcesQuery.error && !fitQuery.error && !artifactsQuery.error && unavailableVariants === 0 ? <p>No sources or recorded connections match this view.</p> : null}
    <h3>Recorded qualification gaps</h3>
    <p>These are saved requirement assessments, not a new judgment about your capabilities.</p>
    {gaps.length ? <ul>{[...groupedGaps].map(([key, group]) => <li key={key}>
      <strong>Requirement {group[0]!.requirement_id}, revision {group[0]!.requirement_revision}</strong> · {group[0]!.kind.replaceAll("_", " ")}.
      <ul>{group.map((gap, index) => <li key={`${gap.job_id}:${gap.score_revision}:${index}`}><Link to="/jobs/$jobId" params={{ jobId: gap.job_id }}>{gap.job_id}</Link> · {gap.current ? "current" : "stale"} · {gap.tier}, weight {gap.weight}.
        <p>{gap.text}</p><p>{gap.rationale}</p><p>Determination {gap.determination_id} · score revision {gap.score_revision}.</p></li>)}</ul>
    </li>)}</ul> : fit && !fitQuery.error ? <p>No qualification gaps recorded for this view.</p> : null}
    <h3>Recorded wording gaps</h3><p>Wording coverage is separate from the person-fit assessment.</p>
    {wordingGaps.length ? <ul>{[...groupedWordingGaps].map(([key, group]) => <li key={key}>
      Requirement {group[0]!.requirement_id}, revision {group[0]!.requirement_revision}: {group[0]!.status.replaceAll("_", " ")} · person qualification {group[0]!.person_qualification.replaceAll("_", " ")}.
      <ul>{group.map((gap, index) => <li key={`${gap.job_id}:${gap.score_revision}:${index}`}><Link to="/jobs/$jobId" params={{ jobId: gap.job_id }}>{gap.job_id}</Link> · {gap.current ? "current" : "stale"} · score revision {gap.score_revision}.</li>)}</ul>
    </li>)}</ul> : fit && !fitQuery.error ? <p>No wording gaps recorded for this view.</p> : null}
  </section>;
}
