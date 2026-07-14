import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn.js";

export interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
  ...props
}: SectionProps) {
  return (
    <section className={cn("section", className)} {...props}>
      <header className="section__header">
        <div className="section__heading">
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? <div className="section__actions">{actions}</div> : null}
      </header>
      <div className="section__body">{children}</div>
    </section>
  );
}
