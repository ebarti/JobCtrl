import { IconChevronDown, IconInfoCircle } from "@tabler/icons-react";

export interface SmallSampleNoticeProps {
  minSample?: number;
}

export function SmallSampleNotice({ minSample }: SmallSampleNoticeProps) {
  const sampleText =
    minSample === undefined
      ? "A rate appears once a group reaches the minimum sample count"
      : `A rate appears once a group has at least ${minSample} applications`;
  return (
    <details className="analytics-caption" aria-label="Analytics interpretation note">
      <summary className="analytics-caption-summary">
        <IconInfoCircle aria-hidden="true" />
        <span data-typography="strong-body">How rates are calculated</span>
        <span className="analytics-caption-summary-detail" data-typography="metadata">
          {minSample === undefined ? "Minimum sample required" : `${minSample}+ applications`}
        </span>
        <IconChevronDown className="analytics-caption-chevron" aria-hidden="true" />
      </summary>
      <p className="analytics-caption-description" data-typography="body">
        Descriptive associations from your own recorded outcomes — not causal claims. Recorded outcomes from
        canonical rows only. {sampleText}; smaller groups show counts only. Analytics never enter scoring,
        ranking, or apply eligibility.
      </p>
    </details>
  );
}
