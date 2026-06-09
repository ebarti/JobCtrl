import type { JSX } from "react";

import { useArtifactDetailQuery } from "../../operations/hooks/useArtifactDetailQuery.js";
import { Empty } from "../../../shared/ui/empty.js";
import { TailoringExplanationSection } from "./TailoringExplanationSection.js";

export interface ArtifactTailoringInspectorProps {
  readonly artifactId: string;
  readonly className?: string;
}

/**
 * Context-owned inspector for one tailored artifact: fetches the artifact detail
 * via the Operations read hook and renders the tailoring explanation (rationale,
 * coverage, voice pass, per-bullet provenance + diff). Shared by the jobs detail
 * drawer and apply-review so both surfaces show identical provenance.
 *
 * INSPECT-05: when no explanation has been recorded it renders an explicit empty
 * state — never a blank.
 */
export function ArtifactTailoringInspector({
  artifactId,
  className = "section apply-review-tailoring",
}: ArtifactTailoringInspectorProps): JSX.Element {
  const detail = useArtifactDetailQuery(artifactId);
  const errorMessage = detail.error instanceof Error ? detail.error.message : null;

  if (detail.data?.tailoringExplanation) {
    return (
      <TailoringExplanationSection
        className={className}
        explanation={detail.data.tailoringExplanation}
      />
    );
  }

  return (
    <section className={className} aria-label="Tailoring rationale">
      <h3>Tailoring rationale</h3>
      {errorMessage ? (
        <div className="banner inline">{errorMessage}</div>
      ) : detail.isFetching ? (
        <Empty title="Loading tailoring rationale." />
      ) : (
        <Empty title="No tailoring rationale captured for this resume yet." />
      )}
    </section>
  );
}
