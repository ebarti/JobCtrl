import type { ReactNode } from "react";

export interface SectionProps {
  title: string;
  children: ReactNode;
}

export function Section({ title, children }: SectionProps) {
  return (
    <section className="section" data-slot="section">
      <h3 data-slot="section-title">{title}</h3>
      {children}
    </section>
  );
}
