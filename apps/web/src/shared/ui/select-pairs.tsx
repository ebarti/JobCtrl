export interface SelectPairsProps<T extends string> {
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange: (value: T) => void;
}

export function SelectPairs<T extends string>({
  options,
  value,
  onChange,
}: SelectPairsProps<T>) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as T)}>
      {options.map(([item, label]) => (
        <option key={item} value={item}>
          {label}
        </option>
      ))}
    </select>
  );
}
