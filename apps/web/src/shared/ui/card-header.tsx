export interface CardHeaderProps {
  title: string;
  meta?: string;
}

export function CardHeader({ title, meta }: CardHeaderProps) {
  return (
    <header className="card-hd">
      <h2>{title}</h2>
      {meta ? <span className="meta">{meta}</span> : null}
    </header>
  );
}
