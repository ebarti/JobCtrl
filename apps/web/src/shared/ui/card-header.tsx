import type { ReactNode } from "react";

export interface CardHeaderProps {
  title: string;
  meta?: ReactNode;
}

export function CardHeader({ title, meta }: CardHeaderProps) {
  return (
    <header className="card-hd" data-slot="legacy-card-header">
      <h2 data-slot="legacy-card-title">{title}</h2>
      {meta ? (
        <span className="meta" data-slot="legacy-card-meta">
          {meta}
        </span>
      ) : null}
    </header>
  );
}
