const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;

export interface PageSizeProps {
  value: number;
  onChange: (value: number) => void;
}

export function PageSize({ value, onChange }: PageSizeProps) {
  return (
    <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
      {PAGE_SIZE_OPTIONS.map((item) => (
        <option key={item} value={item}>
          {item}/page
        </option>
      ))}
    </select>
  );
}
