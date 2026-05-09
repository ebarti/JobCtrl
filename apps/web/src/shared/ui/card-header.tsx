import type { ReactNode } from "react";

export interface CardHeaderProps {
  title: string;
  meta?: ReactNode;
}

export function CardHeader({ title, meta }: CardHeaderProps) {
  return (
    <header className="card-hd">
      <h2>{title}</h2>
      {meta ? <span className="meta">{meta}</span> : null}
    </header>
  );
}
