import { IconRefresh } from "@tabler/icons-react";
import type { JSX } from "react";

import { useDashboardSummaryQuery } from "../../operations/hooks/useDashboardSummaryQuery.js";
import { useRescoreCurrentPolicyMutation, useRescoreJobMutation } from "../hooks/useRescoreCurrentPolicyMutation.js";

export interface RescoreJobButtonProps {
  readonly jobId: string;
  readonly className?: string;
  readonly label?: string;
  readonly disabled?: boolean;
}

export function RescoreJobButton({
  jobId,
  className = "tab",
  label = "rescore current policy",
  disabled = false,
}: RescoreJobButtonProps): JSX.Element {
  const mutation = useRescoreJobMutation();
  const blocked = disabled || mutation.isPending;

  return (
    <button
      aria-label={label}
      className={className}
      disabled={blocked}
      type="button"
      onClick={() => {
        if (blocked || !window.confirm("Rescore this job with the current scoring policy?")) return;
        mutation.mutate({ jobId });
      }}
    >
      <IconRefresh aria-hidden="true" size={14} />
      <span>{mutation.isPending ? "rescoring" : label}</span>
    </button>
  );
}

export interface RescoreCurrentPolicyButtonProps {
  readonly jobKeys?: readonly string[];
  readonly outdatedCount?: number;
  readonly limit?: number;
  readonly className?: string;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly ariaDescribedBy?: string;
  readonly onSuccess?: () => void;
}

export function RescoreCurrentPolicyButton({
  jobKeys = [],
  outdatedCount,
  limit = 100,
  className = "tab",
  label,
  disabled = false,
  ariaDescribedBy,
  onSuccess,
}: RescoreCurrentPolicyButtonProps): JSX.Element {
  const mutation = useRescoreCurrentPolicyMutation();
  const dashboard = useDashboardSummaryQuery();
  const outdatedJobs = outdatedCount ?? dashboard.data?.preparation?.outdatedScoreCount ?? 0;
  const count = jobKeys.length || outdatedJobs;
  const requestLimit = jobKeys.length ? Math.max(limit, jobKeys.length) : limit;
  const buttonLabel = label ?? (jobKeys.length ? "rescore selected" : "rescore outdated scores");
  const blocked = disabled || mutation.isPending || count <= 0;

  return (
    <button
      aria-describedby={ariaDescribedBy}
      aria-label={buttonLabel}
      className={className}
      disabled={blocked}
      title={jobKeys.length ? undefined : `${count} jobs are not on the current scoring policy.`}
      type="button"
      onClick={() => {
        if (blocked) return;
        const scope = jobKeys.length
          ? `${count} selected job${count === 1 ? "" : "s"}`
          : `up to ${limit} jobs not on the current scoring policy`;
        if (!window.confirm(`Rescore ${scope}?`)) return;
        mutation.mutate({ jobKeys, limit: requestLimit }, onSuccess ? { onSuccess } : undefined);
      }}
    >
      <IconRefresh aria-hidden="true" size={14} />
      <span>{mutation.isPending ? "rescoring" : buttonLabel}</span>
    </button>
  );
}
