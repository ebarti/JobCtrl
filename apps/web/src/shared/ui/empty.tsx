export interface EmptyProps {
  title: string;
}

export function Empty({ title }: EmptyProps) {
  return (
    <div className="empty" data-slot="empty">
      <span data-slot="empty-title">{title}</span>
    </div>
  );
}
