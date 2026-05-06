export type Direction = "asc" | "desc";

export interface DirectionSelectProps {
  value: Direction;
  onChange: (value: Direction) => void;
}

export function DirectionSelect({ value, onChange }: DirectionSelectProps) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as Direction)}>
      <option value="desc">desc</option>
      <option value="asc">asc</option>
    </select>
  );
}
