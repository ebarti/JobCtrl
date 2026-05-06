export interface SegmentBarProps {
  total: number;
  values: ReadonlyArray<readonly [string, number]>;
}

export function SegmentBar({ total, values }: SegmentBarProps) {
  return (
    <span className="bar">
      {values.map(([name, value]) => (
        <span
          key={name}
          className={`seg-${name}`}
          style={{ width: `${total ? (value / total) * 100 : 0}%` }}
        />
      ))}
    </span>
  );
}
