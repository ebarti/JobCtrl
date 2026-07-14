import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn.js";

export interface PreviewWorkbenchProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly status?: ReactNode;
  readonly primaryControls?: ReactNode;
  readonly secondaryControls?: ReactNode;
  readonly actions?: ReactNode;
  readonly previewLabel: string;
  readonly children: ReactNode;
}

export function PreviewWorkbench({
  title,
  description,
  status,
  primaryControls,
  secondaryControls,
  actions,
  previewLabel,
  children,
  className,
  ...props
}: PreviewWorkbenchProps) {
  return (
    <section className={cn("preview-workbench", className)} {...props}>
      <header className="preview-workbench__header">
        <div className="preview-workbench__heading">
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {status ? <div className="preview-workbench__status">{status}</div> : null}
      </header>
      {primaryControls || actions ? (
        <div className="preview-workbench__control-row" data-row="primary">
          {primaryControls ? (
            <div className="preview-workbench__controls">{primaryControls}</div>
          ) : null}
          {actions ? <div className="preview-workbench__actions">{actions}</div> : null}
        </div>
      ) : null}
      {secondaryControls ? (
        <div className="preview-workbench__control-row" data-row="secondary">
          <div className="preview-workbench__controls">{secondaryControls}</div>
        </div>
      ) : null}
      <div className="preview-workbench__document" role="region" aria-label={previewLabel}>
        {children}
      </div>
    </section>
  );
}
