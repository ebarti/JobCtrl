export interface EmptyProps {
  title: string;
}

export function Empty({ title }: EmptyProps) {
  return <div className="empty">{title}</div>;
}
