import { WandSparkles } from "lucide-react";
import type { JSX } from "react";

import { useDashboardSummaryQuery } from "../../operations/hooks/useDashboardSummaryQuery.js";
import {
  useRetailorCurrentPolicyMutation,
  useRetailorJobMutation,
  useTailorJobMutation,
} from "../hooks/useRetailorCurrentPolicyMutation.js";

export interface RetailorJobButtonProps {
  readonly jobId: string;
  readonly className?: string;
  readonly label?: string;
  readonly disabled?: boolean;
}

export interface TailorJobButtonProps {
  readonly jobId: string;
  readonly className?: string;
  readonly label?: string;
  readonly disabled?: boolean;
}

export function TailorJobButton({
  jobId,
  className = "tab",
  label = "tailor this job",
  disabled = false,
}: TailorJobButtonProps): JSX.Element {
  const mutation = useTailorJobMutation();
  const blocked = disabled || mutation.isPending;

  return (
    <button
      aria-label={label}
      className={className}
      disabled={blocked}
      type="button"
      onClick={() => {
        if (
          blocked ||
          !window.confirm("Tailor this job now? This manually overrides the default low-fit auto-tailoring gate.")
        ) {
          return;
        }
        mutation.mutate({ jobId, reason: "manual_tailor" });
      }}
    >
      <WandSparkles aria-hidden="true" size={14} />
      <span>{mutation.isPending ? "tailoring" : label}</span>
    </button>
  );
}

export function RetailorJobButton({
  jobId,
  className = "tab",
  label = "re-tailor current policy",
  disabled = false,
}: RetailorJobButtonProps): JSX.Element {
  const mutation = useRetailorJobMutation();
  const blocked = disabled || mutation.isPending;

  return (
    <button
      aria-label={label}
      className={className}
      disabled={blocked}
      type="button"
      onClick={() => {
        if (
          blocked ||
          !window.confirm("Re-tailor this job with the current tailoring policy? Existing active artifacts will be suppressed.")
        ) {
          return;
        }
        mutation.mutate({ jobId });
      }}
    >
      <WandSparkles aria-hidden="true" size={14} />
      <span>{mutation.isPending ? "re-tailoring" : label}</span>
    </button>
  );
}

export interface RetailorCurrentPolicyButtonProps {
  readonly jobKeys?: readonly string[];
  readonly outdatedCount?: number;
  readonly limit?: number;
  readonly className?: string;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly onSuccess?: () => void;
}

export function RetailorCurrentPolicyButton({
  jobKeys = [],
  outdatedCount,
  limit = 100,
  className = "tab",
  label,
  disabled = false,
  onSuccess,
}: RetailorCurrentPolicyButtonProps): JSX.Element {
  const mutation = useRetailorCurrentPolicyMutation();
  const dashboard = useDashboardSummaryQuery();
  const outdatedJobs = outdatedCount ?? dashboard.data?.preparation?.outdatedTailoredArtifactCount ?? 0;
  const count = jobKeys.length || outdatedJobs;
  const requestLimit = jobKeys.length ? Math.max(limit, jobKeys.length) : limit;
  const buttonLabel = label ?? (jobKeys.length ? "re-tailor selected" : "re-tailor outdated materials");
  const blocked = disabled || mutation.isPending || count <= 0;

  return (
    <button
      aria-label={buttonLabel}
      className={className}
      disabled={blocked}
      title={jobKeys.length ? undefined : `${count} jobs have tailored artifacts from an older policy.`}
      type="button"
      onClick={() => {
        if (blocked) return;
        const scope = jobKeys.length
          ? `${count} selected job${count === 1 ? "" : "s"}`
          : `up to ${limit} eligible jobs not on the current tailoring policy`;
        if (
          !window.confirm(
            `Re-tailor ${scope}? Existing active artifacts will be suppressed and retained for audit.`,
          )
        ) {
          return;
        }
        mutation.mutate({ jobKeys, limit: requestLimit }, onSuccess ? { onSuccess } : undefined);
      }}
    >
      <WandSparkles aria-hidden="true" size={14} />
      <span>{mutation.isPending ? "re-tailoring" : buttonLabel}</span>
    </button>
  );
}
