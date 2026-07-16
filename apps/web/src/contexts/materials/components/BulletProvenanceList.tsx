import type {
  ArtifactTailoringExplanation,
  BulletProvenanceEntry,
} from "@jobctrl/contracts";
import type { JSX, ReactNode } from "react";

import type { StatusTagTone } from "../../../shared/ui/status-tokens.js";
import { formatToken } from "../lib/audit-format.js";
import {
  type AuditEvidenceReference,
  type AuditReferenceLabel,
  AuditTechnicalDetails,
  type ResolveAuditEvidenceReference,
} from "./AuditTechnicalDetails.js";

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
  /**
   * Resolves requirement foreign keys through the canonical job requirement
   * projection. `undefined` means the projection is still loading; `null`
   * means the key is not present in the current projection.
   */
  readonly resolveRequirementReference?: (
    requirementId: string,
  ) => string | null | undefined;
  readonly resolveEvidenceReference?: ResolveAuditEvidenceReference;
  readonly renderEvidenceReference?: (
    reference: AuditEvidenceReference,
  ) => ReactNode;
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
    (change) =>
      change.section === entry.section && change.sourceId === entry.sourceId,
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
          items.map((item) => (
            <span className={`tag ${tone}`} key={item}>
              {item}
            </span>
          ))
        ) : (
          <span className="muted">none recorded</span>
        )}
      </dd>
    </div>
  );
}

interface StructuredEvidenceReference extends AuditReferenceLabel {
  readonly reference: AuditEvidenceReference | null | undefined;
}

function structuredEvidenceReferences(
  evidenceIds: readonly string[],
  resolveEvidenceReference:
    | BulletProvenanceListProps["resolveEvidenceReference"]
    | undefined,
): StructuredEvidenceReference[] {
  const uniqueIds = new Set(evidenceIds);
  return Array.from(uniqueIds, (id) => {
    const reference = resolveEvidenceReference?.(id);
    return {
      id,
      label: reference
        ? reference.title
        : resolveEvidenceReference && reference === undefined
          ? "Loading evidence details"
          : "Evidence reference unavailable",
      reference,
    };
  });
}

function EvidenceReferenceList({
  evidenceIds,
  resolveEvidenceReference,
  renderEvidenceReference,
}: {
  readonly evidenceIds: readonly string[];
  readonly resolveEvidenceReference:
    | BulletProvenanceListProps["resolveEvidenceReference"]
    | undefined;
  readonly renderEvidenceReference:
    | BulletProvenanceListProps["renderEvidenceReference"]
    | undefined;
}): JSX.Element {
  const references = structuredEvidenceReferences(
    evidenceIds,
    resolveEvidenceReference,
  );
  return (
    <div className="bullet-provenance-tags">
      <dt>Profile evidence</dt>
      <dd>
        {references.length ? (
          references.map(({ id, label, reference }) => (
            <span className="tag muted" key={id}>
              {reference && renderEvidenceReference
                ? renderEvidenceReference(reference)
                : label}
            </span>
          ))
        ) : (
          <span className="muted">none recorded</span>
        )}
      </dd>
    </div>
  );
}

function RequirementReferenceList({
  requirementIds,
  resolveRequirementReference,
}: {
  readonly requirementIds: readonly string[];
  readonly resolveRequirementReference:
    | BulletProvenanceListProps["resolveRequirementReference"]
    | undefined;
}): JSX.Element {
  if (!requirementIds.length) {
    return (
      <div className="bullet-provenance-tags">
        <dt>Serves requirement</dt>
        <dd>
          <span className="muted">none recorded</span>
        </dd>
      </div>
    );
  }

  return (
    <div className="bullet-provenance-tags">
      <dt>Serves requirement</dt>
      <dd>
        {requirementIds.map((requirementId) => {
          const reference = resolveRequirementReference?.(requirementId);
          const label = reference?.trim();
          return (
            <span className="tag muted" key={requirementId}>
              {label ||
                (resolveRequirementReference && reference === undefined
                  ? "Loading requirement details"
                  : "Requirement reference unavailable")}
            </span>
          );
        })}
      </dd>
    </div>
  );
}

