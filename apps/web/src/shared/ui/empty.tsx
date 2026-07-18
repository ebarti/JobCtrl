import type { ReactNode } from "react";

export interface EmptyProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}

export function Empty({ title, description, action }: EmptyProps) {
  return (
    <div className="empty" data-slot="empty">
      <span data-slot="empty-title" data-typography="component-title">
        {title}
      </span>
      {description ? (
        <p data-slot="empty-description" data-typography="body">
          {description}
        </p>
      ) : null}
      {action ? (
        <div data-slot="empty-action" data-typography="control">
          {action}
        </div>
      ) : null}
    </div>
  );
}
