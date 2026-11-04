import type {
  ArtifactSummary,
  BulletProvenanceEntry,
} from "@jobctrl/contracts";
import { BulletProvenanceList } from "./BulletProvenanceList.js";

export function BaseProfileCopyAudit({
  origin,
  provenance = [],
}: {
  readonly origin: NonNullable<ArtifactSummary["resumePreparation"]>;
  readonly provenance?: readonly BulletProvenanceEntry[];
}) {
  return (
    <section
      className="base-profile-copy-audit border-b border-border bg-card p-4 text-card-foreground"
      aria-label="Base profile copy"
    >
      <h3 className="mb-2" data-typography="component-title">
        {origin.modified ? "Edited base profile copy" : "Base profile copy"}
      </h3>
      <p>
        Copied from saved Profile version {origin.profileVersion}. Edits belong
        to this job.
      </p>
      {!origin.modified ? (
        <p>
          AI tailoring and requirement-coverage reviews were not performed on
          the base copy. Scoring is recorded separately.
        </p>
      ) : null}
      {provenance.length ? (
        <details>
          <summary>Copied profile sources</summary>
          <BulletProvenanceList provenance={provenance} />
        </details>
      ) : null}
    </section>
  );
}