function TechnicalIdList({
  label,
  ids,
}: {
  readonly label: string;
  readonly ids: readonly string[];
}): JSX.Element | null {
  const uniqueIds = Array.from(new Set(ids));
  if (!uniqueIds.length) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <ul className="compact-list">
          {uniqueIds.map((id) => (
            <li key={id}>
              <code>{id}</code>
            </li>
          ))}
        </ul>
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
        <span className="bullet-provenance-diff-label">
          Original profile bullet
        </span>
        {original === null ? (
          <p className="muted">
            Original profile bullet not recorded for this line.
          </p>
        ) : original.length ? (
          <ul className="annotation-line-list">
            {original.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">
            Drafted from related evidence (no single source bullet).
          </p>
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
  resolveEvidenceReference,
  renderEvidenceReference,
  resolveRequirementReference,
}: {
  readonly entry: BulletProvenanceEntry;
  readonly annotatedChanges: readonly AnnotatedChange[];
  readonly resolveEvidenceReference:
    | BulletProvenanceListProps["resolveEvidenceReference"]
    | undefined;
  readonly renderEvidenceReference:
    | BulletProvenanceListProps["renderEvidenceReference"]
    | undefined;
  readonly resolveRequirementReference:
    | BulletProvenanceListProps["resolveRequirementReference"]
    | undefined;
}): JSX.Element {
  return (
    <article className="bullet-provenance">
      <header>
        <span className="stage-pill">{formatToken(entry.section)}</span>
        <span className="tag muted" title="Transform applied">
          {formatToken(entry.transformType)}
        </span>
        {entry.control ? (
          <span className="tag muted" title="Governing control rule">
            {formatToken(entry.control)}
          </span>
        ) : null}
      </header>

      <BulletDiff
        original={originalTextFor(entry, annotatedChanges)}
        tailored={entry.generatedText}
      />

      <dl className="detail-list compact">
        <EvidenceReferenceList
          evidenceIds={entry.evidenceIds}
          renderEvidenceReference={renderEvidenceReference}
          resolveEvidenceReference={resolveEvidenceReference}
        />
        <RequirementReferenceList
          requirementIds={entry.requirementIds}
          resolveRequirementReference={resolveRequirementReference}
        />
        <TagList
          label="Keywords demonstrated"
          items={entry.matchedKeywords}
          tone="ok"
        />
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
      {entry.evidenceIds.length || entry.requirementIds.length ? (
        <AuditTechnicalDetails>
          <dl className="detail-list compact">
            <TechnicalIdList label="Evidence IDs" ids={entry.evidenceIds} />
            <TechnicalIdList
              label="Requirement IDs"
              ids={entry.requirementIds}
            />
          </dl>
        </AuditTechnicalDetails>
      ) : null}
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
  resolveEvidenceReference,
  renderEvidenceReference,
  resolveRequirementReference,
  className = "section",
}: BulletProvenanceListProps): JSX.Element {
  if (!provenance.length) {
    return (
      <section className={className} aria-label="Per-bullet provenance">
        <h3>Per-bullet provenance</h3>
        <p className="muted">
          No per-bullet provenance was recorded for this artifact&apos;s
          generation.
        </p>
      </section>
    );
  }

  return (
    <section className={className} aria-label="Per-bullet provenance">
      <h3>Per-bullet provenance ({provenance.length})</h3>
      <div className="bullet-provenance-list">
        {provenance.map((entry) => (
          <BulletProvenanceCard
            key={entry.bulletId}
            entry={entry}
            annotatedChanges={annotatedChanges}
            renderEvidenceReference={renderEvidenceReference}
            resolveEvidenceReference={resolveEvidenceReference}
            resolveRequirementReference={resolveRequirementReference}
          />
        ))}
      </div>
    </section>
  );
}
