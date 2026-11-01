import type { ReactNode } from "react";

import { ContextHelp } from "./context-help.js";

export interface SectionProps {
  title: string;
  children: ReactNode;
  help?: string;
}

export function Section({ title, children, help }: SectionProps) {
  return (
    <section className="section" data-slot="section">
      <h3 aria-label={title} data-slot="section-title">{title}{help ? <ContextHelp label={title} description={help} /> : null}</h3>
      {children}
    </section>
  );
}
