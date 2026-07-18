import { IconSparkles } from "@tabler/icons-react";
import type { JSX } from "react";

import { Button } from "../../../shared/ui/button.js";
import { useDashboardSummaryQuery } from "../../operations/hooks/useDashboardSummaryQuery.js";
import {
  useRetailorCurrentPolicyMutation,
  useRetailorJobMutation,
  useTailorJobMutation,
} from "../hooks/useRetailorCurrentPolicyMutation.js";

type RetailorCurrentPolicyActionRender = (props: {
  readonly "aria-describedby"?: string | undefined;
  readonly "aria-label": string;
  readonly children: JSX.Element;
  readonly className: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly title?: string | undefined;
}) => JSX.Element;

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
  label = "Tailor this job",
  disabled = false,
}: TailorJobButtonProps): JSX.Element {
  const mutation = useTailorJobMutation();
  const blocked = disabled || mutation.isPending;

  return (
    <Button
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
      <IconSparkles aria-hidden="true" size={14} />
      <span>{mutation.isPending ? "Tailoring" : label}</span>
    </Button>
  );
}

export function RetailorJobButton({
  jobId,
  className = "tab",
  label = "Re-tailor current policy",
  disabled = false,
}: RetailorJobButtonProps): JSX.Element {
  const mutation = useRetailorJobMutation();
  const blocked = disabled || mutation.isPending;

  return (
    <Button
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
      <IconSparkles aria-hidden="true" size={14} />
      <span>{mutation.isPending ? "Re-tailoring" : label}</span>
    </Button>
  );
}

export interface RetailorCurrentPolicyButtonProps {
  readonly jobKeys?: readonly string[];
  readonly outdatedCount?: number;
  readonly limit?: number;
  readonly className?: string;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly ariaDescribedBy?: string;
  readonly onSuccess?: () => void;
  /**
   * Renders the action with a caller-owned interactive primitive. This lets a
   * menu own its item semantics while preserving this control's behavior.
   */
  readonly render?: RetailorCurrentPolicyActionRender;
}

export function RetailorCurrentPolicyButton({
  jobKeys = [],
  outdatedCount,
  limit = 100,
  className = "tab",
  label,
  disabled = false,
  ariaDescribedBy,
  onSuccess,
  render,
}: RetailorCurrentPolicyButtonProps): JSX.Element {
  const mutation = useRetailorCurrentPolicyMutation();
  const dashboard = useDashboardSummaryQuery();
  const outdatedJobs = outdatedCount ?? dashboard.data?.preparation?.outdatedTailoredArtifactCount ?? 0;
  const count = jobKeys.length || outdatedJobs;
  const requestLimit = jobKeys.length ? Math.max(limit, jobKeys.length) : limit;
  const buttonLabel = label ?? (jobKeys.length ? "Re-tailor selected" : "Re-tailor outdated materials");
  const blocked = disabled || mutation.isPending || count <= 0;
  const buttonContent = (
    <>
      <IconSparkles aria-hidden="true" size={14} />
      <span>{mutation.isPending ? "Re-tailoring" : buttonLabel}</span>
    </>
  );
  const handleClick = () => {
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
  };

  if (render) {
    return render({
      "aria-describedby": ariaDescribedBy,
      "aria-label": buttonLabel,
      children: buttonContent,
      className,
      disabled: blocked,
      onClick: handleClick,
      title: jobKeys.length ? undefined : `${count} jobs have tailored artifacts from an older policy.`,
    });
  }

  return (
    <Button
      aria-describedby={ariaDescribedBy}
      aria-label={buttonLabel}
      className={className}
      disabled={blocked}
      title={jobKeys.length ? undefined : `${count} jobs have tailored artifacts from an older policy.`}
      type="button"
      onClick={handleClick}
    >
      {buttonContent}
    </Button>
  );
}
