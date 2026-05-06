import type { JSX } from "react";

export interface GenerateMaterialsButtonProps {
  jobId: string;
  className?: string;
  label?: string;
}

const DISABLED_REASON =
  "Materials generation backend endpoint is not yet wired (per frontend-target.md §7 Out-of-Scope). Use the local CLI workflow or wait for the materials endpoint to land.";

// Disabled-by-default per spec §5 Phase 4 S-17 file list. When the backend
// generate-materials endpoint lands, swap in `useGenerateMaterialsMutation` +
// remove `disabled`; the §7.4 R12/R14 in-flight pattern carries the rest with
// no further frontend change.
export function GenerateMaterialsButton({
  jobId,
  className = "tab",
  label = "generate materials",
}: GenerateMaterialsButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={className}
      disabled
      title={DISABLED_REASON}
      data-job-id={jobId}
    >
      {label}
    </button>
  );
}
