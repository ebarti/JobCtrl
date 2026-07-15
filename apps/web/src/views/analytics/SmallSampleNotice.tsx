import { IconInfoCircle } from "@tabler/icons-react";

import { Alert, AlertDescription, AlertTitle } from "../../shared/ui/alert.js";

export interface SmallSampleNoticeProps {
  minSample?: number;
}

export function SmallSampleNotice({ minSample }: SmallSampleNoticeProps) {
  const sampleText =
    minSample === undefined
      ? "A rate appears once a group reaches the minimum sample count"
      : `A rate appears once a group has at least ${minSample} applications`;
  return (
    <Alert className="analytics-caption" aria-label="Analytics interpretation note">
      <IconInfoCircle aria-hidden="true" />
      <AlertTitle>How to read these outcomes</AlertTitle>
      <AlertDescription>
        Descriptive associations from your own recorded outcomes — not causal claims. Recorded outcomes from
        canonical rows only. {sampleText}; smaller groups show counts only. Analytics never
        enter scoring, ranking, or apply eligibility.
      </AlertDescription>
    </Alert>
  );
}
