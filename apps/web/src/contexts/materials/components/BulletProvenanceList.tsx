import type { ArtifactTailoringExplanation, BulletProvenanceEntry } from "@jobctrl/contracts";
import type { JSX } from "react";

import type { StatusTagTone } from "../../../shared/ui/status-tokens.js";
import { formatToken } from "../lib/audit-format.js";

type AnnotatedChange = ArtifactTailoringExplanation["annotatedChanges"][number];

export interface BulletProvenanceListProps {
  /** Canonical per-bullet provenance rows for the artifact's generation. */
  readonly provenance: readonly BulletProvenanceEntry[];
  /**
   * Annotated changes (source → tailored text) used to source the original
   * profile bullet for the diff view (INSPECT-04). Optional — when a change
   * isn't recorded for a bullet the diff shows an explicit "not recorded" state.
   */
  readonly annotatedChanges?: readonly AnnotatedChange[];
  readonly className?: string;
}

function originalTextFor(
  entry: BulletProvenanceEntry,
  annotatedChanges: readonly AnnotatedChange[],
): string[] | null {
  if (entry.sourceText.length) {
    return [...entry.sourceText];
  }
  const match = annotatedChanges.find(
    (change) => change.section === entry.section && change.sourceId === entry.sourceId,
  );
  if (!match) {
    return null;
  }
  return match.sourceText;
}

function TagList({
  label,
  items,
  tone = "muted",
}: {
  readonly label: string;
  readonly items: readonly string[];
  readonly tone?: StatusTagTone;
}): JSX.Element {
  return (
    <div className="bullet-provenance-tags">
      <dt>{label}</dt>
      <dd>
        {items.length ? (
          <ul className="audit-value-list">
            {items.map((item) => (
              <li className={`audit-value audit-value--${tone}`} key={item}>
                {item}
              </li>
            ))}
          </ul>
        ) : (
          <span className="muted">none recorded</span>
        )}
      </dd>
    </div>
  );
}

function BulletDiff({
  original,
  tailored,
}: {
  readonly original: string[] | null;
  readonly tailored: string;
}): JSX.Element {
  return (
    <div className="bullet-provenance-diff">
      <div className="bullet-provenance-diff-side">
        <span className="bullet-provenance-diff-label">Original profile bullet</span>
        {original === null ? (
          <p className="muted">Original profile bullet not recorded for this line.</p>
        ) : original.length ? (
          <ul className="annotation-line-list">
            {original.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">Drafted from related evidence (no single source bullet).</p>
        )}
      </div>
      <div className="bullet-provenance-diff-side">
        <span className="bullet-provenance-diff-label">Tailored bullet</span>
        {tailored ? (
          <p className="bullet-provenance-generated">{tailored}</p>
        ) : (
          <p className="muted">No generated text recorded for this bullet.</p>
        )}
      </div>
    </div>
  );
}

function BulletProvenanceCard({
  entry,
  annotatedChanges,
}: {
  readonly entry: BulletProvenanceEntry;
  readonly annotatedChanges: readonly AnnotatedChange[];
}): JSX.Element {
  return (
    <article className="bullet-provenance">
      <header className="audit-record-head">
        <span className="audit-kicker">{formatToken(entry.section)}</span>
        <span className="audit-inline-meta" title="Transform applied">
          {formatToken(entry.transformType)}
        </span>
        {entry.control ? (
          <span className="audit-inline-meta" title="Governing control rule">
            {formatToken(entry.control)}
          </span>
        ) : null}
      </header>

      <BulletDiff original={originalTextFor(entry, annotatedChanges)} tailored={entry.generatedText} />

      <dl className="detail-list compact">
        <TagList label="Profile evidence" items={entry.evidenceIds} />
        <TagList label="Serves requirement" items={entry.requirementIds} />
        <TagList label="Keywords demonstrated" items={entry.matchedKeywords} tone="ok" />
        {entry.rationale ? (
          <div>
            <dt>Why</dt>
            <dd>{entry.rationale}</dd>
          </div>
        ) : (
          <div>
            <dt>Why</dt>
            <dd className="muted">no rationale recorded</dd>
          </div>
        )}
      </dl>
    </article>
  );
}

/**
 * INSPECT-03 / INSPECT-04 / INSPECT-05 — per-bullet provenance + diff.
 *
 * For each canonical provenance row, renders the original-profile-bullet →
 * tailored-bullet diff (INSPECT-04) and the evidence × requirement × transform ×
 * control × rationale facts (INSPECT-03). Empty FK sets render an explicit "none
 * recorded" and a missing original bullet renders an explicit "not recorded"
 * state (INSPECT-05) — never a blank or a fabricated value. When no provenance
 * rows exist for the artifact's generation it renders an explicit empty state.
 */
export function BulletProvenanceList({
  provenance,
  annotatedChanges = [],
  className = "section",
}: BulletProvenanceListProps): JSX.Element {
  if (!provenance.length) {
    return (
      <section className={className} aria-label="Per-bullet provenance">
        <h3>Per-bullet provenance</h3>
        <p className="muted">
          No per-bullet provenance was recorded for this artifact&apos;s generation.
        </p>
      </section>
    );
  }

  return (
    <section className={className} aria-label="Per-bullet provenance">
      <h3>Per-bullet provenance ({provenance.length})</h3>
      <div className="bullet-provenance-list">
        {provenance.map((entry) => (
          <BulletProvenanceCard key={entry.bulletId} entry={entry} annotatedChanges={annotatedChanges} />
        ))}
      </div>
    </section>
  );
}
