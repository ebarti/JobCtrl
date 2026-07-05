export interface SmallSampleNoticeProps {
  minSample?: number;
}

export function SmallSampleNotice({ minSample }: SmallSampleNoticeProps) {
  const sampleText =
    minSample === undefined
      ? "A rate appears once a group reaches the minimum sample count"
      : `A rate appears once a group has at least ${minSample} applications`;
  return (
    <p className="analytics-caption">
      Recorded outcomes from canonical rows only. {sampleText}; smaller groups show counts only. Analytics never
      enter scoring, ranking, or apply eligibility.
    </p>
  );
}
