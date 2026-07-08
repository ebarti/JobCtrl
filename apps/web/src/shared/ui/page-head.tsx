import type { JSX, ReactNode } from "react";

import { cn } from "../lib/cn.js";

export interface PageHeadProps {
  title: string;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHead({
  title,
  eyebrow,
  subtitle,
  actions,
  className,
}: PageHeadProps): JSX.Element {
  return (
    <div className={cn("page-head", className)}>
      <div className="page-head-text">
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h1>{title}</h1>
        {subtitle ? <p className="page-head-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-head-actions">{actions}</div> : null}
    </div>
  );
}
