import type { ReactNode } from "react";

export interface SectionProps {
  title: string;
  children: ReactNode;
}

export function Section({ title, children }: SectionProps) {
  return (
    <section className="section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
